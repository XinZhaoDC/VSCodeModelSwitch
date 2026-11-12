import { importOrganization } from './shared/providers/importOrganization';
import { ProviderOrganizationStore, emptyOrganization, INDEPENDENT_GROUP, normalizedName } from './shared/providers/organization';
import { CodexOrganizationController, OrganizationAction } from './clients/codex/organizationController';
import { setSectionValue } from './config/tomlEdit';
import { userFacingError } from './ui/locale';
import { confirmClientChange } from './shared/runtimeGuard';
import { readOfficialCodexInfo, OfficialCodexInfo } from './clients/codex/diagnostics/info';
import { ReloadState } from './storage/reloadState';
import { browseFiles } from './ui/fileBrowser';
import { historyBackups, removeHistoryBackup } from './storage/historyBackups';
import { SessionController, SessionAction } from './clients/codex/history/controller';
import * as fs from 'fs/promises';
import { basename, dirname, join } from 'path';
import * as vscode from 'vscode';
import { ClaudeAdapter } from './clients/claude/adapter';
import { CodexAdapter } from './clients/codex/adapter';
import { deleteBackups, directorySize, getBackupDirectory, pathExists } from './config/atomicWrite';
import { buildTemplate, extractConfigValues, redactConfigText, setConfigModel, validateConfigText } from './config/templates';
import { fetchModels, testModelsEndpoint } from './models/modelFetcher';
import { defaultUsageQuery, queryUsage } from './models/usageQuery';
import { verifyModel } from './models/compatibilityCheck';
import { ModelResolver } from './models/modelResolver';
import { EnvironmentState } from './storage/environmentState';
import { ProviderStore } from './storage/providerStore';
import { SecretStore } from './storage/secretStore';
import { OperationLog, OperationEvent, operationFailure } from './storage/operationLog';
import { EnvManager } from './terminal/envManager';
import { TerminalManager } from './terminal/terminalManager';
import { ApiStatusKind, ApiStatusRow, CodexMode, CompatibilityResult, ModelInfo, ModelPolicy, NetworkTestResult, ProviderProfile, PublicConfigFile, ResolvedProvider, StatusState, ToolId, ToolRuntimeState, UsageQueryConfig, UsageQueryResult } from './types';
import {
  CreateProviderInput,
  SidebarViewProvider,
  SidebarViewState,
  toSidebarSummary
} from './ui/sidebarView';
import { StatusBarController } from './ui/statusBar';
import { fingerprintSecret } from './utils/hash';
import { createId, slugify } from './utils/ids';
import { randomUUID } from 'crypto';
import { normalizeProxyConfig } from './proxy/config';
import { ProxyServer } from './proxy/server';
import { managedProxyId, proxyClientConfig } from './proxy/applied';
import { ProxyConfig } from './types';
import { measureApi } from './speed/api';
import { measureOfficialCodex } from './clients/codex/diagnostics/speed';
import { runSpeedBenchmark } from './speed/runner';
import { SpeedStore, sameSpeedTarget } from './speed/store';
import { SpeedTarget, record as speedRecord } from './speed/types';
import { resolveHomePath } from './utils/paths';
import { buildAuthHeaderCandidates, buildCompatibilityUrl } from './models/modelFetcher';
import { resolveProxyOptions } from './proxy/config';
import { NetworkProxyManager } from './network/manager';
import { NetworkProxyConfig, disposeNetworkTransport, normalizeNetworkProxy, testNetworkProxy } from './network/transport';

type MenuAction =
  | 'switchProvider'
  | 'addProvider'
  | 'openClaudeTerminal'
  | 'openCodexTerminal'
  | 'viewClaudeConfig'
  | 'viewCodexConfig'
  | 'exportPublicConfig'
  | 'importPublicConfig';

type MenuItem = vscode.QuickPickItem & { action: MenuAction };
interface AppliedProxyRecord { provider: ProviderProfile; port: number; localUrl: string; keyRef: string }

