import * as vscode from 'vscode';
import { NetworkProxyConfig, NetworkProxyTest, normalizeNetworkProxy, proxyEnvironment, setNetworkProxy } from './transport';

const STATE = 'vscodemodelswitch.networkProxy';
const BACKUP = 'vscodemodelswitch.networkProxy.backup';
const ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
type EnvEntry = { name: string; value: string };
interface Field { section: string; key: string; before?: unknown; applied?: unknown }
interface Backup { fields: Field[]; claudeBefore: EnvEntry[]; claudeApplied: EnvEntry[]; claudeWasUnset: boolean }
export interface NetworkProxyState { config?: NetworkProxyConfig; message?: string; test?: NetworkProxyTest }

/** Network settings belong to this editor environment, never to a portable API Provider. */
export class NetworkProxyManager {
  private config?: NetworkProxyConfig;
  private message?: string;
  private test?: NetworkProxyTest;
  private readonly previousNoProxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  private installedNoProxy?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.globalState.get<NetworkProxyConfig>(STATE);
    if (saved) {
      this.config = normalizeNetworkProxy(saved);
      this.installTransport(this.config);
      this.message = 'Enabled for new requests. Restart existing Claude/Codex clients after changing settings.';
    }
  }

  state(): NetworkProxyState { return { config: this.config, message: this.message, test: this.test }; }
  environment(tool: 'claude' | 'codex'): Record<string, string> {
    return proxyEnvironment(this.config?.[tool] ? this.config : undefined);
  }

  private installTransport(config?: NetworkProxyConfig): void {
    setNetworkProxy(config);
    if (config) {
      // Codex's installed launcher forwards http.proxy plus process.env, but not
      // VS Code's http.noProxy setting. Supply bypass to its future child process.
      process.env.NO_PROXY = process.env.no_proxy = config.noProxy;
      this.installedNoProxy = config.noProxy;
    } else {
      for (const name of ['NO_PROXY', 'no_proxy'] as const) {
        if (process.env[name] !== this.installedNoProxy) continue;
        const previous = this.previousNoProxy[name];
        if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
      }
      this.installedNoProxy = undefined;
    }
  }

  async apply(input: NetworkProxyConfig): Promise<void> {
    const config = normalizeNetworkProxy(input);
    // SecretStorage protects any pre-existing authenticated proxy URL. Never
    // back up unrelated Claude environment variables or full account settings.
    const stored = await this.context.secrets.get(BACKUP);
    const backup: Backup = stored ? JSON.parse(stored) : { fields: [], claudeBefore: [], claudeApplied: [], claudeWasUnset: true };
    const prior = structuredClone(backup);
    const previousConfig = this.config;
    const undo: Array<() => Thenable<void>> = [];
    try {
      const http = vscode.workspace.getConfiguration('http');
      const field = backup.fields.find(item => item.section === 'http' && item.key === 'proxy');
      if (config.codex) {
        const before = http.inspect<string>('proxy')?.globalValue;
        if (field && http.get('proxy') !== field.applied) throw new Error('VS Code HTTP proxy changed outside VSModelSwitch; restore/review it first');
        if (!field) backup.fields.push({ section: 'http', key: 'proxy', before });
        const owned = backup.fields.find(item => item.key === 'proxy')!;
        owned.applied = config.url;
        undo.push(() => http.update('proxy', before, vscode.ConfigurationTarget.Global));
        await http.update('proxy', config.url, vscode.ConfigurationTarget.Global);
        // getConfiguration().get() retains its original snapshot after update().
        if (vscode.workspace.getConfiguration('http').get('proxy') !== config.url) throw new Error('A workspace or policy overrides HTTP proxy; adjust that override before applying');
      } else if (field) {
        if (http.get('proxy') !== field.applied) throw new Error('VS Code HTTP proxy changed outside VSModelSwitch');
        const current = http.inspect('proxy')?.globalValue;
        undo.push(() => http.update('proxy', current, vscode.ConfigurationTarget.Global));
        await http.update('proxy', field.before, vscode.ConfigurationTarget.Global);
        backup.fields = [];
      }

      const claude = vscode.workspace.getConfiguration('claudeCode');
      const entries = claude.get<EnvEntry[]>('environmentVariables', []);
      const explicit = claude.inspect<EnvEntry[]>('environmentVariables')?.globalValue;
      if (backup.claudeApplied.length) {
        const managed = entries.filter(item => ENV_NAMES.includes(item.name));
        if (JSON.stringify(managed) !== JSON.stringify(backup.claudeApplied)) throw new Error('Claude proxy variables changed outside VSModelSwitch; review them before applying');
      }
      if (config.claude) {
        if (!backup.claudeApplied.length) {
          backup.claudeBefore = entries.filter(item => ENV_NAMES.includes(item.name));
          backup.claudeWasUnset = explicit === undefined;
        }
        const managed = Object.entries(proxyEnvironment(config)).map(([name, value]) => ({ name, value }));
        undo.push(() => claude.update('environmentVariables', explicit, vscode.ConfigurationTarget.Global));
        await claude.update('environmentVariables', [...entries.filter(item => !ENV_NAMES.includes(item.name)), ...managed], vscode.ConfigurationTarget.Global);
        const effective = vscode.workspace.getConfiguration('claudeCode').get<EnvEntry[]>('environmentVariables', []).filter(item => ENV_NAMES.includes(item.name));
        if (JSON.stringify(effective) !== JSON.stringify(managed)) throw new Error('A workspace or policy overrides Claude environment variables');
        backup.claudeApplied = managed;
      } else if (backup.claudeApplied.length) {
        const restored = [...entries.filter(item => !ENV_NAMES.includes(item.name)), ...backup.claudeBefore];
        undo.push(() => claude.update('environmentVariables', explicit, vscode.ConfigurationTarget.Global));
        await claude.update('environmentVariables', backup.claudeWasUnset && !restored.length ? undefined : restored, vscode.ConfigurationTarget.Global);
        backup.claudeApplied = []; backup.claudeBefore = [];
      }

      await this.context.secrets.store(BACKUP, JSON.stringify(backup));
      await this.context.globalState.update(STATE, config);
      this.config = config; this.test = undefined;
      this.installTransport(config);
      this.message = 'Configured — restart Claude Code/Codex or reload this window before switching off TUN. Other extensions using VS Code HTTP proxy may also be affected.';
    } catch (error) {
      for (const revert of undo.reverse()) await revert().then(undefined, () => {});
      if (stored) await this.context.secrets.store(BACKUP, JSON.stringify(prior));
      else await this.context.secrets.delete(BACKUP);
      await this.context.globalState.update(STATE, previousConfig);
      throw error;
    }
  }

  async restore(): Promise<void> {
    const stored = await this.context.secrets.get(BACKUP);
    if (!stored) throw new Error('No network proxy settings owned by VSModelSwitch to restore');
    const backup: Backup = JSON.parse(stored);
    const http = vscode.workspace.getConfiguration('http');
    const claude = vscode.workspace.getConfiguration('claudeCode');
    const entries = claude.get<EnvEntry[]>('environmentVariables', []);
    for (const field of backup.fields) {
      if (http.get(field.key) !== field.applied) throw new Error('VS Code HTTP proxy changed outside VSModelSwitch; nothing restored');
    }
    if (backup.claudeApplied.length && JSON.stringify(entries.filter(item => ENV_NAMES.includes(item.name))) !== JSON.stringify(backup.claudeApplied)) {
      throw new Error('Claude proxy variables changed outside VSModelSwitch; nothing restored');
    }
    const undo: Array<() => Thenable<void>> = [];
    try {
      for (const field of backup.fields) {
        const current = http.inspect(field.key)?.globalValue;
        undo.push(() => http.update(field.key, current, vscode.ConfigurationTarget.Global));
        await http.update(field.key, field.before, vscode.ConfigurationTarget.Global);
      }
      if (backup.claudeApplied.length) {
        const current = claude.inspect('environmentVariables')?.globalValue;
        const restored = [...entries.filter(item => !ENV_NAMES.includes(item.name)), ...backup.claudeBefore];
        undo.push(() => claude.update('environmentVariables', current, vscode.ConfigurationTarget.Global));
        await claude.update('environmentVariables', backup.claudeWasUnset && !restored.length ? undefined : restored, vscode.ConfigurationTarget.Global);
      }
      await this.context.globalState.update(STATE, undefined);
      await this.context.secrets.delete(BACKUP);
    } catch (error) {
      for (const revert of undo.reverse()) await revert().then(undefined, () => {});
      await this.context.globalState.update(STATE, this.config);
      await this.context.secrets.store(BACKUP, stored);
      throw error;
    }
    this.config = undefined; this.test = undefined;
    this.installTransport();
    this.message = 'Original proxy settings restored. Restart existing clients or reload this window.';
  }

  setTest(test: NetworkProxyTest): void { this.test = test; }
  dispose(): void { this.installTransport(); }
}
