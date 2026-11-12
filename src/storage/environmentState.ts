import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';

/** The marker lives on the extension host's disk, never in client-side synced state.
 * Hostname also separates containers sharing a mounted VS Code server directory.
 * No workspace URI or connection/session ID participates in this identity. */
export class EnvironmentState {
  readonly id: string;
  readonly label: string;
  readonly ready: Promise<void>;
  private readonly seeds = new Map<string, unknown>();

  constructor(private readonly context: vscode.ExtensionContext) {
    const host = os.hostname();
    const remote = vscode.env?.remoteName ?? 'local';
    const fingerprint = createHash('sha256').update(JSON.stringify([remote, host, os.homedir(), process.platform])).digest('hex').slice(0, 24);
    const directory = path.join(context.globalStorageUri.fsPath, 'environments', fingerprint);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const marker = path.join(directory, 'identity');
    // Publish a complete file atomically; another window must never read an
    // empty marker between exclusive open and write.
    if (!fs.existsSync(marker)) {
      const candidate = marker + '.' + randomUUID();
      fs.writeFileSync(candidate, randomUUID(), { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(candidate, marker); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { fs.unlinkSync(candidate); }
    }
    this.id = fs.readFileSync(marker, 'utf8').trim();
    if (!/^[a-f0-9-]{36}$/.test(this.id)) throw new Error('Invalid environment identity marker: ' + marker);
    this.label = `${remote === 'local' ? 'Local' : remote} · ${host} · ${this.id.slice(0, 8)}`;
    if (!this.get<boolean>('migrationComplete', false)) {
      const ids = context.globalState.get<Record<string, string>>('vscodemodelswitch.currentProviderIds', {});
      const legacy = context.globalState.get<string>('vscodemodelswitch.currentProviderId');
      if (Object.keys(ids).length) this.seeds.set('vscodemodelswitch.currentProviderIds', structuredClone(ids));
      else if (legacy) {
        const providers = context.globalState.get<Array<{ id: string; tool: string }>>('vscodemodelswitch.providers', []);
        const provider = providers.find(p => p.id === legacy);
        if (provider?.tool === 'codex' || provider?.tool === 'claude') this.seeds.set('vscodemodelswitch.currentProviderIds', { [provider.tool]: legacy });
      }
      this.seeds.set('vscodemodelswitch.toolEnabled', structuredClone(context.globalState.get('vscodemodelswitch.toolEnabled', {})));
    }
    this.ready = this.migrate();
  }

  key(key: string): string { return `vscodemodelswitch.environment.${this.id}.${key}`; }
  get<T>(key: string, fallback?: T): T {
    return this.context.globalState.get<T>(this.key(key), this.seeds.has(key) ? this.seeds.get(key) as T : fallback as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    await this.ready;
    await this.context.globalState.update(this.key(key), value);
  }
  private async migrate(): Promise<void> {
    for (const [key, value] of this.seeds) {
      if (this.context.globalState.get(this.key(key)) === undefined) await this.context.globalState.update(this.key(key), value);
    }
    await this.context.globalState.update(this.key('migrationComplete'), true);
    this.seeds.clear();
  }
}
