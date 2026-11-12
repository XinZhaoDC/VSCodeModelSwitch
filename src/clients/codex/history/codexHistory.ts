import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { CodexProfiles, IdentityKind } from './codexProfiles';

export interface SessionSummary { file: string; id: string; title: string; cwd: string; updatedAt: string; archived: boolean; provider: string }
interface BackupManifest { version: 1; kind: IdentityKind; name: string; createdAt: string; files: Array<{ file: string; sha256: string }> }

export async function listSessions(home: string): Promise<SessionSummary[]> {
  const files = await historyFiles(home); const result: SessionSummary[] = [];
  for (const file of files.filter(f => /\.jsonl$/.test(f) && /^(sessions|archived_sessions)\//.test(f))) {
    let id = '', cwd = '', title = '', provider = '';
    for await (const row of rows(path.join(home, file))) {
      const p = row.payload ?? {};
      if (row.type === 'session_meta') { id = String(p.id ?? ''); cwd = String(p.cwd ?? ''); provider = String(p.model_provider ?? ''); }
      if (row.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') { title = p.message; break; }
      if (row.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        title = textContent(p.content); if (title && !title.startsWith('<')) break;
      }
    }
    if (!id) continue;
    const stat = await fs.stat(path.join(home, file));
    result.push({ file, id, title: (title || id).replace(/\s+/g, ' ').slice(0, 140), cwd, provider, updatedAt: stat.mtime.toISOString(), archived: file.startsWith('archived_sessions/') });
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function sessionMarkdown(home: string, file: string): Promise<string> {
  if (!/^(sessions|archived_sessions)\/.+\.jsonl$/.test(file) || !safeRelative(file)) throw new Error('Invalid session path');
  await assertRegular(home, file);
  const messages: string[] = []; let meta = '';
  // response_item is the persisted message stream; event_msg duplicates it.
  for await (const row of rows(path.join(home, file))) {
    const p = row.payload ?? {};
    if (row.type === 'session_meta') meta = `Session: ${String(p.id ?? '')}\n\nProject: ${String(p.cwd ?? '')}\n\n`;
    if (row.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const text = textContent(p.content); if (text) messages.push(`## ${p.role === 'user' ? 'User' : 'Assistant'}\n\n${text}`);
    }
  }
  return '# Codex conversation\n\n' + meta + messages.join('\n\n') + '\n';
}

/** Backups contain resumable conversation data, never auth/config/skills.
 * Caller must close all writers first; before/after hashes detect a changing input. */
export async function backupHistory(home: string, parent: string, kind: IdentityKind, name: string): Promise<string> {
  const relative = path.relative(path.resolve(home), path.resolve(parent));
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Backup destination must be outside the Codex home');
  const files = await historyFiles(home), before = await fingerprints(home, files);
  const target = path.join(parent, 'codex-history-' + randomUUID());
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of files) {
    await assertRegular(home, file); await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(home, file), path.join(target, file)); await fs.chmod(path.join(target, file), 0o600);
  }
  if (JSON.stringify(before) !== JSON.stringify(await fingerprints(home, await historyFiles(home))) || JSON.stringify(before) !== JSON.stringify(await fingerprints(target, files))) throw new Error('History changed during backup. Incomplete folder retained; close all Codex clients and retry.');
  const manifest: BackupManifest = { version: 1, kind, name, createdAt: new Date().toISOString(), files: before };
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return target;
}

export async function restoreHistory(profiles: CodexProfiles, backup: string): Promise<string> {
  const m = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8')) as BackupManifest;
  if (m.version !== 1 || !['official', 'api'].includes(m.kind) || !Array.isArray(m.files) || new Set(m.files.map(f => f.file)).size !== m.files.length) throw new Error('Invalid history backup');
  for (const f of m.files) {
    if (!safeRelative(f.file) || !isHistoryFile(f.file) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('Backup contains a non-history file');
    await assertRegular(backup, f.file);
  }
  if (JSON.stringify(m.files) !== JSON.stringify(await fingerprints(backup, m.files.map(f => f.file)))) throw new Error('History backup checksum mismatch');
  const identity = await profiles.importHistory(m.kind, (m.name || 'Account') + ' (restored)', async home => {
    // This is a new, unpublished home; its previous home is retained intact.
    for (const file of await historyFiles(home)) await fs.unlink(path.join(home, file));
    for (const f of m.files) {
      const target = path.join(home, restorePath(f.file)); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(path.join(backup, f.file), target); await fs.chmod(target, 0o600);
    }
    if (JSON.stringify(m.files.map(f => ({ ...f, file: restorePath(f.file) }))) !== JSON.stringify(await fingerprints(home, m.files.map(f => restorePath(f.file))))) throw new Error('Restored history checksum mismatch');
  });
  return identity.id;
}

async function* rows(file: string): AsyncGenerator<any> {
  const input = createReadStream(file, { encoding: 'utf8' }); const reader = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) { try { yield JSON.parse(line); } catch { /* A live final line may be incomplete. */ } } }
  finally { reader.close(); input.destroy(); }
}
function textContent(content: unknown): string {
  return Array.isArray(content) ? content.filter(p => ['input_text', 'output_text', 'text'].includes(p?.type) && typeof p.text === 'string').map(p => p.text).join('\n') : '';
}
function safeRelative(file: string): boolean { return typeof file === 'string' && !file.includes('\\') && !path.isAbsolute(file) && file.split('/').every(p => p && p !== '.' && p !== '..'); }
function isHistoryFile(file: string): boolean {
  return /^(sessions|archived_sessions)\/.+\.jsonl$/.test(file) || /^(history|session_index)\.jsonl$/.test(file) || /^(?:sqlite\/)?[a-zA-Z0-9_-]+\.sqlite(?:-(?:wal|shm))?$/.test(file);
}
async function historyFiles(home: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    const entries = await fs.readdir(path.join(home, directory), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    for (const e of entries) {
      const file = directory ? directory + '/' + e.name : e.name;
      if (e.isDirectory() && (/^(sessions|archived_sessions|sqlite)$/.test(file) || directory)) await walk(file);
      else if (e.isFile() && isHistoryFile(file)) files.push(file);
    }
  };
  await walk(''); return files.sort();
}
async function assertRegular(root: string, file: string): Promise<void> {
  let current = root;
  for (const segment of file.split('/')) { current = path.join(current, segment); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('History cannot follow symbolic links'); }
  if (!(await fs.stat(current)).isFile()) throw new Error('History entry is not a regular file');
}
async function fingerprints(root: string, files: string[]): Promise<BackupManifest['files']> {
  const result: BackupManifest['files'] = [];
  for (const file of files) { await assertRegular(root, file); const hash = createHash('sha256'); for await (const chunk of createReadStream(path.join(root, file))) hash.update(chunk); result.push({ file, sha256: hash.digest('hex') }); }
  return result;
}

function restorePath(file: string): string { return /^[^/]+\.sqlite(?:-(?:wal|shm))?$/.test(file) ? 'sqlite/' + file : file; }
