import * as fs from 'fs/promises';
import { join, resolve } from 'path';
import { randomUUID, createHash } from 'crypto';

export type OperationStatus = 'started' | 'succeeded' | 'failed' | 'cancelled';
export interface OperationEvent {
  id: string; action: string; status: OperationStatus; target?: string;
  durationMs?: number; reason?: string; code?: string; recovery?: 'restored' | 'manual' | 'unchanged';
  source?: string;
  httpStatus?: number; latencyMs?: number;
}
const owned = /^operations-[a-zA-Z0-9-]+\.jsonl$/;

/** Only allowlisted operation metadata is persisted. Never serialize a webview
 * request, a diagnostic response, configuration text, or a caught error body. */
export class OperationLog {
  private queue: Promise<unknown> = Promise.resolve();
  private part = 0;
  private readonly instance = process.pid + '-' + randomUUID();
  private wrote = false;
  private location: string;
  constructor(directory: string, readonly environment: string, readonly version: string,
    private readonly persist: (directory: string) => Promise<void> = async () => {},
    private readonly limits = { fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 }) {
    this.location = resolve(directory);
  }
  get directory(): string { return this.location; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next;
  }
  async write(event: OperationEvent): Promise<void> {
    return this.serial(async () => {
      await fs.mkdir(this.location, { recursive: true, mode: 0o700 });
      const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,180}$/.test(value) ? value : undefined;
      const line = JSON.stringify({ time: new Date().toISOString(), version: this.version, environment: this.environment,
        id: token(event.id), action: token(event.action), status: event.status, target: token(event.target),
        durationMs: Number.isFinite(event.durationMs) ? event.durationMs : undefined,
        httpStatus: Number.isFinite(event.httpStatus) ? event.httpStatus : undefined,
        latencyMs: Number.isFinite(event.latencyMs) ? event.latencyMs : undefined,
        reason: token(event.reason), code: token(event.code), source: token(event.source), recovery: event.recovery }) + '\n';
      let file = this.file();
      const existing = await fs.stat(file).catch(() => undefined);
      // Another window may have moved/rotated our old file. Start a distinct
      // part rather than recreating that filename with an unrelated suffix.
      if (!existing && this.wrote || (existing?.size ?? 0) + Buffer.byteLength(line) > this.limits.fileBytes) { this.part++; file = this.file(); }
      await fs.appendFile(file, line, { mode: 0o600 });
      this.wrote = true;
      await this.trim(file);
    });
  }
  private file(): string { return join(this.location, `operations-${this.instance}-${this.part}.jsonl`); }
  private async files(directory = this.location): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return []; });
    return entries.filter(e => e.isFile() && owned.test(e.name)).map(e => e.name);
  }
  private async trim(current: string): Promise<void> {
    const entries = await Promise.all((await this.files()).map(async name => ({ file: join(this.location, name), stat: await fs.stat(join(this.location, name)).catch(() => undefined) })));
    const sorted = entries.filter(e => e.stat).sort((a, b) => a.stat!.mtimeMs - b.stat!.mtimeMs);
    let size = sorted.reduce((n, e) => n + e.stat!.size, 0);
    for (const e of sorted) {
      if (size <= this.limits.totalBytes) break;
      if (e.file === current) continue;
      await fs.unlink(e.file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); size -= e.stat!.size;
    }
  }
  /** Publish the verified destination before removing any source. Interrupted
   * migrations can leave duplicates, never a missing only copy. */
  async move(directory: string): Promise<void> {
    return this.serial(async () => {
      const target = resolve(directory), source = this.location;
      if (target === source) return;
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.mkdir(source, { recursive: true, mode: 0o700 });
      if (await fs.realpath(target) === await fs.realpath(source)) return;
      const snapshots: Array<{ name: string; bytes: Buffer }> = [];
      for (const name of await this.files(source)) {
        const bytes = await fs.readFile(join(source, name));
        const destination = join(target, name), temporary = destination + '.copy-' + randomUUID();
        try {
          await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          if (!equal(bytes, await fs.readFile(temporary))) throw new Error('日志复制校验失败，原日志保留：' + source);
          try { await fs.link(temporary, destination); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const existing = await fs.readFile(destination);
            // A second window may append before it learns the new location.
            // Reconcile only append-only prefixes, never unrelated contents.
            if (bytes.length > existing.length && bytes.subarray(0, existing.length).equals(existing)) {
              if (!equal(existing, await fs.readFile(destination))) throw new Error('日志目标正在更改，请刷新后重试。');
              await fs.rename(temporary, destination);
            } else if (!existing.subarray(0, bytes.length).equals(bytes)) throw new Error('日志搬迁校验失败，原日志保留：' + source);
          }
        } finally { await fs.unlink(temporary).catch(() => {}); }
        const verified = await fs.readFile(destination);
        if (!verified.subarray(0, bytes.length).equals(bytes)) throw new Error('日志搬迁校验失败，原日志保留：' + source);
        snapshots.push({ name, bytes });
      }
      await this.persist(target);
      this.location = target; this.part++;
      for (const { name, bytes } of snapshots) {
        // Another window may still append to the old location until refreshed.
        // Keep changed sources rather than destroying their newer records.
        const pid = /^operations-(\d+)-/.exec(name)?.[1];
        if (!name.startsWith('operations-' + this.instance + '-') && pid && alive(Number(pid))) continue;
        const current = await fs.readFile(join(source, name)).catch(() => undefined);
        if (current && equal(bytes, current)) await fs.unlink(join(source, name)).catch(() => {});
      }
    });
  }
  async clear(): Promise<number> {
    return this.serial(async () => {
      const files = await this.files();
      for (const name of files) await fs.unlink(join(this.location, name));
      this.part++; return files.length;
    });
  }
  async text(): Promise<string> {
    return this.serial(async () => (await Promise.all((await this.files()).sort().map(name => fs.readFile(join(this.location, name), 'utf8')))).join(''));
  }
}
function equal(a: Buffer, b: Buffer): boolean { return createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex'); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }

/** Stable diagnostics without accidentally recording server response bodies. */
export function operationFailure(error: unknown): Pick<OperationEvent, 'reason' | 'code' | 'recovery' | 'source'> {
  const text = error instanceof Error ? error.message : '';
  const raw = (error as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(raw) ? raw : undefined;
  const recovery = /回滚未完成|自动恢复未完成|恢复记录不完整/.test(text) ? 'manual' : /已恢复到本次操作前/.test(text) ? 'restored' : undefined;
  const reason = recovery === 'manual' ? 'recovery_conflict' : recovery === 'restored' ? 'operation_rolled_back'
    : /已取消|cancelled|canceled/i.test(text) ? 'cancelled' : /key.*missing|API key|密钥/i.test(text) ? 'key_missing'
    : /ENOENT|not found|不存在/i.test(text) ? 'not_found' : /EACCES|EPERM|permission denied/i.test(text) ? 'permission_denied'
    : /timeout|timed out|超时/i.test(text) ? 'timeout' : /network|connect|ENOTFOUND|ECONN/i.test(text) ? 'connection_failed'
    : /config|配置|JSON|URL|model|模型/i.test(text) ? 'configuration_error' : 'operation_failed';
  const source = error instanceof Error ? error.stack?.split('\n').slice(1).map(line => line.match(/[\\/](out|src)[\\/][a-zA-Z0-9_./\\-]+\.(?:js|ts):\d+:\d+/)?.[0].replace(/\\/g, '/')).find(Boolean) : undefined;
  return { code, reason, recovery, source };
}
