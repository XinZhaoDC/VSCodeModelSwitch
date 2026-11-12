import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

type Snapshot = { kind: 'absent' } | { kind: 'file'; hash: string; mode: number } | { kind: 'link'; target: string } | { kind: 'directory' };
interface Change { target: string; before: Snapshot; after: Snapshot; backup?: string; retained?: string; temporary?: string }
interface Journal { version: 1; pid: number; phase: 'applying' | 'committed'; changes: Change[] }

/** A bounded, on-disk undo log. Only the operation's own unchanged output is
 * rolled back. Conversation data is never snapshotted or rewound here. */
export class FileRecovery {
  private journal: Journal = { version: 1, pid: process.pid, phase: 'applying', changes: [] };
  private constructor(readonly directory: string) {}
  static async run<T>(directory: string, action: (tx: FileRecovery) => Promise<T>): Promise<T> {
    await FileRecovery.recover(directory);
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch { throw new Error('另一个配置操作正在进行，或仍有未解决的恢复记录：' + directory); }
    const tx = new FileRecovery(directory);
    try {
      await tx.save();
      const result = await action(tx);
      tx.journal.phase = 'committed'; await tx.save();
      // A committed operation must not be reported as reverted if cleanup fails.
      await tx.cleanup().catch(() => {});
      return result;
    } catch (error) {
      try { await tx.rollback(); }
      catch { throw new Error('操作失败，回滚未完成（文件可能被其他进程修改）。恢复材料已保留：' + directory); }
      throw new Error('操作失败，已恢复到本次操作前的状态。' + (error instanceof Error ? ' ' + error.message : ''));
    }
  }
  static async recover(directory: string): Promise<string | undefined> {
    let journal: Journal;
    try { journal = JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (await fs.lstat(directory).catch(() => undefined)) throw new Error('恢复记录不完整，请保留现场并检查：' + directory);
        return;
      }
      throw new Error('无法读取恢复记录，请保留现场：' + directory);
    }
    if (journal.version !== 1 || !Array.isArray(journal.changes) || !['applying', 'committed'].includes(journal.phase)) throw new Error('恢复记录无效：' + directory);
    // Never roll back another live extension host's transaction.
    if (journal.phase !== 'committed' && alive(journal.pid)) throw new Error('配置操作尚未结束：' + directory);
    const tx = new FileRecovery(directory); tx.journal = journal;
    if (journal.phase === 'committed') { await tx.cleanup(); return '已清理上次成功操作的临时恢复数据。'; }
    try { await tx.rollback(); return '检测到上次操作意外退出，已恢复到操作前状态。'; }
    catch { throw new Error('上次操作的自动恢复未完成，检测到文件冲突。恢复材料：' + directory); }
  }
  async write(target: string, content: string): Promise<void> {
    target = path.resolve(target);
    const before = await snapshot(target);
    if (before.kind !== 'file' && before.kind !== 'absent') throw new Error('配置文件必须是普通文件：' + target);
    const change: Change = { target, before, after: { kind: 'file', hash: hash(Buffer.from(content)), mode: 0o600 }, temporary: target + '.modelswitch-' + randomUUID() };
    if (before.kind === 'file') {
      change.backup = path.join(this.directory, String(this.journal.changes.length) + '.before');
      await fs.copyFile(target, change.backup); await fs.chmod(change.backup, 0o600); await syncFile(change.backup);
    }
    this.journal.changes.push(change); await this.save();
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(change.temporary!, content, { mode: 0o600, flag: 'wx' }); await syncFile(change.temporary!);
    if (!same(await snapshot(target), before)) throw new Error('写入前配置被其他程序修改：' + target);
    await fs.rename(change.temporary!, target);
    if (!same(await snapshot(target), change.after)) throw new Error('配置写入校验失败：' + target);
  }
  async link(target: string, destination: string): Promise<void> {
    target = path.resolve(target); destination = path.resolve(destination);
    const before = await snapshot(target);
    if (before.kind === 'file') throw new Error('目录入口被普通文件占用：' + target);
    const change: Change = { target, before, after: { kind: 'link', target: destination }, temporary: target + '.modelswitch-' + randomUUID() };
    if (before.kind !== 'absent') change.retained = target + (before.kind === 'directory' ? '.before-vscodemodelswitch-' : '.previous-link-') + randomUUID();
    this.journal.changes.push(change); await this.save();
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.symlink(destination, change.temporary!, process.platform === 'win32' ? 'junction' : 'dir');
    if (!same(await snapshot(target), before)) throw new Error('切换前目录入口被其他程序修改：' + target);
    if (change.retained) {
      try { await fs.rename(target, change.retained); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBUSY') throw new Error('该目录自身是挂载点或被系统锁定，不能替换。请检查这个子目录的挂载：' + target); throw error; }
    }
    await fs.rename(change.temporary!, target);
  }
  private async rollback(): Promise<void> {
    for (const change of [...this.journal.changes].reverse()) {
      const current = await snapshot(change.target);
      if (same(current, change.before) && !(change.retained && await exists(change.retained))) continue;
      if (!same(current, change.after) && !(current.kind === 'absent' && change.retained && await exists(change.retained))) throw new Error('External modification');
      if (change.before.kind === 'file') {
        const bytes = await fs.readFile(change.backup!);
        if (hash(bytes) !== change.before.hash) throw new Error('Invalid recovery copy');
        const temp = change.target + '.restore-' + randomUUID();
        await fs.writeFile(temp, bytes, { mode: change.before.mode, flag: 'wx' }); await syncFile(temp);
        await fs.rename(temp, change.target);
      } else {
        if (current.kind !== 'absent') await fs.unlink(change.target);
        if (change.retained) await fs.rename(change.retained, change.target);
      }
    }
    await this.cleanup();
  }
  private async save(): Promise<void> {
    const temp = path.join(this.directory, 'journal.next');
    await fs.writeFile(temp, JSON.stringify(this.journal), { mode: 0o600 }); await syncFile(temp);
    await fs.rename(temp, path.join(this.directory, 'journal.json'));
  }
  private async cleanup(): Promise<void> {
    for (const change of this.journal.changes) {
      if (change.temporary) await fs.unlink(change.temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
      if (change.retained && change.before.kind === 'link') await fs.unlink(change.retained).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
      // The original directory retained at first enrollment is user data.
    }
    await fs.rm(this.directory, { recursive: true });
  }
}
async function snapshot(file: string): Promise<Snapshot> {
  const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  if (!stat) return { kind: 'absent' };
  if (stat.isSymbolicLink()) return { kind: 'link', target: path.resolve(path.dirname(file), await fs.readlink(file)) };
  if (stat.isDirectory()) return { kind: 'directory' };
  if (!stat.isFile()) throw new Error('Unsupported file: ' + file);
  return { kind: 'file', hash: hash(await fs.readFile(file)), mode: stat.mode & 0o777 };
}
function same(a: Snapshot, b: Snapshot): boolean { return a.kind === b.kind && (a.kind === 'file' ? b.kind === 'file' && a.hash === b.hash : a.kind === 'link' ? b.kind === 'link' && equalLink(a.target, b.target) : true); }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
async function exists(file: string): Promise<boolean> { return Boolean(await fs.lstat(file).catch(() => undefined)); }
async function syncFile(file: string): Promise<void> { const handle = await fs.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
function alive(pid: number): boolean { if (!Number.isSafeInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }

function equalLink(a: string, b: string): boolean {
  if (process.platform !== 'win32') return a === b;
  // Node may report a junction using the Windows namespace prefix.
  const prefix = String.fromCharCode(92, 92, 63, 92);
  const normalize = (value: string) => (value.startsWith(prefix) ? value.slice(4) : value).toLowerCase();
  return normalize(a) === normalize(b);
}