export class VSModelSwitchApp implements vscode.Disposable {
  private readonly store: ProviderStore;
  private readonly codexOrganization: ProviderOrganizationStore;
  private readonly codexGroups: CodexOrganizationController;
  private readonly secretStore: SecretStore;
  private readonly modelResolver: ModelResolver;
  private readonly envManager: EnvManager;
  private readonly terminalManager = new TerminalManager();
  private readonly statusBar = new StatusBarController();
  private outputChannel: vscode.LogOutputChannel;
  private readonly claudeAdapter = new ClaudeAdapter();
  private readonly codexAdapter: CodexAdapter;
  private readonly sidebarView: SidebarViewProvider;
  private readonly fileWatchers: vscode.FileSystemWatcher[] = [];
  private readonly runtimeState: Record<ToolId, ToolRuntimeState>;
  private lastEnv: Record<string, string> = {};
  private status: StatusState = { kind: 'off' };
  private readonly toolFailures: Partial<Record<ToolId, string>> = {};
  private readonly networkTests = new Map<string, NetworkTestResult>();
  private readonly usageResults = new Map<string, UsageQueryResult>();
  private readonly compatibilityResults = new Map<string, CompatibilityResult>();
  private readonly proxyServer: ProxyServer;
  private readonly appliedRevisions = new Map<string, string>();
  private disposed = false;
  private restoreAttempted = false;
  private lastBatch?: { tool: ToolId; providerIds: string[]; at: number };
  private officialInfo?: OfficialCodexInfo;
  private speedStore: SpeedStore;
  private speedController?: AbortController;
  private readonly reloadNotices: ReloadState;
  private readonly networkProxy: NetworkProxyManager;
  private readonly sessionController: SessionController;
  private readonly operationLog: OperationLog;
  private readonly logReady: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly environment = new EnvironmentState(context)) {
    this.reloadNotices = new ReloadState(environment);
    this.networkProxy = new NetworkProxyManager(context, environment);
    const root = environment.get<string>('vscodemodelswitch.codexIdentityStorage');
    const defaultLogs = root ? join(root, 'environments', environment.id, 'logs') : join(context.globalStorageUri.fsPath, 'environments', environment.id, 'logs');
    this.operationLog = new OperationLog(environment.get<string>('operationLogDirectory', defaultLogs), environment.id,
      context.extension?.packageJSON?.version ?? '0.10.0', directory => environment.update('operationLogDirectory', directory));
    this.logReady = environment.ready;
    // A transient startup disk error must not permanently reject every later
    // logging attempt. Each operation retries the write and reports its error.
    void this.logReady.then(() => this.operationLog.write({ id: randomUUID(), action: 'activate', status: 'succeeded' }))
      .catch(() => this.outputChannel.warn('Startup operation log unavailable; later operations will retry.'));
    this.sessionController = new SessionController(context, environment, async root => {
      await this.logReady;
      const previous = this.operationLog.directory;
      await this.moveLogs(join(root, 'environments', environment.id, 'logs'));
      return () => this.moveLogs(previous);
    });
    this.codexAdapter = new CodexAdapter(() => this.sessionController.recoveryDirectory());
    this.speedStore = new SpeedStore(resolveHomePath('.vscodemodelswitch', 'speed'));
    this.outputChannel = vscode.window.createOutputChannel('VSCodeModelSwitch', { log: true });
    this.proxyServer = new ProxyServer(() => { if (!this.disposed) this.refreshStatus(); }, message => { if (!this.disposed) this.outputChannel.info(message); });
    this.store = new ProviderStore(context, environment);
    this.codexOrganization = new ProviderOrganizationStore('codex', context.globalState, environment, () => this.store.getProviders());
    this.codexGroups = new CodexOrganizationController(this.codexOrganization, () => this.runtimeState.codex.mode === 'api' ? this.runtimeState.codex.matchedProviderId ?? this.store.getCurrentProviderId('codex') : undefined);
    for (const [id, revision] of Object.entries(environment.get<Record<string, string>>('vscodemodelswitch.appliedRevisions', {}))) this.appliedRevisions.set(id, revision);
    this.secretStore = new SecretStore(context.secrets);
    this.modelResolver = new ModelResolver(this.store);
    this.envManager = new EnvManager(context);
    this.runtimeState = {
      claude: {
        tool: 'claude',
        configPath: this.claudeAdapter.getConfigPath()
      },
      codex: {
        tool: 'codex',
        configPath: this.codexAdapter.getConfigPath()
      }
    };
    this.sidebarView = new SidebarViewProvider(context.extensionUri, this);
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, this.sidebarView),
      this.sidebarView
    );
    this.registerCommands();
    this.registerConfigWatchers();
    void this.initializeCurrentProviders().catch(error => { this.outputChannel.warn(error instanceof Error ? error.message : String(error)); void vscode.window.showErrorMessage('状态读取失败，请点击刷新状态重试。'); });
  }

  dispose(): void {
    this.disposed = true;
    this.speedController?.abort();
    this.networkProxy.dispose();
    disposeNetworkTransport();
    this.proxyServer.dispose();
    this.statusBar.dispose();
    this.outputChannel.dispose();
    for (const watcher of this.fileWatchers) {
      watcher.dispose();
    }
  }

  private registerCommands(): void {
    const register = (command: string, handler: () => Promise<void> | void) => {
      this.context.subscriptions.push(
        vscode.commands.registerCommand(command, async () => {
          const id = randomUUID(), action = 'command.' + command.split('.').at(-1), started = Date.now();
          try {
            await this.recordOperation({ id, action, status: 'started' });
            await handler();
            await this.recordOperation({ id, action, status: 'succeeded', durationMs: Date.now() - started });
          } catch (error) {
            await this.recordOperation({ id, action, status: error instanceof Error && error.message.startsWith('已取消') ? 'cancelled' : 'failed',
              durationMs: Date.now() - started, ...operationFailure(error) }).catch(() => {});
            const message = userFacingError(error);
            void vscode.window.showErrorMessage(`AgentDeck：${message}`);
          }
        })
      );
    };

    register('vscodemodelswitch.openMenu', () => this.openMenu());
    register('vscodemodelswitch.addProvider', () => this.addProvider());
    register('vscodemodelswitch.switchProvider', () => this.switchProvider());
    register('vscodemodelswitch.openClaudeTerminal', () => this.openClaudeTerminal());
    register('vscodemodelswitch.openCodexTerminal', () => this.openCodexTerminal());
    register('vscodemodelswitch.viewClaudeConfig', () => this.viewConfig('claude'));
    register('vscodemodelswitch.viewCodexConfig', () => this.viewConfig('codex'));
    register('vscodemodelswitch.exportPublicConfig', () => this.exportPublicConfig());
    register('vscodemodelswitch.importPublicConfig', () => this.importPublicConfig());
    register('vscodemodelswitch.speedTest', () => this.chooseSpeedTest());
    register('vscodemodelswitch.copySpeedQuery', () => this.copySpeedQuery());
  }

  async getSidebarState(): Promise<SidebarViewState> {
    const providers = await Promise.all(
      this.store.getProviders().map((provider) =>
        toSidebarSummary(provider, async (item) => item.codexMode === 'official' || Boolean(await this.secretStore.get(item.secretRef)), this.networkTests.get(provider.id), this.usageResults.get(provider.id), this.compatibilityResults.get(provider.id), this.proxyServer.runtime(provider.id), this.appliedRevisions.has(provider.id) && this.appliedRevisions.get(provider.id) !== provider.updatedAt)
      )
    );
    const [logBytes, claudeBackupBytes, codexBackupBytes] = await Promise.all([
      directorySize(this.operationLog.directory),
      directorySize(getBackupDirectory(this.claudeAdapter.getConfigPath())),
      directorySize(getBackupDirectory(this.codexAdapter.getConfigPath()))
    ]);
    const codexMode = this.runtimeState.codex.mode ?? 'unknown';

    const organization = this.codexOrganization.view();
    for (const provider of providers) if (provider.tool === 'codex') {
      provider.groupId = organization.memberships[provider.id] ?? INDEPENDENT_GROUP;
      provider.disabled = organization.disabledProviders.includes(provider.id);
      provider.groupDisabled = organization.disabledGroups.includes(provider.groupId);
    }
    const sessions = await this.sessionController.state();
    const speedReports = await this.speedStore.readAll();
    for (const provider of providers) {
      const saved = this.store.getProvider(provider.id);
      const target = saved?.codexMode === 'official' ? this.currentSpeedTargets().codex : saved ? this.providerSpeedTarget(saved) : undefined;
      if (target) provider.speedResult = speedReports.find(report => sameSpeedTarget(report.target, target));
    }
    const officialTarget = this.currentSpeedTargets().codex;
    return {
      codexOrganization: this.codexOrganization.view(),
      networkPresets: this.environment.get('networkPresets', { codex: [], claude: [] }),
      reloadNotices: this.reloadNotices.entries(),
      networkProxy: this.networkProxy.state(),
      sessions,
      logDirectory: this.operationLog.directory,
      providers,
      lastBatch: this.lastBatch,
      officialInfo: this.officialInfo,
      officialSpeedResult: officialTarget?.mode === 'official' ? await this.speedStore.latest(officialTarget) : undefined,
      speedDirectory: this.speedStore.directory,
      currentProviderIds: this.store.getCurrentProviderIds(),
      status: this.status,
      globalCliSync: vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true),
      configTarget: vscode.workspace.getConfiguration('vscodemodelswitch').get<string>('configTarget', 'real'),
      configPaths: {
        claude: this.claudeAdapter.getConfigPath(),
        codex: this.codexAdapter.getConfigPath()
      },
      toolEnabled: {
        claude: this.store.getToolEnabled('claude'),
        codex: this.store.getToolEnabled('codex')
      },
      codexMode,
      apiStatuses: this.getApiStatuses(),
      storageSizes: {
        logBytes,
        backupBytes: claudeBackupBytes + codexBackupBytes,
        claudeBackupBytes,
        codexBackupBytes
      }
    };
  }

  async reloadStateFromSidebar(): Promise<void> {
    await this.logReady;
    const savedLogs = this.environment.get<string>('operationLogDirectory');
    if (savedLogs) await this.moveLogs(savedLogs);
    await this.sessionController.refresh();
    await this.networkProxy.refresh();
    await this.initializeCurrentProviders();
  }

  async applyNetworkProxyFromSidebar(config: NetworkProxyConfig, tool?: ToolId): Promise<void> {
    tool ??= 'codex';
    if (tool === 'claude' && !await confirmClientChange('Claude Code', '应用网络设置')) throw new Error('已取消：网络设置未更改。');
    if (this.speedController) throw new Error('请先完成或取消生成测速，再更改网络设置。');
    if ((tool ?? 'codex') === 'codex' && !await this.sessionController.confirmChange('应用 Codex 网络设置')) throw new Error('已取消，网络设置未更改。');
    const before = this.networkProxy.state().tools?.[tool!];
    await this.networkProxy.apply(config, tool);
    const after = this.networkProxy.state().tools?.[tool!];
    if (!before?.managed || before.config?.url !== after?.config?.url || before.config?.noProxy !== after?.config?.noProxy) await this.reloadNotices.add(tool!, 'network', '网络启动配置已改变，请重新加载客户端', true);
    await this.refreshNetworkDiagnostics();
  }

  async restoreNetworkProxyFromSidebar(tool?: ToolId): Promise<void> {
    tool ??= 'codex';
    if (tool === 'claude' && !await confirmClientChange('Claude Code', '恢复网络设置')) throw new Error('已取消：网络设置未更改。');
    if (this.speedController) throw new Error('请先完成或取消生成测速，再更改网络设置。');
    if ((tool ?? 'codex') === 'codex' && !await this.sessionController.confirmChange('恢复 Codex 网络设置')) throw new Error('已取消，网络设置未更改。');
    await this.networkProxy.restore(tool);
    await this.reloadNotices.add(tool!, 'network', '原网络配置已恢复，请重新加载客户端', true);
    await this.refreshNetworkDiagnostics();
  }

  async networkClipboardFromSidebar(tool: ToolId, action: 'copy' | 'paste', input?: NetworkProxyConfig): Promise<NetworkProxyConfig | undefined> {
    if (action === 'copy') { const config = normalizeNetworkProxy(input!); await vscode.env.clipboard.writeText(JSON.stringify({ kind: 'modelswitch-network', version: 1, ...config })); return; }
    let parsed: any; try { parsed = JSON.parse(await vscode.env.clipboard.readText()); } catch { throw new Error('剪贴板中没有可识别的网络配置。'); }
    if (parsed.kind !== 'modelswitch-network' || parsed.version !== 1) throw new Error('请先使用“复制设置”复制网络配置。');
    return normalizeNetworkProxy({ ...parsed, claude: tool === 'claude', codex: tool === 'codex' });
  }
  async networkPresetFromSidebar(tool: ToolId, action: 'save' | 'delete', input?: NetworkProxyConfig, name?: string): Promise<void> {
    const saved = this.environment.get<Record<ToolId, Array<NetworkProxyConfig & { name: string }>>>('networkPresets', { codex: [], claude: [] });
    if (!name?.trim()) throw new Error('请输入预设名称。');
    const entries = saved[tool] || []; const next = entries.filter(p => p.name !== name!.trim());
    if (action === 'save') next.push({ ...normalizeNetworkProxy(input!), name: name.trim().slice(0, 80) });
    await this.environment.update('networkPresets', { ...saved, [tool]: next });
  }

  async testNetworkProxyFromSidebar(config: NetworkProxyConfig, tool?: ToolId): Promise<void> {
    this.networkProxy.setTest(await testNetworkProxy(config), tool);
    this.refreshStatus();
  }

  async organizationActionFromSidebar(input: OrganizationAction): Promise<Record<string, unknown>> {
    this.ensureToolEnabled('codex');
    const session = await this.sessionController.state();
    const active = session.identities.find(i => i.id === session.activeId);
    if (session.restartRequired || (active?.kind ?? this.runtimeState.codex.mode) !== 'api') throw new Error('请先启用 API 模式并重载，再管理 API 群组。');
    let result: Record<string, unknown>;
    if (input.action === 'providerTemplate') {
      this.codexOrganization.assertEnabled(input.providerId!);
      const group = this.codexOrganization.requireGroup(this.codexOrganization.groupOf(input.providerId!));
      if (!group.defaults) throw new Error('该群组尚未保存请求处理模板。');
      const editor = await this.getProviderConfigFromSidebar(input.providerId!);
      if (group.defaults.baseUrl) editor.text = setSectionValue(editor.text, 'model_providers.OpenAI', 'base_url', group.defaults.baseUrl);
      if (group.defaults.proxy) editor.proxy = group.defaults.proxy;
      result = { editor };
    } else if (input.action === 'networkDraft') {
      this.codexOrganization.requireGroup(input.groupId!);
      if (this.codexOrganization.localState().disabledGroups.includes(input.groupId!)) throw new Error('群组已禁用。');
      const name = this.codexOrganization.localState().groupNetworkPresets[input.groupId!];
      const presets = this.environment.get<Partial<Record<ToolId, Array<NetworkProxyConfig & { name: string }>>>>('networkPresets', {});
      const preset = presets.codex?.find(p => p.name === name);
      if (!preset) throw new Error('本环境没有该网络预设，请先保存网络预设并在群组设置中选择。');
      result = { networkDraft: { ...preset, claude: false, codex: true } };
    } else {
      if (input.action === 'saveGroup' && input.networkPresetName) {
        const presets = this.environment.get<Partial<Record<ToolId, Array<{ name: string }>>>>('networkPresets', {});
        if (!presets.codex?.some(p => p.name === input.networkPresetName)) throw new Error('所选本环境网络预设不存在，请刷新后重试。');
      }
      result = await this.codexGroups.execute(input);
    }
    this.refreshStatus(); return result;
  }

  async sessionActionFromSidebar(action: SessionAction, id?: string, file?: string): Promise<void> {
    if (this.speedController) throw new Error('请先完成生成测速，再管理账号档案。');
    if (action === 'exportProviders') { await this.exportCodexProviders(); return; }
    if (action === 'manageBackups' || action === 'deleteHistoryBackups') { await this.manageHistoryBackups(action === 'deleteHistoryBackups'); return; }
    if (action === 'openFolder') { const root = (await this.sessionController.state()).root; if (!root || !await browseFiles(root, '浏览数据文件')) throw new Error('已取消：未打开数据文件。'); return; }
    if (action === 'help') { const root = (await this.sessionController.state()).root; if (!root) throw new Error('请先连接数据目录。'); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'readme.md')))); return; }
    await this.sessionController.action(action, id, file, this.runtimeState.codex.mode === 'api' ? 'api' : 'official');
    if (action === 'configure' || action === 'switch') await this.reloadNotices.add('codex', action === 'configure' ? 'storage' : 'mode', '当前历史或账号绑定已改变', true);
    this.refreshStatus();
  }

  private async refreshNetworkDiagnostics(): Promise<void> {
    this.networkTests.clear(); this.usageResults.clear(); this.compatibilityResults.clear();
    await this.speedStore.writeCurrent({ updatedAt: new Date().toISOString(), tools: this.currentSpeedTargets() })
      .catch(() => this.outputChannel.warn('Network proxy changed, but the current speed-query snapshot could not be refreshed.'));
    this.refreshStatus();
  }

  async setToolEnabledFromSidebar(tool: ToolId, enabled: boolean): Promise<void> {
    if (tool === 'codex' && enabled !== this.store.getToolEnabled(tool) && !await this.sessionController.confirmChange(enabled ? '启用 Codex 配置管理' : '停用 Codex 配置管理')) throw new Error('已取消：启用状态未更改。');
    await this.store.setToolEnabled(tool, enabled);
    this.refreshStatus();
  }

  async testProviderNetworkFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    if (provider.tool === 'codex' && provider.codexMode === 'official') throw new Error('Official Codex mode has no API endpoint to test');
    const key = await this.secretStore.get(provider.secretRef);
    if (!key) throw new Error('无法识别 API 密钥，请重新填写。');
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `检查供应商：${provider.name}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          const network = await testModelsEndpoint(provider.tool, provider.baseUrl, key, controller.signal, provider.proxy);
          let usage: UsageQueryResult | undefined;
          if (provider.usageQuery?.enabled && !network.cancelled && !token.isCancellationRequested) {
            const usageToken = await this.secretStore.get(SecretStore.usageRef(provider.id));
            usage = await queryUsage(provider.usageQuery, provider.baseUrl, key, usageToken, controller.signal, provider.tool);
          }
          return { network, usage };
        } finally {
          cancellation.dispose();
        }
      }
    );
    if (!outcome.network.cancelled) this.networkTests.set(provider.id, outcome.network);
    if (outcome.usage && outcome.usage.error !== 'Cancelled') this.usageResults.set(provider.id, outcome.usage);
    this.logDiagnostic('network', provider, outcome.network);
    if (outcome.usage) this.logDiagnostic('usage', provider, outcome.usage);
    if (outcome.network.cancelled || outcome.usage?.error === 'Cancelled') throw new Error('已取消：网络或用量测试。之前的结果保留。');
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async testToolNetworkFromSidebar(tool: ToolId): Promise<void> {
    this.ensureToolEnabled(tool);
    let selectedIds: Set<string> | undefined; let includeGeneration = false;
    if (tool === 'codex') {
      const choices = this.store.getProvidersByTool(tool).filter(p => p.codexMode !== 'official' && this.providerIsEnabled(p)).map(p => ({ label: p.name, description: p.baseUrl, id: p.id, picked: true }));
      const selected = await vscode.window.showQuickPick(choices, { title: '选择要诊断的供应商', canPickMany: true });
      if (!selected?.length) throw new Error('已取消：未选择供应商。');
      selectedIds = new Set(selected.map(p => p.id));
      const mode = await vscode.window.showQuickPick([{ label: '连接与模型目录、已启用的额度查询', generation: false }, { label: '同时测试生成与速度（三次请求/供应商，消耗额度）', generation: true }], { title: '选择诊断范围' });
      if (!mode) throw new Error('已取消：未开始诊断。'); includeGeneration = mode.generation;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `批量检查 ${labelTool(tool)} 供应商`, cancellable: true },
      async (progress, token) => {
        const providers = this.store.getProvidersByTool(tool).filter(p => this.providerIsEnabled(p) && (!selectedIds || selectedIds.has(p.id)));
        this.lastBatch = { tool, providerIds: providers.map(p => p.id), at: Date.now() };
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        let nextIndex = 0;
        let completed = 0;
        const worker = async () => {
          while (!token.isCancellationRequested) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= providers.length) return;
            const provider = providers[index];
            if (tool === 'codex' && provider.codexMode === 'official') { completed += 1; continue; }
            const key = await this.secretStore.get(provider.secretRef);
            if (!key) {
              this.networkTests.set(provider.id, {
                ok: false,
                modelsApi: 'notTested',
                checkedAt: new Date().toISOString(),
                error: 'API key missing'
              });
            } else {
              const result = await testModelsEndpoint(tool, provider.baseUrl, key, controller.signal, provider.proxy);
              if (!result.cancelled) this.networkTests.set(provider.id, result);
              this.logDiagnostic('network', provider, result);
              if (provider.usageQuery?.enabled && !result.cancelled && !token.isCancellationRequested) {
                const usageToken = await this.secretStore.get(SecretStore.usageRef(provider.id));
                const usage = await queryUsage(provider.usageQuery, provider.baseUrl, key, usageToken, controller.signal, provider.tool);
                if (usage.error !== 'Cancelled') this.usageResults.set(provider.id, usage);
                this.logDiagnostic('usage', provider, usage);
              }
            }
            completed += 1;
            progress.report({
              message: provider.name,
              increment: providers.length ? 100 / providers.length : 100
            });
          }
        };
        try {
          const workerCount = Math.min(2, providers.length);
          await Promise.all(Array.from({ length: workerCount }, () => worker()));
          if (token.isCancellationRequested) throw new Error('已取消：批量网络测试，已完成的结果保留。');
          if (includeGeneration) for (const provider of providers) { if (token.isCancellationRequested) throw new Error('已取消：批量生成测试。'); if (this.networkTests.get(provider.id)?.ok) await this.speedTestFromSidebar(provider.id, 3); }
          if (completed === 0 && providers.length === 0) progress.report({ increment: 100 });
        } finally {
          cancellation.dispose();
        }
      }
    );
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  private getApiStatuses(): ApiStatusRow[] {
    return (['claude', 'codex'] as ToolId[]).map((tool) => {
      const runtime = this.runtimeState[tool];
      let status = runtime.status ?? 'unactivated';
      if (managedProxyId(runtime.baseUrl, 'vscodemodelswitch-local') === runtime.matchedProviderId && runtime.matchedProviderId) {
        const proxy = this.proxyServer.runtime(runtime.matchedProviderId);
        if (proxy.state !== 'running' || proxy.lastRequest?.ok === false) status = 'degraded';
      }
      return {
        tool,
        mode: runtime.mode ?? (runtime.baseUrl ? 'api' : 'unknown'),
        providerName: runtime.providerName,
        model: runtime.model,
        status
      };
    });
  }

  async previewModelsFromSidebar(tool: ToolId, baseUrl: string, key: string, proxy?: ProxyConfig): Promise<ModelInfo[]> {
    this.ensureToolEnabled(tool);
    if (!baseUrl.trim() || !key) {
      throw new Error('获取模型列表前请填写 API 地址和密钥。');
    }
    return this.fetchAndCacheModels(tool, baseUrl.trim(), key, normalizeProxyConfig(proxy, tool));
  }

  async createProviderFromSidebar(input: CreateProviderInput): Promise<void> {
    await this.createProvider(input);
  }

  async setCurrentProviderFromSidebar(providerId: string): Promise<void> { await this.applyProviderFromSidebar(providerId); }

  async getProviderConfigFromSidebar(providerId: string): Promise<{ providerId: string; tool: ToolId; text: string; hasKey: boolean; usageQuery: UsageQueryConfig; usageHasToken: boolean; proxy: ProxyConfig; codexMode?: CodexMode }> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    return {
      providerId,
      tool: provider.tool,
      text: provider.tool === 'codex' && provider.codexMode === 'official' ? '' : provider.configText ?? buildTemplate(provider.tool, provider.baseUrl, provider.modelPolicy.type === 'fixed' ? provider.modelPolicy.model : ''),
      hasKey: provider.codexMode === 'official' ? true : Boolean(await this.secretStore.get(provider.secretRef)),
      usageQuery: provider.usageQuery ?? defaultUsageQuery(provider.baseUrl),
      usageHasToken: Boolean(await this.secretStore.get(SecretStore.usageRef(provider.id))),
      proxy: normalizeProxyConfig(provider.proxy, provider.tool),
      codexMode: provider.tool === 'codex' ? (provider.codexMode ?? 'api') : undefined
    };
  }

  async saveProviderConfigFromSidebar(providerId: string, text: string, key?: string, usageQuery?: UsageQueryConfig, usageAccessToken?: string, proxy?: ProxyConfig, codexMode?: CodexMode): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    // The configuration editor is the API-provider editor. Official mode is
    // applied from the Codex mode controls and does not have provider fields.
    const effectiveCodexMode = provider.tool === 'codex' ? (codexMode ?? 'api') : undefined;
    if (!(provider.tool === 'codex' && effectiveCodexMode === 'official')) validateConfigText(provider.tool, text);
    const proxyConfig = normalizeProxyConfig(proxy ?? provider.proxy, provider.tool);
    const values = effectiveCodexMode === 'official' ? { baseUrl: '', model: '', key: '' } : extractConfigValues(provider.tool, text);
    if (provider.tool === 'codex' && effectiveCodexMode === 'official') {
      await this.store.updateProvider(provider.id, current => ({ ...current, codexMode: 'official', baseUrl: '', modelPolicy: { type: 'toolDefault' }, configText: '', updatedAt: new Date().toISOString() }));
      this.clearProviderDiagnostics(provider.id);
      await this.scanCurrentProvidersFromConfig(); this.refreshStatus();
      return;
    }
    if (!values.baseUrl) throw new Error('请填写 API 地址。');
    const providedKey = key?.trim() || values.key;
    const storedKey = await this.secretStore.get(provider.secretRef);
    const effectiveKey = providedKey || storedKey;
    if (effectiveKey) await this.validateProviderUniqueness(provider.tool, provider.name, values.baseUrl, effectiveKey, provider.id);
    if (providedKey) await this.secretStore.store(provider.secretRef, providedKey);
    if (usageAccessToken?.trim()) await this.secretStore.store(SecretStore.usageRef(provider.id), usageAccessToken.trim());
    await this.store.updateProvider(provider.id, (current) => ({
      ...current,
      baseUrl: values.baseUrl.replace(/\/+$/g, ''),
      modelPolicy: values.model ? { type: 'fixed', model: values.model } : { type: 'toolDefault' },
      configMode: 'custom',
      configText: redactConfigText(provider.tool, text),
      usageQuery: usageQuery ?? current.usageQuery,
      proxy: proxyConfig,
      codexMode: effectiveCodexMode,
      updatedAt: new Date(Math.max(Date.now(), new Date(current.updatedAt).getTime() + 1)).toISOString()
    }));
    if (!values.model) {
      void vscode.window.showWarningMessage(`${provider.name} 已保存，但尚未设置模型。请先选择模型，再执行模型验证。`);
    }
    this.clearProviderDiagnostics(provider.id);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async applyProviderFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId); if (!provider) throw new Error('未找到供应商。');
    const previousMode = this.runtimeState.codex.mode;
    this.ensureProviderEnabled(provider); await this.activateProvider(provider);
    if (provider.tool === 'codex') await this.reloadNotices.add('codex', previousMode === 'api' ? 'providers' : 'mode', previousMode === 'api' ? '供应商配置已写入；已有对话可能需要重新打开' : '登录方式已改变，请重新加载窗口', previousMode !== 'api');
    this.refreshStatus();
  }

  async applyCodexModeFromSidebar(mode: CodexMode): Promise<void> {
    this.ensureToolEnabled('codex');
    const session = await this.sessionController.state();
    if (session.restartRequired) throw new Error('身份已更改。请先点击「重载窗口」，再使用 Codex 或应用供应商。');
    const active = session.identities.find(identity => identity.id === session.activeId);
    if (session.root && active?.kind !== mode) {
      await this.sessionController.prepareMode(mode);
      await this.reloadNotices.add('codex', 'mode', '账号历史绑定已改变，请重新加载窗口', true);
      this.refreshStatus(); return;
    }
    if (!session.root && this.runtimeState.codex.mode !== mode) {
      // Preserve the current account/API home first; this action does not write
      // the other mode into an unmanaged history and authentication directory.
      await this.sessionController.action('configure', undefined, undefined, this.runtimeState.codex.mode === 'api' ? 'api' : 'official');
      await this.reloadNotices.add('codex', 'storage', '数据目录已连接，请重新加载窗口', true);
      this.refreshStatus(); return;
    }
    await this.sessionController.ensureMode(mode);
    if (mode === 'official') {
      if (!await this.sessionController.confirmChange('应用官方账号配置')) throw new Error('已取消，配置未更改。');
      await this.codexAdapter.applyOfficialMode();
      await this.reloadNotices.add('codex', 'mode', '登录方式已改变，请重新加载窗口', true);
      await this.context.workspaceState.update(this.environment.key('vscodemodelswitch.appliedCodexProxy'), undefined);
      for (const provider of this.store.getProvidersByTool('codex')) this.proxyServer.stopRoute(provider.id);
      delete this.lastEnv.OPENAI_BASE_URL; delete this.lastEnv.OPENAI_API_KEY;
      this.lastEnv = { ...this.lastEnv, ...this.envManager.apply({
        missingSecrets: [],
        degraded: [],
        codex: {
          providerId: '',
          providerName: 'Official account',
          baseUrl: '',
          key: '',
          codexProviderId: 'OpenAI',
          wireApi: 'responses',
          configText: '',
          mode: 'official'
        }
      }) };
      delete this.toolFailures.codex;
      await this.scanCurrentProvidersFromConfig();
      this.refreshStatus();
      return;
    }

    const current = this.store.getCurrentProvider('codex');
    let provider = current && current.codexMode !== 'official'
      ? current
      : this.store.getProvidersByTool('codex').find(item => item.codexMode !== 'official');
    const candidates = this.store.getProvidersByTool('codex').filter(item => item.codexMode !== 'official');
    if ((!current || current.codexMode === 'official') && candidates.length > 1) {
      const selected = await vscode.window.showQuickPick(candidates.map(item => ({ label: item.name, description: item.baseUrl, provider: item })), { title: '选择要在当前 API 档案中应用的供应商' });
      if (!selected) throw new Error('已取消：未应用 API 供应商。');
      provider = selected.provider;
    }
    if (!provider) {
      throw new Error('请先添加 Codex API 供应商，再应用 API 模式。');
    }
    await this.activateProvider(provider);
  }

  async testUsageQueryFromSidebar(providerId: string, usageQuery: UsageQueryConfig, usageAccessToken?: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    const key = provider.codexMode === 'official' ? '' : await this.secretStore.get(provider.secretRef);
    if (!key) throw new Error('无法识别 API 密钥，请重新填写。');
    const storedUsageToken = usageAccessToken?.trim() || await this.secretStore.get(SecretStore.usageRef(provider.id));
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `查询额度：${provider.name}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          return await queryUsage(usageQuery, provider.baseUrl, key, storedUsageToken, controller.signal, provider.tool);
        } finally {
          cancellation.dispose();
        }
      }
    );
    if (result.error !== 'Cancelled') this.usageResults.set(provider.id, result);
    this.logDiagnostic('usage', provider, result);
    if (result.error === 'Cancelled') throw new Error('已取消：用量查询，之前的结果保留。');
    this.refreshStatus();
  }

  async verifyProviderModelFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    if (provider.tool === 'codex' && provider.codexMode === 'official') throw new Error('Official Codex mode has no API model verification');
    const key = await this.secretStore.get(provider.secretRef);
    if (!key) throw new Error('无法识别 API 密钥，请重新填写。');
    const model = provider.modelPolicy.type === 'fixed' || provider.modelPolicy.type === 'custom'
      ? provider.modelPolicy.model
      : provider.modelPolicy.type === 'providerAuto' ? provider.modelPolicy.preferred ?? '' : '';
    if (!model) throw new Error('请先选择模型。');
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `验证模型：${provider.name}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const probeId = provider.id + '--verify-' + randomUUID();
        try {
          const endpoint = provider.proxy?.mode === 'proxy' ? await this.proxyServer.register(probeId, provider.baseUrl, key, model, normalizeProxyConfig(provider.proxy, provider.tool), provider.tool) : { baseUrl: provider.baseUrl, key };
          return await verifyModel(provider.tool, endpoint.baseUrl, endpoint.key, model, controller.signal, provider.proxy?.mode === 'proxy' ? provider.proxy : undefined);
        } finally {
          if (provider.proxy?.mode === 'proxy') this.proxyServer.remove(probeId);
          cancellation.dispose();
        }
      }
    );
    if (!result.cancelled) this.compatibilityResults.set(provider.id, result);
    this.logDiagnostic('compatibility', provider, result);
    if (result.cancelled) throw new Error('已取消：模型验证，之前的结果保留。');
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  private providerSpeedTarget(provider: ProviderProfile): SpeedTarget {
    const model = provider.modelPolicy.type === 'fixed' || provider.modelPolicy.type === 'custom'
      ? provider.modelPolicy.model : provider.modelPolicy.type === 'providerAuto' ? provider.modelPolicy.preferred ?? 'auto' : 'auto';
    return { tool: provider.tool, mode: provider.codexMode === 'official' ? 'official' : 'api', providerId: provider.id, providerName: provider.name, model, configRevision: this.networkRevision(provider.updatedAt, provider.tool) };
  }

  private networkRevision(revision: string, tool: ToolId): string {
    const config = this.networkProxy?.state().tools?.[tool]?.config;
    return config ? revision + ':network:' + fingerprintSecret(JSON.stringify({ url: config.url, noProxy: config.noProxy })) : revision;
  }

  private currentSpeedTargets(): Partial<Record<ToolId, SpeedTarget>> {
    const targets: Partial<Record<ToolId, SpeedTarget>> = {};
    for (const tool of ['claude', 'codex'] as ToolId[]) {
      if (!this.store.getToolEnabled(tool)) continue;
      const runtime = this.runtimeState[tool];
      if (tool === 'codex' && runtime.mode === 'official') {
        const model = runtime.model || 'auto';
        targets.codex = { tool, mode: 'official', providerId: 'codex-official', providerName: 'Official account', model, configRevision: this.networkRevision('official:' + model + ':identity:' + (this.sessionController.activeId ?? 'unmanaged'), tool) };
      } else if (runtime.matchedProviderId) {
        const provider = this.store.getProvider(runtime.matchedProviderId);
        if (provider) targets[tool] = { ...this.providerSpeedTarget(provider), model: runtime.model || this.providerSpeedTarget(provider).model, configRevision: this.networkRevision(this.appliedRevisions.get(provider.id) ?? provider.updatedAt, tool) };
      }
    }
    return targets;
  }

  private async codexSpeedExecutable(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('vscodemodelswitch').get<string>('codexExecutablePath', '').trim();
    if (configured) return configured;
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    if (extension) {
      const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
      for (const name of [platform + '-' + architecture, platform + '-' + process.arch]) {
        const candidate = join(extension.extensionPath, 'bin', name, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (await pathExists(candidate)) return candidate;
      }
    }
    return 'codex';
  }

  async speedTestFromSidebar(providerId: string | undefined, runs: 1 | 3): Promise<void> {
    if (runs !== 1 && runs !== 3) throw new Error('请选择一次或三次测速请求。');
    if (this.speedController) throw new Error('已有生成测速正在运行。');
    const provider = providerId ? this.store.getProvider(providerId) : undefined;
    if (providerId && !provider) throw new Error('未找到供应商。');
    const target = provider ? this.providerSpeedTarget(provider) : this.currentSpeedTargets().codex;
    if (!target) throw new Error('请先选择 Codex 官方账号或 API 供应商。');
    if (provider) this.ensureProviderEnabled(provider);
    this.ensureToolEnabled(target.tool);
    if (target.tool === 'codex') this.sessionController.assertReady();
    // Official probes must use the active official login, never silently switch an API account.
    if (target.mode === 'official' && this.runtimeState.codex.mode !== 'official') throw new Error('请先切换到 Codex 官方账号模式，再测试当前账号。');
    if (target.mode === 'official' && provider) {
      const current = this.currentSpeedTargets().codex!;
      Object.assign(target, current);
    }
    if (target.mode === 'api' && target.model === 'auto') throw new Error('请先选择模型，再执行 API 生成测速。');
    const controller = new AbortController(); this.speedController = controller;
    const speedStore = this.speedStore;
    const probeId = (provider?.id ?? 'codex-official') + '--speed-' + randomUUID();
    const effort = target.mode === 'official' || target.tool === 'codex' && provider?.codex?.wireApi !== 'chat' ? 'low' : 'provider-default';
    let registered = false;
    try {
      const key = provider && target.mode === 'api' ? await this.secretStore.get(provider.secretRef) : undefined;
      if (target.mode === 'api' && !key) throw new Error('当前环境尚未保存供应商 API 密钥。');
      let endpoint = { baseUrl: provider?.baseUrl ?? '', key: key ?? '' };
      if (provider?.proxy?.mode === 'proxy' && target.mode === 'api') {
        endpoint = await this.proxyServer.register(probeId, provider.baseUrl, key!, target.model, normalizeProxyConfig(provider.proxy, provider.tool), provider.tool);
        registered = true;
      }
      const proxyOptions = provider?.proxy?.mode === 'proxy' ? resolveProxyOptions(provider.proxy) : undefined;
      const protocol = target.tool === 'claude' ? 'anthropic' : provider?.proxy?.mode !== 'proxy' && provider?.codex?.wireApi === 'chat' ? 'chat' : 'responses';
      const codexExecutable = target.mode === 'official' ? await this.codexSpeedExecutable() : '';
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `生成测速：${target.providerName}（${runs} 次请求，消耗额度）`, cancellable: true },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            if (token.isCancellationRequested) controller.abort();
            return await runSpeedBenchmark(target, runs, signal => target.mode === 'official'
              ? measureOfficialCodex(codexExecutable, target.model, effort, signal, dirname(this.codexAdapter.getConfigPath()), this.networkProxy.environment('codex'))
              : measureApi({ protocol, url: buildCompatibilityUrl(target.tool, endpoint.baseUrl).replace(/\/responses$/, protocol === 'chat' ? '/chat/completions' : '/responses'),
                  headers: Object.assign({}, ...buildAuthHeaderCandidates(target.tool, endpoint.key)), model: target.model, effort,
                  maxOutputTokens: 512, signal, timingSource: proxyOptions?.rebuildStream ? 'buffered-proxy' : 'native-stream' }),
              { signal: controller.signal, effort, timeoutMs: 120_000, maxOutputTokens: target.mode === 'official' ? null : 512, progress: index => progress.report({ message: `第 ${index}/${runs} 次请求` }) });
          } finally { cancellation.dispose(); }
        });
      report.connection = { mode: target.mode === 'official' ? 'codex-app-server' : registered ? 'built-in-proxy' : 'direct', protocol: target.mode === 'official' ? 'codex-app-server' : protocol,
        ...(proxyOptions ? { proxyMaxAttempts: proxyOptions.maxAttempts, proxyMaxOutputTokens: proxyOptions.maxOutputTokens, proxyTimeoutMs: proxyOptions.timeoutMs, proxyRebuildStream: proxyOptions.rebuildStream, proxyThinkingBudget: proxyOptions.extraThinkingBudget,
          upstreamEffort: String(speedRecord(proxyOptions.parameters.reasoning).effort ?? speedRecord(proxyOptions.parameters.output_config).effort ?? effort) } : {}) };
      await speedStore.save(report);
      await speedStore.writeCurrent({ updatedAt: new Date().toISOString(), tools: this.currentSpeedTargets() });
      this.outputChannel.info(`speed: ${report.id} ${report.summary.succeeded}/${report.parameters.runs} samples; results ${speedStore.directory}`);
      // The sidebar reports failed/cancelled samples at the originating card.
    } finally {
      if (registered) this.proxyServer.remove(probeId);
      this.speedController = undefined;
      this.refreshStatus();
    }
  }

  private async chooseSpeedTest(): Promise<void> {
    const items: Array<vscode.QuickPickItem & { providerId?: string }> = this.store.getProviders().filter(provider => provider.codexMode !== 'official' && this.providerIsEnabled(provider)).map(provider => ({ label: provider.name, description: provider.tool, providerId: provider.id }));
    if (this.runtimeState.codex.mode === 'official') items.unshift({ label: 'Codex 官方账号' });
    const chosen = await vscode.window.showQuickPick(items, { title: '选择测速连接（消耗模型额度）' });
    if (!chosen) return;
    const count = await vscode.window.showQuickPick([{ label: '快速：一次请求', runs: 1 as const }, { label: '标准：三次请求', runs: 3 as const }], { title: '使用固定短文本，每次请求消耗模型额度' });
    if (count) await this.speedTestFromSidebar(chosen.providerId, count.runs);
  }

  async copySpeedQuery(): Promise<void> {
    const tool = await vscode.window.showQuickPick(['codex', 'claude'], { title: '复制只读测速查询命令' });
    if (!tool) return;
    const quote = (value: string) => process.platform === 'win32' ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const command = `node ${quote(join(this.context.extensionUri.fsPath, 'out', 'speed', 'query.js'))} --tool ${tool} --directory ${quote(this.speedStore.directory)}`;
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage('已复制只读测速查询命令。可在 Node.js 终端运行，或交给 AI 读取；不会发起新的模型请求。');
  }

  async deleteProviderFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    const confirmation = await vscode.window.showWarningMessage(
      `删除供应商“${provider.name}”？已保存的 API 密钥也会删除，已经写入的客户端配置文件保留。`,
      { modal: true },
      { title: '删除' }, { title: '取消', isCloseAffordance: true }
    );
    if (confirmation?.title !== '删除') return;
    await this.secretStore.delete(provider.secretRef);
    await this.secretStore.delete(SecretStore.usageRef(provider.id));
    await this.secretStore.delete(this.environment.key(SecretStore.ref(provider.id, provider.tool) + '.applied'));
    await this.store.deleteProvider(providerId);
    this.proxyServer.remove(providerId);
    this.appliedRevisions.delete(providerId);
    this.clearProviderDiagnostics(providerId);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async moveProviderFromSidebar(providerId: string, beforeProviderId: string): Promise<void> {
    const provider = this.store.getProvider(providerId), target = this.store.getProvider(beforeProviderId);
    if (!provider || !target || provider.tool !== target.tool) throw new Error('供应商必须属于同一客户端。');
    this.ensureToolEnabled(provider.tool);
    if (provider.tool === 'codex') await this.codexOrganization.moveProvider(providerId, this.codexOrganization.groupOf(beforeProviderId), beforeProviderId);
    else await this.store.moveProvider(providerId, beforeProviderId);
    this.refreshStatus();
  }

  async deleteBackupsFromSidebar(tool: ToolId): Promise<void> {
    this.ensureToolEnabled(tool);
    const path = tool === 'claude' ? this.claudeAdapter.getConfigPath() : this.codexAdapter.getConfigPath();
    const count = await vscode.window.showWarningMessage(
      `删除 ${labelTool(tool)} 的全部旧版配置备份？`,
      { modal: true },
      { title: '删除' }, { title: '取消', isCloseAffordance: true }
    );
    if (count?.title !== '删除') return;
    await deleteBackups(path);
  }

  private providerIsEnabled(provider: ProviderProfile): boolean { return provider.tool !== 'codex' || !this.codexOrganization || this.codexOrganization.isEnabled(provider.id); }
  private ensureProviderEnabled(provider: ProviderProfile): void {
    this.ensureToolEnabled(provider.tool);
    if (provider.tool === 'codex') this.codexOrganization?.assertEnabled(provider.id);
  }

  private async validateProviderUniqueness(
    tool: ToolId,
    name: string,
    baseUrl: string,
    key: string,
    excludedProviderId?: string
  ): Promise<void> {
    let keyAlreadySaved = false;
    for (const provider of this.store.getProviders()) {
      if (provider.id === excludedProviderId) continue;
      if (provider.tool === tool && normalizeProviderName(provider.name) === normalizeProviderName(name)) {
        throw new Error('已存在同名供应商。');
      }
      const existingKey = await this.secretStore.get(provider.secretRef);
      if (existingKey !== key) continue;
      keyAlreadySaved = true;
      if (provider.tool === tool && normalizeBaseUrl(provider.baseUrl) === normalizeBaseUrl(baseUrl)) {
        throw new Error('已存在使用相同 API 地址和密钥的供应商。');
      }
    }
    if (keyAlreadySaved) void vscode.window.showWarningMessage('另一个供应商已经保存了相同的 API 密钥。');
  }

  async officialInfoFromSidebar(): Promise<void> {
    await this.sessionController.ensureMode('official');
    if (this.runtimeState.codex.mode !== 'official') throw new Error('请先使用官方账号模式。');
    this.officialInfo = await readOfficialCodexInfo(await this.codexSpeedExecutable(), this.codexAdapter.getConfigPath().replace(/[\\/]config[.]toml$/, ''), this.networkProxy.environment('codex'));
    this.refreshStatus();
  }
  async refreshProviderModelsFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId); if (!provider) throw new Error('未找到供应商。');
    this.ensureProviderEnabled(provider);
    const key = await this.secretStore.get(provider.secretRef); if (!key) throw new Error('请先配置 API Key。');
    await this.fetchAndCacheModels(provider.tool, provider.baseUrl, key, provider.proxy);
  }

  async updateProviderModelFromSidebar(providerId: string): Promise<void> {
    await this.updateProviderModel(providerId);
  }

  async refreshModelsFromSidebar(tool?: ToolId): Promise<void> {
    await this.refreshModels(tool);
  }

  async openClaudeTerminalFromSidebar(): Promise<void> {
    await this.openClaudeTerminal();
  }

  async openCodexTerminalFromSidebar(): Promise<void> {
    await this.openCodexTerminal();
  }

  async viewConfigFromSidebar(tool: ToolId): Promise<void> {
    await this.viewConfig(tool);
  }

  async exportPublicConfigFromSidebar(tool?: ToolId): Promise<void> {
    await this.exportPublicConfig(tool);
  }

  async importPublicConfigFromSidebar(tool?: ToolId): Promise<void> {
    await this.importPublicConfig(tool);
  }

  async clearLogFromSidebar(): Promise<boolean> {
    const confirmation = await vscode.window.showWarningMessage(
      '删除当前环境的插件操作日志及本窗口输出日志？不会删除配置、账号、聊天、备份或恢复材料。日志目录：' + this.operationLog.directory,
      { modal: true },
      { title: '删除日志' }, { title: '取消', isCloseAffordance: true }
    );
    if (confirmation?.title !== '删除日志') return false;
    await this.logReady;
    await this.operationLog.clear();
    this.outputChannel.dispose();
    try {
      const entries = await fs.readdir(this.context.logUri.fsPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return []; });
      for (const entry of entries) {
        if (!entry.isFile() || !/^VSCodeModelSwitch(?:[.-][a-zA-Z0-9_-]+)?[.]log$/.test(entry.name)) continue;
        await fs.unlink(vscode.Uri.joinPath(this.context.logUri, entry.name).fsPath);
      }
    } finally {
      this.outputChannel = vscode.window.createOutputChannel('VSCodeModelSwitch', { log: true });
    }
    return true;
  }

  async recordOperation(event: OperationEvent): Promise<void> {
    await this.logReady;
    await this.operationLog.write(event);
  }

  private async moveLogs(directory: string): Promise<void> {
    if (directory === this.operationLog.directory) return;
    const id = randomUUID(), previous = this.operationLog.directory;
    await this.recordOperation({ id, action: 'logs.move', status: 'started' });
    try {
      await this.operationLog.move(directory);
      await this.recordOperation({ id, action: 'logs.move', status: 'succeeded' });
    } catch (error) {
      if (this.operationLog.directory !== previous) await this.operationLog.move(previous);
      await this.recordOperation({ id, action: 'logs.move', status: 'failed', ...operationFailure(error) }).catch(() => {});
      throw error;
    }
  }

  async logActionFromSidebar(action: 'view' | 'folder' | 'export'): Promise<void> {
    await this.logReady;
    if (action === 'folder') {
      await fs.mkdir(this.operationLog.directory, { recursive: true, mode: 0o700 });
      if (!await browseFiles(this.operationLog.directory, '浏览操作日志', /[.](?:log|jsonl)$/i)) throw new Error('已取消：未打开日志。');
    } else if (action === 'view') {
      const document = await vscode.workspace.openTextDocument({ content: await this.operationLog.text(), language: 'jsonl' });
      await vscode.window.showTextDocument(document, { preview: false });
    } else {
      const uri = await vscode.window.showSaveDialog({ title: '导出操作诊断日志（不含聊天或认证）', filters: { JSONL: ['jsonl'] }, saveLabel: '导出' });
      if (!uri) throw new Error('已取消：未导出日志。');
      await fs.writeFile(uri.fsPath, await this.operationLog.text(), { mode: 0o600 });
    }
  }

  private refreshStatus(): void {
    this.statusBar.update(this.runtimeState);
    void this.sidebarView.refresh();
  }

  private async initializeCurrentProviders(): Promise<void> {
    await this.environment.ready;
    await this.sessionController.ready;
    await this.networkProxy.ready;
    if (!this.restoreAttempted) {
      try { const recovered = await this.codexAdapter.recoverPending(); if (recovered) void vscode.window.showInformationMessage(recovered); }
      catch (error) { this.sessionController.reportRecoveryFailure(error); void vscode.window.showErrorMessage(userFacingError(error)); }
    }
    const firstInitialization = !this.restoreAttempted;
    if (!this.restoreAttempted) {
      this.restoreAttempted = true;
      await this.restoreAppliedProxy();
    }
    await this.scanCurrentProvidersFromConfig();
    if (firstInitialization) {
      const session = await this.sessionController.state();
      await this.reloadNotices.acknowledgeStartup(notice => notice.section === 'network' ? !this.networkProxy.state().tools?.[notice.tool]?.error : !this.sessionController.recoveryBlocked && (!session.root || session.attached) && this.runtimeState.codex.mode !== 'unknown');
      for (const provider of Object.values(this.store.getCurrentProviders())) {
        if (provider && !this.appliedRevisions.has(provider.id)) this.appliedRevisions.set(provider.id, provider.updatedAt);
      }
      await this.environment.update('vscodemodelswitch.appliedRevisions', Object.fromEntries(this.appliedRevisions));
    }
    const hasCurrent = Boolean(this.store.getCurrentProvider('claude') || this.store.getCurrentProvider('codex'));
    this.status = hasCurrent ? { kind: 'ready' } : { kind: 'off' };
    this.refreshStatus();
  }

  private async scanCurrentProvidersFromConfig(): Promise<void> {
    this.speedStore = new SpeedStore(resolveHomePath('.vscodemodelswitch', 'speed'));
    const providers = this.store.getProviders();
    const [claudeConfig, codexConfig]: [
      { baseUrl?: string; model?: string; key?: string },
      { baseUrl?: string; model?: string; providerId?: string; key?: string; mode?: CodexMode | 'unknown'; officialLoggedIn?: boolean }
    ] = await Promise.all([
      this.claudeAdapter.readActiveConfig().catch(() => ({})),
      this.codexAdapter.readActiveConfig().catch(() => ({}))
    ]);

    const localId = managedProxyId(claudeConfig.baseUrl, claudeConfig.key);
    const synced = vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true);
    let claude = !synced ? this.store.getCurrentProvider('claude') : localId ? providers.find(p => p.tool === 'claude' && p.id === localId) : await matchProviderFromConfig(providers, 'claude', claudeConfig.baseUrl, claudeConfig.key, this.secretStore);
    claude = await this.reconcileObservedProvider('claude', claude, claudeConfig, synced);
    const effectiveClaude = synced ? claudeConfig : { baseUrl: this.lastEnv.ANTHROPIC_BASE_URL, key: this.lastEnv.ANTHROPIC_AUTH_TOKEN, model: this.lastEnv.ANTHROPIC_MODEL };
    if (claude) {
      await this.store.setCurrentProviderId('claude', claude.id);
    } else {
      await this.store.setCurrentProviderId('claude', undefined);
    }
    this.runtimeState.claude = {
      tool: 'claude',
      providerName: claude?.name,
      baseUrl: effectiveClaude.baseUrl,
      model: effectiveClaude.model,
      matchedProviderId: claude?.id,
      status: await this.determineToolStatus('claude', providers, claude, effectiveClaude.baseUrl, effectiveClaude.key),
      configPath: this.claudeAdapter.getConfigPath()
    };

    const codexLocalId = managedProxyId(codexConfig.baseUrl, codexConfig.key);
    const codexMode = !synced && this.lastEnv.OPENAI_BASE_URL ? 'api' : codexConfig.mode ?? 'unknown';
    let codex = codexMode === 'official' ? providers.find(provider => provider.tool === 'codex' && provider.codexMode === 'official')
      : !synced ? this.store.getCurrentProvider('codex') : codexLocalId
      ? providers.find(provider => provider.tool === 'codex' && provider.id === codexLocalId)
      : await matchProviderFromConfig(providers, 'codex', codexConfig.baseUrl, codexConfig.key, this.secretStore);
    codex = await this.reconcileObservedProvider('codex', codex, { ...codexConfig, mode: codexMode }, synced);
    if (codex) {
      await this.store.setCurrentProviderId('codex', codex.id);
    } else {
      await this.store.setCurrentProviderId('codex', undefined);
    }
    const effectiveCodex = synced ? codexConfig : { baseUrl: this.lastEnv.OPENAI_BASE_URL, key: this.lastEnv.OPENAI_API_KEY, model: codex?.modelPolicy.type === 'fixed' || codex?.modelPolicy.type === 'custom' ? codex.modelPolicy.model : undefined };
    this.runtimeState.codex = {
      tool: 'codex',
      mode: codexMode,
      providerName: codexMode === 'official' ? 'Official account' : codex?.name,
      baseUrl: effectiveCodex.baseUrl,
      model: effectiveCodex.model,
      matchedProviderId: codex?.id,
      status: !this.store.getToolEnabled('codex') ? 'off' : codexMode === 'official'
        ? codexConfig.officialLoggedIn ? 'signedIn' : 'loginRequired'
        : codexMode === 'unknown' ? 'degraded' : await this.determineToolStatus('codex', providers, codex, effectiveCodex.baseUrl, effectiveCodex.key),
      configPath: this.codexAdapter.getConfigPath()
    };
    await this.speedStore.writeCurrent({ updatedAt: new Date().toISOString(), tools: this.currentSpeedTargets() });
  }

  /** A shared definition/key edit must not deselect the configuration already
   * applied here. Only reuse the old match while the local CLI signature agrees. */
  private async reconcileObservedProvider(tool: ToolId, matched: ProviderProfile | undefined,
    config: { baseUrl?: string; key?: string; mode?: string }, synced: boolean): Promise<ProviderProfile | undefined> {
    if (!synced) return matched;
    const key = 'vscodemodelswitch.observedConfig.' + tool;
    const signature = fingerprintSecret(JSON.stringify([config.mode ?? 'api', normalizeBaseUrl(config.baseUrl ?? ''), fingerprintSecret(config.key ?? '')]));
    const previous = this.environment.get<{ signature: string; providerId: string } | undefined>(key);
    if (!matched && previous?.signature === signature) {
      const provider = this.store.getProvider(previous.providerId);
      if (provider?.tool === tool) matched = provider;
    }
    if (matched && (previous?.signature !== signature || previous.providerId !== matched.id)) {
      await this.environment.update(key, { signature, providerId: matched.id });
    }
    return matched;
  }

  private async determineToolStatus(
    tool: ToolId,
    providers: ProviderProfile[],
    matched: ProviderProfile | undefined,
    baseUrl: string | undefined,
    key: string | undefined
  ): Promise<ApiStatusKind> {
    if (!this.store.getToolEnabled(tool)) return 'off';
    if (this.toolFailures[tool]) return 'degraded';
    if (!matched) {
      if (baseUrl) {
        for (const provider of providers) {
          if (provider.tool !== tool || normalizeBaseUrl(provider.baseUrl) !== normalizeBaseUrl(baseUrl)) continue;
          if (!await this.secretStore.get(provider.secretRef)) return 'missingKey';
        }
      }
      return 'unactivated';
    }
    if (managedProxyId(baseUrl, key) === matched.id) {
      if (this.proxyServer.runtime(matched.id).state !== 'running') return 'degraded';
      if (this.proxyServer.runtime(matched.id).lastRequest?.ok === false) return 'degraded';
      key = await this.secretStore.get(matched.secretRef);
    }
    const network = this.networkTests.get(matched.id);
    if (network && !network.cancelled && network.reachable === false) return 'networkError';
    if (tool === 'codex' && matched.codexMode === 'official') return 'ready';
    const compatibility = this.compatibilityResults.get(matched.id);
    if (compatibility && !compatibility.cancelled && !compatibility.ok) {
      return compatibility.failureKind === 'network' ? 'networkError' : 'degraded';
    }
    if (key && this.isModelCacheStale(tool, matched.baseUrl, key)) return 'modelsStale';
    return 'ready';
  }

  private clearProviderDiagnostics(providerId: string): void {
    this.networkTests.delete(providerId);
    this.usageResults.delete(providerId);
    this.compatibilityResults.delete(providerId);
  }

  private logDiagnostic(kind: string, provider: ProviderProfile, result: unknown): void {
    const value = result as { ok?: boolean; httpStatus?: number; latencyMs?: number; cancelled?: boolean; error?: string };
    const status = value.cancelled || value.error === 'Cancelled' ? 'cancelled' : value.ok ? 'succeeded' : 'failed';
    this.outputChannel.info(`${kind} ${provider.tool}/${provider.id}: ${status}; HTTP ${value.httpStatus ?? 'n/a'}; ${value.latencyMs ?? 'n/a'} ms`);
    void this.recordOperation({ id: randomUUID(), action: 'diagnostic.' + kind, status,
      target: provider.tool + ':provider:' + provider.id, httpStatus: value.httpStatus, latencyMs: value.latencyMs,
      ...(status === 'failed' ? operationFailure(new Error(value.error ?? '')) : {})
    }).catch(() => this.outputChannel.warn('Diagnostic operation log could not be written.'));
  }

  private isModelCacheStale(tool: ToolId, baseUrl: string, key: string): boolean {
    const cache = this.store.getModelCache().find((entry) =>
      entry.tool === tool && normalizeBaseUrl(entry.baseUrl) === normalizeBaseUrl(baseUrl) && entry.keyFingerprint === fingerprintSecret(key)
    );
    if (!cache) return false;
    const fetchedAt = new Date(cache.fetchedAt).getTime();
    return Number.isFinite(fetchedAt) && Date.now() - fetchedAt >= cache.ttlMs;
  }

  private registerConfigWatchers(): void {
    for (const tool of ['claude', 'codex'] as ToolId[]) {
      const configPath = tool === 'claude' ? this.claudeAdapter.getConfigPath() : this.codexAdapter.getConfigPath();
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(configPath)), basename(configPath)));
      const refresh = () => {
        void this.initializeCurrentProviders();
      };
      watcher.onDidCreate(refresh, undefined, this.context.subscriptions);
      watcher.onDidChange(refresh, undefined, this.context.subscriptions);
      watcher.onDidDelete(refresh, undefined, this.context.subscriptions);
      this.fileWatchers.push(watcher);
      this.context.subscriptions.push(watcher);
    }
  }

  private async openMenu(): Promise<void> {
    const items: MenuItem[] = [
      { label: '切换供应商', action: 'switchProvider' },
      { label: '添加供应商', action: 'addProvider' },
      { label: '打开 Claude 终端', action: 'openClaudeTerminal' },
      { label: '打开 Codex 终端', action: 'openCodexTerminal' },
      { label: '查看 Claude 配置', action: 'viewClaudeConfig' },
      { label: '查看 Codex 配置', action: 'viewCodexConfig' },
      { label: '导出供应商配置', action: 'exportPublicConfig' },
      { label: '导入供应商配置', action: 'importPublicConfig' }
    ];
    const action = await vscode.window.showQuickPick(items, { placeHolder: 'AgentDeck' });
    if (!action) {
      return;
    }

    if (action.action === 'viewClaudeConfig') {
      await this.viewConfig('claude');
      return;
    }
    if (action.action === 'viewCodexConfig') {
      await this.viewConfig('codex');
      return;
    }

    await vscode.commands.executeCommand(`vscodemodelswitch.${action.action}`);
  }

  private async addProvider(): Promise<void> {
    const toolPick = await vscode.window.showQuickPick(
      [
        { label: 'Claude Code', tool: 'claude' as ToolId },
        { label: 'Codex', tool: 'codex' as ToolId }
      ],
      { title: '选择工具' }
    );
    if (!toolPick) {
      return;
    }

    const name = await this.promptRequiredInput('供应商名称', 'OpenRouter, DeepSeek, Work Proxy');
    const baseUrl = await this.promptRequiredInput(`${toolPick.label} API 地址`, 'https://api.example.com');
    const key = await this.promptRequiredInput(`${toolPick.label} API 密钥`, 'sk-...', true);
    if (!name || !baseUrl || !key) {
      return;
    }

    const models = await this.fetchAndCacheModels(toolPick.tool, baseUrl, key);
    const model = await this.pickModel(toolPick.tool, models);
    if (!model) {
      return;
    }

    await this.createProvider({
      tool: toolPick.tool,
      name,
      baseUrl,
      key: key ?? '',
      model,
      applyNow: false,
      configMode: 'generated'
    });
  }

  private async createProvider(input: CreateProviderInput): Promise<void> {
    this.ensureToolEnabled(input.tool);
    if (input.tool === 'codex') {
      const group = this.codexOrganization.requireGroup(input.groupId ?? INDEPENDENT_GROUP);
      if (input.applyNow && this.codexOrganization.localState().disabledGroups.includes(group.id)) throw new Error('目标群组已禁用，允许保存新供应商，但不能同时应用。');
    }
    if (!input.name.trim()) {
      throw new Error('请填写供应商名称。');
    }
    const configMode = input.configMode ?? 'generated';
    const codexMode = input.tool === 'codex' ? (input.codexMode ?? 'api') : undefined;
    const proxy = normalizeProxyConfig(input.proxy, input.tool);
    const configText = codexMode === 'official' ? '' : input.configText ?? buildTemplate(input.tool, input.baseUrl.trim(), input.model.trim());
    if (!(input.tool === 'codex' && codexMode === 'official')) validateConfigText(input.tool, configText);
    const values = codexMode === 'official' ? { baseUrl: '', model: '', key: '' } : extractConfigValues(input.tool, configText);
    const key = input.key.trim() || values.key;
    if (codexMode !== 'official' && !values.baseUrl) throw new Error('请填写 API 地址。');
    if (codexMode !== 'official' && !key) throw new Error('无法识别 API 密钥，请重新填写。');
    if (codexMode !== 'official') await this.validateProviderUniqueness(input.tool, input.name, values.baseUrl, key);
    const confirmed = input.applyNow && input.tool === 'codex';
    if (confirmed) {
      await this.sessionController.ensureMode(codexMode ?? 'api');
      if (!await this.sessionController.confirmChange('保存并应用 Codex API Provider')) throw new Error('已取消：Provider 未保存或应用。');
    }

    const id = createId(slugify(`${input.tool}-${input.name}`));
    const secretRef = SecretStore.ref(id, input.tool);
    await this.secretStore.store(secretRef, key);

    const now = new Date().toISOString();
    const provider: ProviderProfile = {
      id,
      name: input.name.trim(),
      tool: input.tool,
      baseUrl: values.baseUrl.replace(/\/+$/g, ''),
      modelPolicy: values.model ? { type: 'fixed', model: values.model } : { type: 'toolDefault' },
      secretRef,
      configMode,
      configText: redactConfigText(input.tool, configText),
      proxy,
      codexMode,
      createdAt: now,
      updatedAt: now
    };

    if (input.tool === 'codex') {
      provider.codex = {
        providerId: 'OpenAI',
        wireApi: 'responses'
      };
    }

    await this.store.upsertProvider(provider);
    if (input.tool === 'codex' && codexMode !== 'official') {
      try { await this.codexOrganization.assignNewProvider(provider.id, input.groupId); }
      catch (error) { await this.store.deleteProvider(provider.id); await this.secretStore.delete(secretRef); throw error; }
    }
    if (!values.model && codexMode !== 'official') {
      void vscode.window.showWarningMessage(`${input.name.trim()} 已保存，但尚未设置模型。请先选择模型，再执行模型验证。`);
    }

    if (input.applyNow) {
      const previousProviderId = this.store.getCurrentProviderId(input.tool);
      await this.store.setCurrentProviderId(input.tool, provider.id);
      try {
        const result = await this.applyProvider(input.tool, confirmed);
        if (result?.missingSecrets.length) throw new Error('无法识别 API 密钥，请重新填写。');
      } catch (error) {
        await this.store.setCurrentProviderId(input.tool, previousProviderId);
        throw error;
      }
    } else {
      this.status = { kind: 'ready' };
      this.refreshStatus();
    }
  }

  private async switchProvider(): Promise<void> {
    const toolPick = await vscode.window.showQuickPick(
      [
        { label: 'Claude Code', tool: 'claude' as ToolId },
        { label: 'Codex', tool: 'codex' as ToolId }
      ],
      { title: '选择要切换供应商的工具' }
    );
    if (!toolPick) {
      return;
    }

    const providers = this.store.getProvidersByTool(toolPick.tool).filter(p => this.providerIsEnabled(p));
    if (providers.length === 0) {
      void vscode.window.showInformationMessage(`尚未添加 ${toolPick.label} 供应商，请先添加。`);
      return;
    }

    const currentId = this.store.getCurrentProviderId(toolPick.tool);
    const selected = await vscode.window.showQuickPick(
      providers.map((provider) => ({
        label: provider.name,
        description: labelModel(provider.modelPolicy),
        detail: provider.id === currentId ? '当前使用' : provider.baseUrl,
        provider
      })),
      { title: `切换 ${toolPick.label} 供应商` }
    );
    if (!selected) {
      return;
    }

    await this.activateProvider(selected.provider);
    void vscode.window.showInformationMessage(`${toolPick.label} 供应商已应用，请重新打开已有客户端以使用新配置。`);
  }

  private async applyProviderWithMessage(tool: ToolId): Promise<void> {
    const result = await this.applyProvider(tool);
    if (!result) {
      return;
    }

    if (result.missingSecrets.length > 0) {
      void vscode.window.showWarningMessage(`配置已写入，但缺少以下密钥：${result.missingSecrets.join(', ')}`);
      return;
    }
    if (result.degraded.length > 0) {
      void vscode.window.showWarningMessage(`配置已写入，但有以下问题：${result.degraded.join('; ')}`);
      return;
    }
    void vscode.window.showInformationMessage(`已应用 ${labelTool(tool)} 供应商配置；已有客户端可能需要重新打开。`);
  }

  private async applyProvider(tool: ToolId, confirmed = false): Promise<ResolvedProvider | undefined> {
    this.ensureToolEnabled(tool);
    const provider = this.store.getCurrentProvider(tool);
    if (provider) this.ensureProviderEnabled(provider);
    if (tool === 'codex' && provider) {
      await this.sessionController.ensureMode(provider.codexMode ?? 'api');
      if (!confirmed && !await this.sessionController.confirmChange('应用 Codex API Provider')) throw new Error('已取消，配置未更改。');
    }
    if (!provider) {
      this.status = { kind: 'off' };
      this.refreshStatus();
      void vscode.window.showInformationMessage(`${labelTool(tool)} 当前没有使用中的供应商。`);
      return undefined;
    }

    const resolved: ResolvedProvider = {
      missingSecrets: [],
      degraded: []
    };
    const value = await this.resolveProvider(provider);
    const config = normalizeProxyConfig(provider.proxy, tool);
    let rollback: (() => void) | undefined;
    const useProxy = config.mode === 'proxy' && provider.codexMode !== 'official';
    let endpoint = value ? { baseUrl: value.baseUrl, key: value.key } : undefined;
    if (value && useProxy) {
      const local = await this.proxyServer.register(provider.id, value.baseUrl, value.key, value.model, config, tool);
      rollback = local.rollback; endpoint = local;
    }
    if (!value) {
      resolved.missingSecrets.push(tool);
    } else if (tool === 'claude') {
      resolved.claude = { providerId: provider.id, providerName: provider.name, ...endpoint!, model: value.model, configText: useProxy ? proxyClientConfig(value.configText, endpoint!, tool) : value.configText, proxy: useProxy };
    } else {
      resolved.codex = { providerId: provider.id, providerName: provider.name, ...endpoint!, model: value.model, codexProviderId: 'OpenAI', wireApi: 'responses', configText: useProxy ? proxyClientConfig(value.configText, endpoint!, tool) : value.configText, mode: provider.codexMode ?? 'api', proxy: useProxy };
    }

    const previousRevisions = this.environment.get<Record<string, string>>('vscodemodelswitch.appliedRevisions', {});
    const proxyRecordKey = tool === 'claude' ? 'vscodemodelswitch.appliedProxy' : 'vscodemodelswitch.appliedCodexProxy';
    const previousProxyRecord = this.context.workspaceState.get<AppliedProxyRecord>(this.environment.key(proxyRecordKey));
    let appliedKeyRef: string | undefined;
    let previousAppliedKey: string | undefined;
    try {
      // Finish fallible metadata/key storage before changing the user's config file.
      if (!resolved.missingSecrets.length) {
        if (useProxy) {
          appliedKeyRef = this.environment.key(SecretStore.ref(provider.id, tool) + '.applied');
          previousAppliedKey = await this.secretStore.get(appliedKeyRef);
          await this.secretStore.store(appliedKeyRef, value!.key);
          await this.context.workspaceState.update(this.environment.key(proxyRecordKey), { provider: structuredClone(provider), port: this.proxyServer.getPort(), localUrl: endpoint!.baseUrl, keyRef: appliedKeyRef });
        } else await this.context.workspaceState.update(this.environment.key(proxyRecordKey), undefined);
        await this.environment.update('vscodemodelswitch.appliedRevisions', { ...previousRevisions, [provider.id]: provider.updatedAt });
      }
      if (resolved.missingSecrets.length === 0 && vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true)) {
        if (tool === 'claude') await this.claudeAdapter.apply(resolved);
        else await this.codexAdapter.apply(resolved);
      }
    } catch (error) {
      rollback?.();
      try {
        await this.environment.update('vscodemodelswitch.appliedRevisions', previousRevisions);
        await this.context.workspaceState.update(this.environment.key(proxyRecordKey), previousProxyRecord);
        if (appliedKeyRef) {
          if (previousAppliedKey === undefined) await this.secretStore.delete(appliedKeyRef);
          else await this.secretStore.store(appliedKeyRef, previousAppliedKey);
        }
      } catch { this.outputChannel.warn('Apply failed; applied metadata could not be restored. The prior client config was not rewritten.'); }
      throw error;
    }
    if (!resolved.missingSecrets.length) {
      if (resolved.claude && !resolved.claude.proxy) for (const name of ['ANTHROPIC_API_KEY', 'ENABLE_TOOL_SEARCH', 'ANTHROPIC_MODEL']) delete this.lastEnv[name];
      if (resolved.codex?.mode === 'official') { delete this.lastEnv.OPENAI_BASE_URL; delete this.lastEnv.OPENAI_API_KEY; }
      this.lastEnv = { ...this.lastEnv, ...this.envManager.apply(resolved) };
      this.appliedRevisions.set(provider.id, provider.updatedAt);
      delete this.toolFailures[tool];
      if (!useProxy) this.proxyServer.stopRoute(provider.id);
    }

    this.status = statusFromResolved(resolved);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
    return resolved;
  }

  private async activateProvider(provider: ProviderProfile, confirmed = false): Promise<void> {
    this.ensureProviderEnabled(provider);
    if (provider.tool === 'codex' && !confirmed) {
      await this.sessionController.ensureMode(provider.codexMode ?? 'api');
      if (!await this.sessionController.confirmChange('应用 Codex API Provider')) throw new Error('已取消：当前 Provider 未更改。');
      confirmed = true;
    }
    const previous = this.store.getCurrentProviderId(provider.tool);
    await this.store.setCurrentProviderId(provider.tool, provider.id);
    try {
      const result = await this.applyProvider(provider.tool, confirmed);
      if (result?.missingSecrets.length) throw new Error('无法识别 API 密钥，请重新填写。');
    } catch (error) {
      await this.store.setCurrentProviderId(provider.tool, previous);
      await this.scanCurrentProvidersFromConfig(); this.refreshStatus();
      throw error;
    }
  }

  private async restoreAppliedProxy(): Promise<void> {
    const synced = vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true);
    for (const tool of ['claude', 'codex'] as ToolId[]) {
      if (tool === 'codex' && this.sessionController.recoveryBlocked) continue;
      const recordKey = tool === 'claude' ? 'vscodemodelswitch.appliedProxy' : 'vscodemodelswitch.appliedCodexProxy';
      const record = structuredClone(this.context.workspaceState.get<AppliedProxyRecord>(this.environment.key(recordKey)) ?? this.context.workspaceState.get<AppliedProxyRecord>(recordKey));
      if (!record || (!synced && !this.context.workspaceState.get(this.environment.key(recordKey))) || record.provider.tool !== tool || !this.store.getProvider(record.provider.id)) continue;
      const current = await (tool === 'claude' ? this.claudeAdapter : this.codexAdapter).readActiveConfig().catch(() => ({} as { baseUrl?: string; key?: string }));
      if (synced && (current.baseUrl !== record.localUrl || managedProxyId(current.baseUrl, current.key) !== record.provider.id)) continue;
      try {
        const key = await this.secretStore.get(record.keyRef);
        if (key && !record.keyRef.startsWith(this.environment.key(''))) {
          const migratedRef = this.environment.key(SecretStore.ref(record.provider.id, tool) + '.applied');
          await this.secretStore.store(migratedRef, key);
          record.keyRef = migratedRef;
          await this.context.workspaceState.update(this.environment.key(recordKey), record);
        }
        if (!key) throw new Error('Applied proxy key is missing; Apply this provider again');
        const model = record.provider.modelPolicy.type === 'fixed' || record.provider.modelPolicy.type === 'custom' ? record.provider.modelPolicy.model : undefined;
        await this.proxyServer.start(record.port);
        const endpoint = await this.proxyServer.register(record.provider.id, record.provider.baseUrl, key, model, normalizeProxyConfig(record.provider.proxy, tool), tool);
        if (synced && endpoint.baseUrl !== record.localUrl) { endpoint.rollback?.(); throw new Error('Applied proxy port differs; Apply this provider again'); }
        this.appliedRevisions.set(record.provider.id, record.provider.updatedAt);
        if (!synced) {
          const local = { providerId: record.provider.id, providerName: record.provider.name, ...endpoint, model,
            configText: proxyClientConfig(record.provider.configText!, endpoint, tool), proxy: true };
          this.lastEnv = { ...this.lastEnv, ...this.envManager.apply({ missingSecrets: [], degraded: [],
            ...(tool === 'claude' ? { claude: local } : { codex: { ...local, codexProviderId: 'OpenAI', wireApi: 'responses' as const, mode: 'api' as const } }) }) };
        }
      } catch (error) {
        this.toolFailures[tool] = error instanceof Error ? error.message : 'Proxy restore failed';
        this.outputChannel.warn(`${tool} proxy restore failed: ${this.toolFailures[tool]}`);
      }
    }
  }

  async controlProxyFromSidebar(providerId: string, action: 'start' | 'stop' | 'restart' | 'log'): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider || provider.codexMode === 'official') throw new Error('API provider not found');
    this.ensureProviderEnabled(provider);
    if (action === 'log') { this.outputChannel.show(); return; }
    const canResume = this.proxyServer.runtime(providerId).localUrl;
    // Resuming/stopping an existing route also affects live client requests.
    // If Apply is needed it owns the confirmation, so this never asks twice.
    if (provider.tool === 'codex' && (action === 'stop' || canResume) && !await this.sessionController.confirmChange('更改当前 API Provider 的协议转换代理')) throw new Error('已取消：代理状态未更改。');
    if (action === 'stop' || action === 'restart') this.proxyServer.stopRoute(providerId);
    if (action === 'start' || action === 'restart') {
      if (!this.proxyServer.resumeRoute(providerId)) {
        if (this.appliedRevisions.has(providerId) && this.appliedRevisions.get(providerId) !== provider.updatedAt) throw new Error('Apply pending changes before starting this proxy');
        await this.activateProvider(provider, provider.tool === 'codex' && Boolean(canResume));
      }
      delete this.toolFailures[provider.tool];
    }
    await this.scanCurrentProvidersFromConfig(); this.refreshStatus();
  }

  private async resolveProvider(provider: ProviderProfile): Promise<{ key: string; baseUrl: string; model: string; configText: string } | undefined> {
    let key = provider.tool === 'codex' && provider.codexMode === 'official' ? '' : await this.secretStore.get(provider.secretRef);
    if (!key && provider.codexMode !== 'official') {
      return undefined;
    }
    const configText = provider.tool === 'codex' && provider.codexMode === 'official' ? '' : provider.configText ?? buildTemplate(provider.tool, provider.baseUrl, provider.modelPolicy.type === 'fixed' ? provider.modelPolicy.model : '');
    const values = configText ? extractConfigValues(provider.tool, configText) : { baseUrl: '', model: '', key: '' };
    return {
      key: key ?? '',
      baseUrl: values.baseUrl || provider.baseUrl,
      model: values.model,
      configText
    };
  }

  private async refreshModels(tool?: ToolId): Promise<void> {
    const tools: ToolId[] = tool ? [tool] : ['claude', 'codex'];
    const refreshed: string[] = [];
    const failed: string[] = [];

    for (const item of tools) {
      this.ensureToolEnabled(item);
      const provider = this.store.getCurrentProvider(item);
      if (!provider) {
        continue;
      }

      this.ensureProviderEnabled(provider);
      const key = await this.secretStore.get(provider.secretRef);
      if (!key) {
        this.toolFailures[item] = 'API key missing';
        failed.push(`${labelTool(item)} key missing`);
        continue;
      }

      try {
        const models = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `刷新 ${labelTool(item)} 模型列表`,
            cancellable: false
          },
          () => this.modelResolver.refresh(item, provider, key)
        );
        refreshed.push(`${labelTool(item)}: ${models.length}`);
        delete this.toolFailures[item];
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.toolFailures[item] = detail;
        failed.push(`${labelTool(item)} ${detail}`);
      }
    }

    if (failed.length > 0) {
      this.status = { kind: 'degraded', detail: failed.join('; ') };
      await this.scanCurrentProvidersFromConfig();
      this.refreshStatus();
      throw new Error(`模型刷新失败：${failed.join('; ')}`);
    } else {
      this.status = { kind: 'ready' };
      await this.scanCurrentProvidersFromConfig();
      this.refreshStatus();
    }
  }

  private async updateProviderModel(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) {
      throw new Error('未找到供应商。');
    }
    this.ensureProviderEnabled(provider);

    const key = await this.secretStore.get(provider.secretRef);
    if (!key) {
      throw new Error(`${labelTool(provider.tool)} key missing for ${provider.name}`);
    }

    if (provider.codexMode === 'official') throw new Error('Official Codex mode has no API model endpoint');
    const models = await this.fetchAndCacheModels(provider.tool, provider.baseUrl, key, provider.proxy);
    const model = await this.pickModel(provider.tool, models);
    if (!model) throw new Error('已取消：模型未更改。');

    const appliesNow = this.store.getCurrentProviderId(provider.tool) === provider.id;
    if (appliesNow && provider.tool === 'codex') {
      await this.sessionController.ensureMode(provider.codexMode ?? 'api');
      if (!await this.sessionController.confirmChange('修改并应用当前 Codex 模型')) throw new Error('已取消：模型未更改。');
    }
    await this.store.updateProvider(provider.id, (current) => ({
      ...current,
      modelPolicy: {
        type: 'fixed',
        model
      },
      configText: current.configText ? setConfigModel(current.tool, current.configText, model) : current.configText,
      updatedAt: new Date().toISOString()
    }));
    this.clearProviderDiagnostics(provider.id);

    if (appliesNow) {
      try { await this.applyProvider(provider.tool, provider.tool === 'codex'); }
      catch (error) { await this.store.upsertProvider(provider); this.refreshStatus(); throw error; }
    } else {
      this.refreshStatus();
    }
  }

  private async openClaudeTerminal(): Promise<void> {
    const env = Object.fromEntries(Object.entries(this.lastEnv).filter(([name]) => !name.startsWith('OPENAI_')));
    this.terminalManager.openClaude({ ...env, ...this.networkProxy.environment('claude') });
  }

  private async openCodexTerminal(): Promise<void> {
    this.sessionController.assertReady();
    const env = Object.fromEntries(Object.entries(this.lastEnv).filter(([key]) => key.startsWith('OPENAI_')));
    this.terminalManager.openCodex({ ...env, ...this.networkProxy.environment('codex') });
  }

  private async viewConfig(tool: ToolId): Promise<void> {
    const files = tool === 'claude' ? [this.claudeAdapter.getConfigPath()] : [this.codexAdapter.getConfigPath()];
    if (tool === 'codex' && (await this.codexAdapter.readMode()) === 'official') {
      const selected = await vscode.window.showQuickPick([
        { label: 'config.toml · 客户端配置', files },
        { label: 'auth.json · 敏感认证缓存', files: [this.codexAdapter.getAuthPath()] },
        { label: '同时打开配置与认证缓存', files: [...files, this.codexAdapter.getAuthPath()] }
      ], { title: '打开当前环境文件（认证文件包含敏感信息）' });
      if (!selected) throw new Error('已取消：未打开配置。');
      files.splice(0, files.length, ...selected.files);
    }
    for (const file of files) {
      if (!await pathExists(file)) { void vscode.window.showInformationMessage('文件尚未创建：' + file); continue; }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }
  private async manageHistoryBackups(remove: boolean): Promise<void> {
    const root = (await this.sessionController.state()).root;
    if (!root) throw new Error('请先连接数据目录。');
    const parent = join(root, 'backups'), backups = await historyBackups(parent);
    if (!backups.length) throw new Error('尚无历史备份。');
    const choices = backups.map(backup => ({ label: backup.name, description: backup.createdAt + ' · ' + (backup.bytes / 1048576).toFixed(2) + ' MiB · ' + (backup.complete ? '完整快照' : '未完成'), detail: backup.directory, backup }));
    if (remove) {
      const selected = await vscode.window.showQuickPick(choices, { title: '选择要删除的历史备份', canPickMany: true });
      if (!selected?.length) throw new Error('已取消：未删除备份。');
      const answer = await vscode.window.showWarningMessage('删除以下 ' + selected.length + ' 份历史备份？活动聊天历史不变。\n' + selected.map(x => x.label + ' · ' + x.description).join('\n'), { modal: true }, { title: '删除所选备份' }, { title: '取消', isCloseAffordance: true });
      if (answer?.title !== '删除所选备份') throw new Error('已取消：未删除备份。');
      for (const item of selected) await removeHistoryBackup(parent, item.backup);
    } else {
      const selected = await vscode.window.showQuickPick(choices, { title: '浏览历史备份' });
      if (!selected || !await browseFiles(selected.backup.directory, '浏览历史备份')) throw new Error('已取消：未打开备份。');
    }
  }

  private codexPublicConfig(): PublicConfigFile {
    return { version: 2, organizations: { codex: this.codexOrganization?.read() ?? emptyOrganization() }, providers: this.store.getProvidersByTool('codex').filter(p => p.codexMode !== 'official').map(p => ({ ...p, baseUrl: publicEndpoint(p.baseUrl), configText: p.configText ? redactConfigText('codex', p.configText) : p.configText })) };
  }
  private async exportCodexProviders(): Promise<void> {
    const state = await this.sessionController.state();
    if (!state.root || state.legacy) throw new Error('请先连接数据目录。');
    const directory = join(state.root, 'providers'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'codex-public-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    await fs.writeFile(file, JSON.stringify(this.codexPublicConfig(), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }

  private async exportPublicConfig(tool?: ToolId): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      title: tool === 'codex' ? '另存为供应商配置' : '导出供应商配置',
      filters: { JSON: ['json'] },
      saveLabel: '导出'
    });
    if (!uri) throw new Error('已取消：文件操作未执行。');

    const config: PublicConfigFile = tool === 'codex' ? this.codexPublicConfig() : tool === 'claude' ? { version: 1, providers: this.store.getProvidersByTool('claude').map(p => ({ ...p, configText: p.configText ? redactConfigText('claude', p.configText) : p.configText })) } : {
      version: 1,
      currentProviderIds: this.store.getCurrentProviderIds(),
      providers: this.store.getProviders()
    };
    await fs.writeFile(uri.fsPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    void vscode.window.showInformationMessage('供应商配置已导出，不包含已保存的 API 密钥。');
  }

  private async importPublicConfig(tool?: ToolId): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: '导入供应商配置',
      canSelectMany: false,
      filters: { JSON: ['json'] },
      openLabel: '导入'
    });
    const uri = uris?.[0];
    if (!uri) throw new Error('已取消：文件操作未执行。');

    const parsed = JSON.parse(await fs.readFile(uri.fsPath, 'utf8')) as PublicConfigFile;
    if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.providers)) {
      throw new Error('不支持的配置文件。');
    }

    const mode = await vscode.window.showQuickPick(
      [
        { label: '合并', description: '保留现有供应商并添加导入的供应商', value: 'merge' },
        { label: '替换', description: '替换当前工具范围内的供应商定义', value: 'replace' }
      ],
      { title: '选择导入方式' }
    );
    if (!mode) throw new Error('已取消：未导入配置。');

    const imported = parsed.providers.filter(provider => !tool || provider.tool === tool).map((provider) => ({
      ...provider,
      secretRef: this.store.getProvider(provider.id)?.tool === provider.tool ? this.store.getProvider(provider.id)!.secretRef : SecretStore.ref(provider.id, provider.tool),
      name: provider.name.trim(),
      configText: provider.configText ? redactConfigText(provider.tool, provider.configText) : provider.configText,
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      proxy: normalizeProxyConfig(provider.proxy, provider.tool)
    }));
    const previousProviders = this.store.getProviders();
    let providers: ProviderProfile[];
    if (mode.value === 'replace') {
      for (const provider of imported) if (tool && previousProviders.some(p => p.id === provider.id && p.tool !== tool)) throw new Error('导入 ID 与另一客户端供应商冲突。');
      providers = tool ? [...previousProviders.filter(p => p.tool !== tool), ...imported] : imported;
    } else {
      providers = [...previousProviders];
      for (const provider of imported) {
        const index = providers.findIndex(p => p.id === provider.id);
        if (index >= 0 && providers[index].tool !== provider.tool) throw new Error('导入 ID 与另一客户端供应商冲突。');
        if (index >= 0) providers[index] = provider; else providers.push(provider);
      }
    }
    validateImportedNames(providers);
    const previousOrganization = this.codexOrganization?.read() ?? emptyOrganization();
    const nextOrganization = tool !== 'claude' ? importOrganization(previousOrganization, parsed.version === 2 ? parsed.organizations?.codex : undefined, mode.value as 'merge' | 'replace', imported.filter(p => p.tool === 'codex').map(p => p.id), providers.filter(p => p.tool === 'codex').map(p => p.id), 'codex') : undefined;
    try {
      await this.store.saveProviders(providers);
      if (nextOrganization) await this.codexOrganization.save(nextOrganization);
    } catch (error) {
      try { await this.store.saveProviders(previousProviders); if (nextOrganization) await this.codexOrganization.save(previousOrganization); }
      catch { throw new Error('供应商导入失败，定义恢复未完成；请保留原导出文件并检查存储状态。'); }
      throw error;
    }
    // Current selections, disabled states and all CLI files are intentionally untouched.

    this.status = { kind: 'missingKey', detail: 'Imported provider metadata does not include API keys.' };
    this.refreshStatus();
    void vscode.window.showInformationMessage('供应商配置已导入，请在当前环境补充 API 密钥。');
  }

  private async fetchAndCacheModels(tool: ToolId, baseUrl: string, key: string, proxy?: ProxyConfig): Promise<ModelInfo[]> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `获取 ${labelTool(tool)} 模型列表`,
        cancellable: true
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          const normalized = baseUrl.trim().replace(/\/+$/g, '');
          const models = await fetchModels(tool, normalized, key, controller.signal, proxy);
          await this.store.saveModelCache({
            tool,
            baseUrl: normalized,
            keyFingerprint: fingerprintSecret(key),
            fetchedAt: new Date().toISOString(),
            ttlMs: 24 * 60 * 60 * 1000,
            models
          });
          return models;
        } catch (error) {
          const detail = error instanceof Error && 'causeText' in error && typeof error.causeText === 'string'
            ? `${error.message}: ${error.causeText}`
            : error instanceof Error ? error.message : String(error);
          this.outputChannel.warn(`model-fetch ${tool} ${baseUrl}: ${detail}`);
          throw error;
        } finally {
          cancellation.dispose();
        }
      }
    );
  }

  private async pickModel(tool: ToolId, models: ModelInfo[]): Promise<string | undefined> {
    if (models.length === 0) {
      void vscode.window.showWarningMessage(`${labelTool(tool)} 返回的模型列表为空。`);
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: model.id,
        description: model.displayName,
        model
      })),
      { title: `选择 ${labelTool(tool)} 模型` }
    );
    return selected?.model.id;
  }

  private async promptRequiredInput(title: string, placeHolder: string, password = false): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title,
      placeHolder,
      password,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '此项必填')
    });
  }

  private ensureToolEnabled(tool: ToolId): void {
    if (!this.store.getToolEnabled(tool)) throw new Error(`${labelTool(tool)} 配置管理已停用`);
  }
}

function labelTool(tool: ToolId): string {
  return tool === 'claude' ? 'Claude Code' : 'Codex';
}

function labelModel(policy: ModelPolicy): string {
  if (policy.type === 'toolDefault') {
    return 'NULL';
  }
  if (policy.type === 'providerAuto') {
    return policy.preferred ? `Auto: ${policy.preferred}` : 'NULL';
  }
  return policy.model || 'NULL';
}

function statusFromResolved(resolved: ResolvedProvider): StatusState {
  if (resolved.missingSecrets.length > 0) {
    return {
      kind: 'missingKey',
      detail: `Missing keys: ${resolved.missingSecrets.join(', ')}`
    };
  }
  if (resolved.degraded.length > 0) {
    return {
      kind: 'degraded',
      detail: resolved.degraded.join('; ')
    };
  }
  return { kind: 'ready' };
}

async function matchProviderFromConfig(
  providers: ProviderProfile[],
  tool: ToolId,
  baseUrl: string | undefined,
  key: string | undefined,
  secretStore: SecretStore
): Promise<ProviderProfile | undefined> {
  if (!baseUrl || !key) {
    return undefined;
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const matches: ProviderProfile[] = [];
  for (const provider of providers) {
    if (provider.tool !== tool || normalizeBaseUrl(provider.baseUrl) !== normalizedBaseUrl) continue;
    if (await secretStore.get(provider.secretRef) === key) matches.push(provider);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeUrl(value: string): string {
  return normalizeBaseUrl(value);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, '').replace(/\/v1$/i, '');
}

function normalizeProviderName(name: string): string { return normalizedName(name); }

function validateImportedNames(providers: ProviderProfile[]): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider || !['codex', 'claude'].includes(provider.tool) || typeof provider.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(provider.id) || typeof provider.name !== 'string' || !provider.name.trim()) throw new Error('供应商名称、ID 或客户端类型无效。');
    const key = `${provider.tool}:${normalizeProviderName(provider.name)}`;
    if (seen.has(key)) throw new Error(`导入的供应商名称重复：${provider.name}`);
    seen.add(key);
  }
}

// Portable exports deliberately omit opaque templates, custom headers and usage
// URLs: those fields may embed credentials outside the standard key slot.
function publicEndpoint(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return ''; }
}
