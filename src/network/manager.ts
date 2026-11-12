import { randomUUID } from 'crypto';
import { EnvironmentState } from '../storage/environmentState';
import { ToolId } from '../types';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { join } from 'path';
import { FileRecovery } from '../config/recovery';
import { getToolHome } from '../utils/paths';
import { CODEX_DISPATCH, writeCodexDispatcher } from './codexLauncher';
import { NetworkProxyConfig, NetworkProxyTest, normalizeNetworkProxy, proxyEnvironment, setNetworkProxy } from './transport';

const STATE = 'vscodemodelswitch.networkProxy', BACKUP = 'vscodemodelswitch.networkProxy.backup';
export const PROXY_ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'];
type Entry = { name: string; value: string };
interface Field { section: string; key: string; before?: unknown; applied?: unknown }
interface SettingRecovery { id: string; pid: number; failed?: boolean; beforeState?: unknown; beforeBackup?: string; settings: Array<{ section: string; key: string; before?: unknown; after?: unknown }> }
interface Backup {
  fields: Field[]; claudeBefore: Entry[]; claudeApplied: Entry[]; claudeWasUnset: boolean;
  claudeFile?: { path: string; before: Record<string, unknown>; applied: Record<string, string> };
}
export interface NetworkProxyState { config?: NetworkProxyConfig; message?: string; test?: NetworkProxyTest; tools?: Partial<Record<ToolId, { config?: NetworkProxyConfig; message?: string; test?: NetworkProxyTest; managed?: boolean; error?: boolean }>> }

/** Never mutate process.env or install a new VS Code http.proxy value.
 * Old owned fields are restored only on an explicit user operation. */
