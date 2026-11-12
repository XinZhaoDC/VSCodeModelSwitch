import * as fs from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { directorySize } from '../config/atomicWrite';

export interface HistoryBackup { directory: string; name: string; createdAt: string; bytes: number; complete: boolean; stamp: string }
/** Enumerate only our direct, real snapshot directories. Invalid/incomplete
 * manifests are visible but never followed outside the selected backup root. */
export async function historyBackups(parent: string): Promise<HistoryBackup[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return []; });
  const result: HistoryBackup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^codex-history-[a-f0-9-]{36}$/.test(entry.name)) continue;
    const directory = join(parent, entry.name), stat = await fs.lstat(directory);
    let text = '', manifest: any;
    try { text = await fs.readFile(join(directory, 'manifest.json'), 'utf8'); manifest = JSON.parse(text); } catch { /* Failed snapshots remain manageable. */ }
    const complete = manifest?.version === 1 && Array.isArray(manifest.files) && typeof manifest.createdAt === 'string';
    result.push({ directory, name: complete ? String(manifest.name || 'History') : entry.name, createdAt: complete ? manifest.createdAt : stat.mtime.toISOString(), bytes: await directorySize(directory), complete,
      stamp: createHash('sha256').update(JSON.stringify([stat.dev, stat.ino, stat.mtimeMs, text])).digest('hex') });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function removeHistoryBackup(parent: string, selected: HistoryBackup): Promise<void> {
  const current = (await historyBackups(parent)).find(item => resolve(item.directory) === resolve(selected.directory));
  if (!current || current.stamp !== selected.stamp) throw new Error('备份目录已变化，请重新选择后删除。');
  const stat = await fs.lstat(current.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份入口异常，不会删除。');
  await fs.rm(current.directory, { recursive: true });
}