export class NetworkProxyManager {
  private configs: Partial<Record<ToolId, NetworkProxyConfig>> = {};
  private tests: Partial<Record<ToolId, NetworkProxyTest>> = {};
  private messages: Partial<Record<ToolId, string>> = {};
  private version = 3;
  private readonly errors = new Set<ToolId>();
  private readonly managed = new Set<ToolId>();
  readonly ready: Promise<void>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly environmentState = new EnvironmentState(context)) {
    this.loadSaved();
    this.installTransport(); this.ready = this.initialize();
  }
  private loadSaved(): void {
    this.configs = {}; this.managed.clear();
    const saved = this.environmentState.get<NetworkProxyConfig | { version: number; tools: Partial<Record<ToolId, NetworkProxyConfig>>; managedTools?: ToolId[] }>(STATE);
    if (saved) {
      if ('version' in saved) { this.configs = saved.tools; this.version = saved.version; for (const tool of saved.managedTools ?? (saved.version >= 3 ? Object.keys(saved.tools) as ToolId[] : [])) this.managed.add(tool); }
      else { const c = normalizeNetworkProxy(saved); if (c.claude) this.configs.claude = c; if (c.codex) this.configs.codex = c; this.version = 1; }
    }
  }
  private directory(tool: ToolId): string { return join(this.context.globalStorageUri.fsPath, 'environments', this.environmentState.id, 'network-recovery-' + tool); }
  private async initialize(): Promise<void> {
    await this.environmentState.ready;
    for (const tool of ['claude', 'codex'] as ToolId[]) {
      try {
        await FileRecovery.recover(this.directory(tool));
        await this.recoverSettings(tool);
        this.loadSaved();
        // A saved route alone cannot prove the native extension uses it. The
        // application-scoped registration may have been removed or overridden.
        if (tool === 'codex' && this.managed.has(tool) && this.configs[tool] && vscode.workspace.getConfiguration('chatgpt').get('cliExecutable') !== CODEX_DISPATCH) {
          this.errors.add(tool); this.messages[tool] = 'Codex 网络启动入口核查异常：独立启动命令未注册或已被覆盖，请核对后重新应用网络设置。';
          continue;
        }
        if (tool === 'codex' && vscode.workspace.getConfiguration('chatgpt').get('cliExecutable') === CODEX_DISPATCH) {
          await FileRecovery.run(this.directory(tool), tx => writeCodexDispatcher(tx, this.managed.has('codex') ? this.configs.codex : undefined, true));
        }
        if (tool === 'claude' && this.managed.has(tool)) {
          const raw = await this.context.secrets.get(this.environmentState.key(BACKUP));
          const owned = raw ? (JSON.parse(raw) as Backup).claudeFile : undefined;
          if (owned && !same(pick(object((await jsonObject(owned.path)).env)), owned.applied)) throw new Error('Claude 网络配置存在外部改动');
        }
        this.errors.delete(tool);
        this.messages[tool] = this.configs[tool] && !this.managed.has(tool) ? '旧版代理配置尚未迁入独立启动方式；请重新应用或停用恢复。' : '本地配置已核查；实际聊天路由需在客户端验证。';
      } catch { this.errors.add(tool); this.messages[tool] = '网络启动入口或恢复记录异常，请检查挂载、权限和官方扩展版本后重试。'; }
    }
    this.installTransport();
  }
  private recoveryKey(tool: ToolId): string { return this.environmentState.key(BACKUP + '.pending.' + tool); }
  private marker(tool: ToolId): string { return this.directory(tool) + '.commit.json'; }
  private async recoverSettings(tool: ToolId): Promise<void> {
    const key = this.recoveryKey(tool), raw = await this.context.secrets.get(key); if (!raw) return;
    const pending: SettingRecovery = JSON.parse(raw);
    const marker = await jsonObject(this.marker(tool));
    if (marker.id !== pending.id) {
      if (!pending.failed) { try { process.kill(pending.pid, 0); throw new Error('网络配置操作仍在运行'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
      for (const field of [...pending.settings].reverse()) {
        const section = vscode.workspace.getConfiguration(field.section), current = ownValue(section, field.key);
        if (same(current, field.before)) continue;
        if (!same(current, field.after)) throw new Error('网络恢复遇到外部设置冲突');
        await section.update(field.key, field.before, vscode.ConfigurationTarget.Global);
        if (!same(ownValue(vscode.workspace.getConfiguration(field.section), field.key), field.before)) throw new Error('网络设置恢复校验失败');
      }
      await this.environmentState.update(STATE, pending.beforeState);
      if (pending.beforeBackup) await this.context.secrets.store(this.environmentState.key(BACKUP), pending.beforeBackup); else await this.context.secrets.delete(this.environmentState.key(BACKUP));
    }
    await this.context.secrets.delete(key);
  }
  async refresh(): Promise<void> { await this.ready; await this.initialize(); }
  state(): NetworkProxyState {
    return { config: this.configs.codex ?? this.configs.claude, tools: Object.fromEntries((['claude', 'codex'] as ToolId[]).map(tool => [tool, {
      config: this.configs[tool], error: this.errors.has(tool), managed: Boolean(this.configs[tool]) && this.managed.has(tool), message: this.messages[tool], test: this.tests[tool]
    }])) };
  }
  environment(tool: ToolId): Record<string, string> { return this.configs[tool] ? this.envFor(this.configs[tool]!) : {}; }
  private installTransport(): void { setNetworkProxy(undefined); for (const tool of ['claude', 'codex'] as ToolId[]) setNetworkProxy(this.configs[tool], tool); }
  async apply(input: NetworkProxyConfig, tool?: ToolId): Promise<void> {
    await this.ready;
    if (!tool) throw new Error('请分别在对应工具页面应用网络设置。');
    const config = normalizeNetworkProxy(input);
    await this.change(tool, { ...config, claude: tool === 'claude', codex: tool === 'codex' });
  }
  async restore(tool?: ToolId): Promise<void> {
    await this.ready;
    if (!tool) throw new Error('请分别停用对应工具的网络设置。');
    if (!this.configs[tool]) throw new Error('当前工具尚未启用受管代理。');
    await this.change(tool);
  }
  private async change(tool: ToolId, config?: NetworkProxyConfig): Promise<void> {
    const key = this.environmentState.key(BACKUP), stored = await this.context.secrets.get(key);
    const backup: Backup = stored ? JSON.parse(stored) : { fields: [], claudeBefore: [], claudeApplied: [], claudeWasUnset: true };
    const next = { ...this.configs }; if (config) next[tool] = config; else delete next[tool];
    const undo: Array<() => PromiseLike<void>> = [], previous = this.environmentState.get(STATE);
    const pending: SettingRecovery = { id: randomUUID(), pid: process.pid, beforeState: previous, beforeBackup: stored, settings: [] };
    const pendingKey = this.recoveryKey(tool);
    if (await this.context.secrets.get(pendingKey)) throw new Error('存在未解决的网络恢复记录，请先重新加载并检查状态。');
    await this.context.secrets.store(pendingKey, JSON.stringify(pending));
    const updateSetting = async (sectionName: string, name: string, after: unknown) => {
      const section = vscode.workspace.getConfiguration(sectionName), before = ownValue(section, name);
      pending.settings.push({ section: sectionName, key: name, before, after }); await this.context.secrets.store(pendingKey, JSON.stringify(pending));
      undo.push(async () => { const current = ownValue(vscode.workspace.getConfiguration(sectionName), name); if (!same(current, before) && !same(current, after)) throw new Error('外部改动'); await vscode.workspace.getConfiguration(sectionName).update(name, before, vscode.ConfigurationTarget.Global); if (!same(ownValue(vscode.workspace.getConfiguration(sectionName), name), before)) throw new Error('恢复校验失败'); });
      await section.update(name, after, vscode.ConfigurationTarget.Global);
    };
    try {
      await FileRecovery.run(this.directory(tool), async tx => {
        if (tool === 'claude') {
          const file = join(getToolHome('claude'), 'settings.json'), settings = await jsonObject(file);
          const env = object(settings.env), owned = backup.claudeFile;
          if (owned && (owned.path !== file || !same(pick(env), owned.applied))) throw new Error('Claude 代理字段已在外部更改，请先核对，不会覆盖。');
          if (config) {
            const applied = this.envFor(config);
            backup.claudeFile = { path: file, before: owned?.before ?? pick(env), applied };
            settings.env = { ...env, ...applied };
          } else if (owned) { settings.env = { ...omit(env), ...owned.before }; delete backup.claudeFile; }
          await tx.write(file, JSON.stringify(settings, null, 2) + '\n');
          if (!same(pick(object((await jsonObject(file)).env)), pick(object(settings.env)))) throw new Error('Claude 配置写入校验失败。');
          const section = vscode.workspace.getConfiguration('claudeCode');
          const entries = section.get<Entry[]>('environmentVariables', []), before = ownValue(section, 'environmentVariables');
          if (backup.claudeApplied.length && !same(entries.filter(e => PROXY_ENV_NAMES.includes(e.name)), backup.claudeApplied)) throw new Error('旧版 Claude 插件代理变量已被外部更改。');
          if (config && !backup.claudeApplied.length) { backup.claudeBefore = entries.filter(e => PROXY_ENV_NAMES.includes(e.name)); backup.claudeWasUnset = before === undefined; }
          const managed = config ? Object.entries(this.envFor(config)).map(([name, value]) => ({ name, value })) : backup.claudeBefore;
          const updated = [...entries.filter(e => !PROXY_ENV_NAMES.includes(e.name)), ...managed];
          await updateSetting('claudeCode', 'environmentVariables', !config && backup.claudeWasUnset && !updated.length ? undefined : updated);
          if (!same(vscode.workspace.getConfiguration('claudeCode').get<Entry[]>('environmentVariables', []).filter(e => PROXY_ENV_NAMES.includes(e.name)), managed)) throw new Error('工作区或策略覆盖了 Claude 代理变量。');
          backup.claudeApplied = config ? managed : []; if (!config) backup.claudeBefore = [];
        } else {
          const chatgpt = vscode.workspace.getConfiguration('chatgpt'), current = chatgpt.get<string | null>('cliExecutable');
          if (config) {
            if (current && current !== CODEX_DISPATCH) throw new Error('Codex 已有自定义启动程序，请先确认并恢复官方默认入口。');
            await writeCodexDispatcher(tx, config);
            if (current !== CODEX_DISPATCH) {
              const answer = await vscode.window.showWarningMessage('Codex 独立路由使用实验性公共启动命令。每个 Linux 环境由 AgentDeck 准备自己的入口；同一 VS Code 客户端的 Windows/WSL 原生窗口尚不支持。确认仅在已安装 AgentDeck 的 Linux 环境使用后继续。', { modal: true }, { title: '继续启用' }, { title: '取消', isCloseAffordance: true });
              if (answer?.title !== '继续启用') throw new Error('已取消：未注册 Codex 启动入口。');
              await updateSetting('chatgpt', 'cliExecutable', CODEX_DISPATCH);
              if (vscode.workspace.getConfiguration('chatgpt').get('cliExecutable') !== CODEX_DISPATCH) throw new Error('当前客户端不允许注册 Codex 启动入口。');
              const sync = vscode.workspace.getConfiguration('settingsSync'), ignored = sync.get<string[]>('ignoredSettings', []);
              if (!ignored.includes('chatgpt.cliExecutable')) {
                await updateSetting('settingsSync', 'ignoredSettings', [...ignored.filter(x => x !== '-chatgpt.cliExecutable'), 'chatgpt.cliExecutable']);
              }
            }
          } else if (current === CODEX_DISPATCH) await writeCodexDispatcher(tx);
          // Explicitly restore previously owned shared settings during migration.
          for (const field of [...backup.fields].sort((a, b) => Number(b.key === 'proxy') - Number(a.key === 'proxy'))) {
            const section = vscode.workspace.getConfiguration(field.section);
            if (!same(section.get(field.key), field.applied)) throw new Error('旧版 VS Code 代理设置已被外部更改，请先核对。');
            await updateSetting(field.section, field.key, field.before);
            if (!same(ownValue(vscode.workspace.getConfiguration(field.section), field.key), field.before)) throw new Error('旧版代理设置恢复校验失败。');
          }
          backup.fields = [];
        }
        await this.context.secrets.store(key, JSON.stringify(backup));
        await this.environmentState.update(STATE, { version: 3, tools: next, managedTools: [...new Set([...this.managed, tool])] });
        await tx.write(this.marker(tool), JSON.stringify({ id: pending.id }));
      });
    } catch (error) {
      let incomplete = false;
      for (const revert of undo.reverse()) try { await revert(); } catch { incomplete = true; }
      try { if (stored) await this.context.secrets.store(key, stored); else await this.context.secrets.delete(key); await this.environmentState.update(STATE, previous); } catch { incomplete = true; }
      if (incomplete || error instanceof Error && error.message.includes('回滚未完成')) { this.errors.add(tool); this.messages[tool] = '网络恢复未完成，请保留恢复材料，重新加载后检查。'; }
      if (incomplete) { pending.failed = true; await this.context.secrets.store(pendingKey, JSON.stringify(pending)); } else await this.context.secrets.delete(pendingKey);
      if (incomplete) throw new Error('网络操作失败，部分设置回滚未完成。请保留恢复材料并检查后重试；不要视为已恢复。');
      throw error;
    }
    await Promise.resolve(this.context.secrets.delete(pendingKey)).catch(() => {});
    this.errors.delete(tool); this.configs = next; this.version = 3; if (config) this.managed.add(tool); else this.managed.delete(tool); delete this.tests[tool]; this.installTransport();
    this.messages[tool] = config ? '独立代理配置已保存，请重新加载客户端。浏览器及 VPN 选节点不由本设置管理。' : '当前工具的原代理配置已恢复，请重新加载客户端。';
  }
  private envFor(config: NetworkProxyConfig): Record<string, string> { return { ...proxyEnvironment(config), ALL_PROXY: '', all_proxy: '' }; }
  setTest(test: NetworkProxyTest, tool?: ToolId): void { if (tool) this.tests[tool] = test; }
  dispose(): void { for (const tool of ['claude', 'codex'] as ToolId[]) setNetworkProxy(undefined, tool); }
}
function object(value: unknown): Record<string, unknown> { if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude 配置必须是 JSON 对象。'); return value as Record<string, unknown>; }
async function jsonObject(file: string): Promise<Record<string, unknown>> { const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return '{}'; }); try { return object(JSON.parse(text)); } catch { throw new Error('配置文件必须为有效的 JSON 对象；原文件未覆盖。'); } }
function pick(env: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(env).filter(([key]) => PROXY_ENV_NAMES.includes(key))); }
function omit(env: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_ENV_NAMES.includes(key))); }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : value; }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function ownValue(configuration: vscode.WorkspaceConfiguration, key: string): unknown {
  const value = configuration.inspect(key) as { globalValue?: unknown; globalLocalValue?: unknown; globalRemoteValue?: unknown } | undefined;
  if (vscode.env?.remoteName) return value?.globalRemoteValue;
  return value && 'globalLocalValue' in value ? value.globalLocalValue : value?.globalValue;
}
