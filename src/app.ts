import * as fs from 'fs/promises';
import { basename, dirname } from 'path';
import * as vscode from 'vscode';
import { ClaudeAdapter } from './adapters/claudeAdapter';
import { CodexAdapter } from './adapters/codexAdapter';
import { deleteBackups, directorySize, getBackupDirectory, pathExists } from './config/atomicWrite';
import { buildTemplate, extractConfigValues, redactConfigText, setConfigModel, validateConfigText } from './config/templates';
import { fetchModels, testModelsEndpoint } from './models/modelFetcher';
import { defaultUsageQuery, queryUsage } from './models/usageQuery';
import { verifyModel } from './models/compatibilityCheck';
import { ModelResolver } from './models/modelResolver';
import { ProviderStore } from './storage/providerStore';
import { SecretStore } from './storage/secretStore';
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
  private readonly secretStore: SecretStore;
  private readonly modelResolver: ModelResolver;
  private readonly envManager: EnvManager;
  private readonly terminalManager = new TerminalManager();
  private readonly statusBar = new StatusBarController();
  private outputChannel: vscode.LogOutputChannel;
  private readonly claudeAdapter = new ClaudeAdapter();
  private readonly codexAdapter = new CodexAdapter();
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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('VSCodeModelSwitch', { log: true });
    this.proxyServer = new ProxyServer(() => { if (!this.disposed) this.refreshStatus(); }, message => { if (!this.disposed) this.outputChannel.info(message); });
    this.store = new ProviderStore(context);
    for (const [id, revision] of Object.entries(context.workspaceState.get<Record<string, string>>('vscodemodelswitch.appliedRevisions', {}))) this.appliedRevisions.set(id, revision);
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
    void this.initializeCurrentProviders();
  }

  dispose(): void {
    this.disposed = true;
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
          try {
            await handler();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`VSCodeModelSwitch: ${message}`);
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
  }

  async getSidebarState(): Promise<SidebarViewState> {
    const providers = await Promise.all(
      this.store.getProviders().map((provider) =>
        toSidebarSummary(provider, async (item) => item.codexMode === 'official' || Boolean(await this.secretStore.get(item.secretRef)), this.networkTests.get(provider.id), this.usageResults.get(provider.id), this.compatibilityResults.get(provider.id), this.proxyServer.runtime(provider.id), this.appliedRevisions.has(provider.id) && this.appliedRevisions.get(provider.id) !== provider.updatedAt)
      )
    );
    const [logBytes, claudeBackupBytes, codexBackupBytes] = await Promise.all([
      directorySize(this.context.logUri.fsPath),
      directorySize(getBackupDirectory(this.claudeAdapter.getConfigPath())),
      directorySize(getBackupDirectory(this.codexAdapter.getConfigPath()))
    ]);
    const codexMode = await this.codexAdapter.readMode().catch(() => 'unknown' as const);

    return {
      providers,
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
    await this.initializeCurrentProviders();
  }

  async setToolEnabledFromSidebar(tool: ToolId, enabled: boolean): Promise<void> {
    await this.store.setToolEnabled(tool, enabled);
    this.refreshStatus();
  }

  async testProviderNetworkFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
    if (provider.tool === 'codex' && provider.codexMode === 'official') throw new Error('Official Codex mode has no API endpoint to test');
    const key = await this.secretStore.get(provider.secretRef);
    if (!key) throw new Error('Unable to identify API key; enter it again');
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${provider.name}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          const network = await testModelsEndpoint(provider.tool, provider.baseUrl, key, controller.signal, provider.proxy);
          let usage: UsageQueryResult | undefined;
          if (provider.usageQuery?.enabled && !network.cancelled && !token.isCancellationRequested) {
            const usageToken = await this.secretStore.get(SecretStore.usageRef(provider.id));
            usage = await queryUsage(provider.usageQuery, provider.baseUrl, key, usageToken, controller.signal);
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
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async testToolNetworkFromSidebar(tool: ToolId): Promise<void> {
    this.ensureToolEnabled(tool);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing all ${labelTool(tool)} providers`, cancellable: true },
      async (progress, token) => {
        const providers = this.store.getProvidersByTool(tool);
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
                const usage = await queryUsage(provider.usageQuery, provider.baseUrl, key, usageToken, controller.signal);
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
    if (tool === 'claude' && managedProxyId(runtime.baseUrl, 'vscodemodelswitch-local') === runtime.matchedProviderId && runtime.matchedProviderId) {
      const proxy = this.proxyServer.runtime(runtime.matchedProviderId);
      if (proxy.state !== 'running' || proxy.lastRequest?.ok === false) status = 'degraded';
    }
      if (status === 'off' || status === 'unactivated') {
        return { tool, status };
      }
      return {
        tool,
        providerName: runtime.providerName,
        model: runtime.model,
        status
      };
    });
  }

  async previewModelsFromSidebar(tool: ToolId, baseUrl: string, key: string, proxy?: ProxyConfig): Promise<ModelInfo[]> {
    this.ensureToolEnabled(tool);
    if (!baseUrl.trim() || !key) {
      throw new Error('URL and key are required before fetching models');
    }
    return this.fetchAndCacheModels(tool, baseUrl.trim(), key, normalizeProxyConfig(proxy, tool));
  }

  async createProviderFromSidebar(input: CreateProviderInput): Promise<void> {
    await this.createProvider(input);
  }

  async setCurrentProviderFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }
    this.ensureToolEnabled(provider.tool);
    await this.activateProvider(provider);
  }

  async getProviderConfigFromSidebar(providerId: string): Promise<{ providerId: string; tool: ToolId; text: string; hasKey: boolean; usageQuery: UsageQueryConfig; usageHasToken: boolean; proxy: ProxyConfig; codexMode?: CodexMode }> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
    return {
      providerId,
      tool: provider.tool,
      text: provider.tool === 'codex' && provider.codexMode === 'official' ? '' : provider.configText ?? buildTemplate(provider.tool, provider.baseUrl, provider.modelPolicy.type === 'fixed' ? provider.modelPolicy.model : ''),
      hasKey: provider.codexMode === 'official' ? true : Boolean(await this.secretStore.get(provider.secretRef)),
      usageQuery: provider.usageQuery ?? defaultUsageQuery(provider.baseUrl),
      usageHasToken: Boolean(await this.secretStore.get(SecretStore.usageRef(provider.id))),
      proxy: provider.proxy ?? { mode: 'direct', preset: 'justdowork' },
      codexMode: provider.tool === 'codex' ? (provider.codexMode ?? 'api') : undefined
    };
  }

  async saveProviderConfigFromSidebar(providerId: string, text: string, key?: string, usageQuery?: UsageQueryConfig, usageAccessToken?: string, proxy?: ProxyConfig, codexMode?: CodexMode): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
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
    if (!values.baseUrl) throw new Error('Base URL is required');
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
      void vscode.window.showWarningMessage(`${provider.name} was saved without a model. Configure a model before using Verify Model.`);
    }
    this.clearProviderDiagnostics(provider.id);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async applyProviderFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
    await this.activateProvider(provider);
  }

  async applyCodexModeFromSidebar(mode: CodexMode): Promise<void> {
    this.ensureToolEnabled('codex');
    if (mode === 'official') {
      await this.codexAdapter.applyOfficialMode();
      this.lastEnv = this.envManager.apply({
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
      });
      delete this.toolFailures.codex;
      await this.scanCurrentProvidersFromConfig();
      this.refreshStatus();
      return;
    }

    const current = this.store.getCurrentProvider('codex');
    const provider = current?.codexMode !== 'official'
      ? current
      : this.store.getProvidersByTool('codex').find(item => item.codexMode !== 'official');
    if (!provider) {
      throw new Error('Add a Codex API provider before applying API mode');
    }
    await this.activateProvider(provider);
  }

  async testUsageQueryFromSidebar(providerId: string, usageQuery: UsageQueryConfig, usageAccessToken?: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
    const key = provider.codexMode === 'official' ? '' : await this.secretStore.get(provider.secretRef);
    if (!key) throw new Error('Unable to identify API key; enter it again');
    const storedUsageToken = usageAccessToken?.trim() || await this.secretStore.get(SecretStore.usageRef(provider.id));
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Querying usage for ${provider.name}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          return await queryUsage(usageQuery, provider.baseUrl, key, storedUsageToken, controller.signal);
        } finally {
          cancellation.dispose();
        }
      }
    );
    if (result.error !== 'Cancelled') this.usageResults.set(provider.id, result);
    this.logDiagnostic('usage', provider, result);
    this.refreshStatus();
  }

  async verifyProviderModelFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
    if (provider.tool === 'codex' && provider.codexMode === 'official') throw new Error('Official Codex mode has no API model verification');
    const key = await this.secretStore.get(provider.secretRef);
    if (!key) throw new Error('Unable to identify API key; enter it again');
    const model = provider.modelPolicy.type === 'fixed' || provider.modelPolicy.type === 'custom'
      ? provider.modelPolicy.model
      : provider.modelPolicy.type === 'providerAuto' ? provider.modelPolicy.preferred ?? '' : '';
    if (!model) throw new Error('Model is required');
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Verifying ${provider.name}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const probeId = provider.id + '--verify-' + randomUUID();
        try {
          const endpoint = provider.proxy?.mode === 'proxy' ? await this.proxyServer.register(probeId, provider.baseUrl, key, model, normalizeProxyConfig(provider.proxy, provider.tool)) : { baseUrl: provider.baseUrl, key };
          return await verifyModel(provider.tool, endpoint.baseUrl, endpoint.key, model, controller.signal, provider.proxy?.mode === 'proxy' ? provider.proxy : undefined);
        } finally {
          if (provider.proxy?.mode === 'proxy') this.proxyServer.remove(probeId);
          cancellation.dispose();
        }
      }
    );
    if (!result.cancelled) this.compatibilityResults.set(provider.id, result);
    this.logDiagnostic('compatibility', provider, result);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async deleteProviderFromSidebar(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('Provider not found');
    this.ensureToolEnabled(provider.tool);
    const confirmation = await vscode.window.showWarningMessage(
      `Delete ${provider.name}? The stored API key will also be deleted. Applied config files will be kept.`,
      { modal: true },
      'Delete'
    );
    if (confirmation !== 'Delete') return;
    await this.secretStore.delete(provider.secretRef);
    await this.secretStore.delete(SecretStore.usageRef(provider.id));
    await this.secretStore.delete(SecretStore.ref(provider.id, provider.tool) + '.applied');
    await this.store.deleteProvider(providerId);
    this.proxyServer.remove(providerId);
    this.appliedRevisions.delete(providerId);
    this.clearProviderDiagnostics(providerId);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
  }

  async moveProviderFromSidebar(providerId: string, beforeProviderId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    const target = this.store.getProvider(beforeProviderId);
    if (!provider || !target || provider.tool !== target.tool) throw new Error('Providers must belong to the same tool');
    this.ensureToolEnabled(provider.tool);
    await this.store.moveProvider(providerId, beforeProviderId);
    this.refreshStatus();
  }

  async deleteBackupsFromSidebar(tool: ToolId): Promise<void> {
    this.ensureToolEnabled(tool);
    const path = tool === 'claude' ? this.claudeAdapter.getConfigPath() : this.codexAdapter.getConfigPath();
    const count = await vscode.window.showWarningMessage(
      `Delete all ${labelTool(tool)} backups?`,
      { modal: true },
      'Delete'
    );
    if (count !== 'Delete') return;
    await deleteBackups(path);
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
        throw new Error('A provider with this name already exists');
      }
      const existingKey = await this.secretStore.get(provider.secretRef);
      if (existingKey !== key) continue;
      keyAlreadySaved = true;
      if (provider.tool === tool && normalizeBaseUrl(provider.baseUrl) === normalizeBaseUrl(baseUrl)) {
        throw new Error('A provider with this Base URL and API key already exists');
      }
    }
    if (keyAlreadySaved) void vscode.window.showWarningMessage('This API key is already saved by another provider.');
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

  async exportPublicConfigFromSidebar(): Promise<void> {
    await this.exportPublicConfig();
  }

  async importPublicConfigFromSidebar(): Promise<void> {
    await this.importPublicConfig();
  }

  async clearLogFromSidebar(): Promise<boolean> {
    const confirmation = await vscode.window.showWarningMessage(
      'Clear the VSCodeModelSwitch output log for this session?',
      { modal: true },
      'Delete Log'
    );
    if (confirmation !== 'Delete Log') return false;
    this.outputChannel.dispose();
    try {
      const entries = await fs.readdir(this.context.logUri.fsPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        await fs.unlink(vscode.Uri.joinPath(this.context.logUri, entry.name).fsPath);
      }
    } finally {
      this.outputChannel = vscode.window.createOutputChannel('VSCodeModelSwitch', { log: true });
    }
    return true;
  }

  private refreshStatus(): void {
    this.statusBar.update(this.runtimeState);
    void this.sidebarView.refresh();
  }

  private async initializeCurrentProviders(): Promise<void> {
    const firstInitialization = !this.restoreAttempted;
    if (!this.restoreAttempted) {
      this.restoreAttempted = true;
      await this.restoreAppliedProxy();
    }
    await this.scanCurrentProvidersFromConfig();
    if (firstInitialization) {
      for (const provider of Object.values(this.store.getCurrentProviders())) {
        if (provider && !this.appliedRevisions.has(provider.id)) this.appliedRevisions.set(provider.id, provider.updatedAt);
      }
      await this.context.workspaceState.update('vscodemodelswitch.appliedRevisions', Object.fromEntries(this.appliedRevisions));
    }
    const hasCurrent = Boolean(this.store.getCurrentProvider('claude') || this.store.getCurrentProvider('codex'));
    this.status = hasCurrent ? { kind: 'ready' } : { kind: 'off' };
    this.refreshStatus();
  }

  private async scanCurrentProvidersFromConfig(): Promise<void> {
    const providers = this.store.getProviders();
    const [claudeConfig, codexConfig]: [
      { baseUrl?: string; model?: string; key?: string },
      { baseUrl?: string; model?: string; providerId?: string; key?: string; mode?: CodexMode | 'unknown' }
    ] = await Promise.all([
      this.claudeAdapter.readActiveConfig().catch(() => ({})),
      this.codexAdapter.readActiveConfig().catch(() => ({}))
    ]);

    const localId = managedProxyId(claudeConfig.baseUrl, claudeConfig.key);
    const synced = vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true);
    const claude = !synced ? this.store.getCurrentProvider('claude') : localId ? providers.find(p => p.tool === 'claude' && p.id === localId) : await matchProviderFromConfig(providers, 'claude', claudeConfig.baseUrl, claudeConfig.key, this.secretStore);
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

    const codex = !synced ? this.store.getCurrentProvider('codex') : codexConfig.mode === 'official'
      ? providers.find(provider => provider.tool === 'codex' && provider.codexMode === 'official')
      : await matchProviderFromConfig(providers, 'codex', codexConfig.baseUrl, codexConfig.key, this.secretStore);
    if (codex) {
      await this.store.setCurrentProviderId('codex', codex.id);
    } else {
      await this.store.setCurrentProviderId('codex', undefined);
    }
    this.runtimeState.codex = {
      tool: 'codex',
      providerName: codex?.name,
      baseUrl: codexConfig.baseUrl,
      model: codexConfig.model,
      matchedProviderId: codex?.id,
      status: await this.determineToolStatus('codex', providers, codex, codexConfig.baseUrl, codexConfig.key),
      configPath: this.codexAdapter.getConfigPath()
    };
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
    this.outputChannel.info(`${kind} ${provider.tool}/${provider.name}: ${JSON.stringify(result)}`);
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
      { label: 'Switch Provider', action: 'switchProvider' },
      { label: 'Add Provider', action: 'addProvider' },
      { label: 'Open Claude Terminal', action: 'openClaudeTerminal' },
      { label: 'Open Codex Terminal', action: 'openCodexTerminal' },
      { label: 'View Claude Config', action: 'viewClaudeConfig' },
      { label: 'View Codex Config', action: 'viewCodexConfig' },
      { label: 'Export Public Config', action: 'exportPublicConfig' },
      { label: 'Import Public Config', action: 'importPublicConfig' }
    ];
    const action = await vscode.window.showQuickPick(items, { placeHolder: 'VSCodeModelSwitch' });
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
      { title: 'Provider Type' }
    );
    if (!toolPick) {
      return;
    }

    const name = await this.promptRequiredInput('Provider Name', 'OpenRouter, DeepSeek, Work Proxy');
    const baseUrl = await this.promptRequiredInput(`${toolPick.label} Base URL`, 'https://api.example.com');
    const key = await this.promptRequiredInput(`${toolPick.label} API Key`, 'sk-...', true);
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
    if (!input.name.trim()) {
      throw new Error('Provider name is required');
    }
    const configMode = input.configMode ?? 'generated';
    const codexMode = input.tool === 'codex' ? (input.codexMode ?? 'api') : undefined;
    const proxy = normalizeProxyConfig(input.proxy, input.tool);
    const configText = codexMode === 'official' ? '' : input.configText ?? buildTemplate(input.tool, input.baseUrl.trim(), input.model.trim());
    if (!(input.tool === 'codex' && codexMode === 'official')) validateConfigText(input.tool, configText);
    const values = codexMode === 'official' ? { baseUrl: '', model: '', key: '' } : extractConfigValues(input.tool, configText);
    const key = input.key.trim() || values.key;
    if (codexMode !== 'official' && !values.baseUrl) throw new Error('Base URL is required');
    if (codexMode !== 'official' && !key) throw new Error('Unable to identify API key; enter it again');
    if (codexMode !== 'official') await this.validateProviderUniqueness(input.tool, input.name, values.baseUrl, key);

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
    if (!values.model && codexMode !== 'official') {
      void vscode.window.showWarningMessage(`${input.name.trim()} was saved without a model. Configure a model before using Verify Model.`);
    }

    if (input.applyNow) {
      const previousProviderId = this.store.getCurrentProviderId(input.tool);
      await this.store.setCurrentProviderId(input.tool, provider.id);
      try {
        const result = await this.applyProvider(input.tool);
        if (result?.missingSecrets.length) throw new Error('Unable to identify API key; enter it again');
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
      { title: 'Switch Tool Provider' }
    );
    if (!toolPick) {
      return;
    }

    const providers = this.store.getProvidersByTool(toolPick.tool);
    if (providers.length === 0) {
      void vscode.window.showInformationMessage(`No ${toolPick.label} providers yet. Add one first.`);
      return;
    }

    const currentId = this.store.getCurrentProviderId(toolPick.tool);
    const selected = await vscode.window.showQuickPick(
      providers.map((provider) => ({
        label: provider.name,
        description: labelModel(provider.modelPolicy),
        detail: provider.id === currentId ? 'current' : provider.baseUrl,
        provider
      })),
      { title: `Switch ${toolPick.label} Provider` }
    );
    if (!selected) {
      return;
    }

    await this.activateProvider(selected.provider);
    void vscode.window.showInformationMessage(`${toolPick.label} provider applied. Restart existing clients to use it.`);
  }

  private async applyProviderWithMessage(tool: ToolId): Promise<void> {
    const result = await this.applyProvider(tool);
    if (!result) {
      return;
    }

    if (result.missingSecrets.length > 0) {
      void vscode.window.showWarningMessage(`Provider applied with missing keys: ${result.missingSecrets.join(', ')}`);
      return;
    }
    if (result.degraded.length > 0) {
      void vscode.window.showWarningMessage(`Provider applied with issues: ${result.degraded.join('; ')}`);
      return;
    }
    void vscode.window.showInformationMessage(`${labelTool(tool)} provider applied to new terminals and CLI config.`);
  }

  private async applyProvider(tool: ToolId): Promise<ResolvedProvider | undefined> {
    this.ensureToolEnabled(tool);
    const provider = this.store.getCurrentProvider(tool);
    if (!provider) {
      this.status = { kind: 'off' };
      this.refreshStatus();
      void vscode.window.showInformationMessage(`No active ${labelTool(tool)} provider.`);
      return undefined;
    }

    const resolved: ResolvedProvider = {
      missingSecrets: [],
      degraded: []
    };
    const value = await this.resolveProvider(provider);
    const config = normalizeProxyConfig(provider.proxy, tool);
    let rollback: (() => void) | undefined;
    if (!value) {
      resolved.missingSecrets.push(tool);
    } else if (tool === 'claude') {
      if (config.mode === 'proxy') {
        const endpoint = await this.proxyServer.register(provider.id, value.baseUrl, value.key, value.model, config);
        rollback = endpoint.rollback;
        resolved.claude = { providerId: provider.id, providerName: provider.name, ...endpoint, model: value.model, configText: proxyClientConfig(value.configText, endpoint), proxy: true };
      } else resolved.claude = { providerId: provider.id, providerName: provider.name, baseUrl: value.baseUrl, key: value.key, model: value.model, configText: value.configText };
    } else {
      resolved.codex = { providerId: provider.id, providerName: provider.name, baseUrl: value.baseUrl, key: value.key, model: value.model, codexProviderId: 'OpenAI', wireApi: 'responses', configText: value.configText, mode: provider.codexMode ?? 'api' };
    }

    const previousRevisions = this.context.workspaceState.get<Record<string, string>>('vscodemodelswitch.appliedRevisions', {});
    const previousProxyRecord = this.context.workspaceState.get<AppliedProxyRecord>('vscodemodelswitch.appliedProxy');
    let appliedKeyRef: string | undefined;
    let previousAppliedKey: string | undefined;
    try {
      // Finish fallible metadata/key storage before changing the user's config file.
      if (!resolved.missingSecrets.length) {
        if (tool === 'claude') {
          if (resolved.claude?.proxy) {
            appliedKeyRef = SecretStore.ref(provider.id, tool) + '.applied';
            previousAppliedKey = await this.secretStore.get(appliedKeyRef);
            await this.secretStore.store(appliedKeyRef, value!.key);
            await this.context.workspaceState.update('vscodemodelswitch.appliedProxy', { provider: structuredClone(provider), port: this.proxyServer.getPort(), localUrl: resolved.claude.baseUrl, keyRef: appliedKeyRef });
          } else await this.context.workspaceState.update('vscodemodelswitch.appliedProxy', undefined);
        }
        await this.context.workspaceState.update('vscodemodelswitch.appliedRevisions', { ...previousRevisions, [provider.id]: provider.updatedAt });
      }
      if (resolved.missingSecrets.length === 0 && vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true)) {
        if (tool === 'claude') await this.claudeAdapter.apply(resolved);
        else await this.codexAdapter.apply(resolved);
      }
    } catch (error) {
      rollback?.();
      try {
        await this.context.workspaceState.update('vscodemodelswitch.appliedRevisions', previousRevisions);
        if (tool === 'claude') await this.context.workspaceState.update('vscodemodelswitch.appliedProxy', previousProxyRecord);
        if (appliedKeyRef) {
          if (previousAppliedKey === undefined) await this.secretStore.delete(appliedKeyRef);
          else await this.secretStore.store(appliedKeyRef, previousAppliedKey);
        }
      } catch { this.outputChannel.warn('Apply failed; applied metadata could not be restored. The prior client config was not rewritten.'); }
      throw error;
    }
    if (!resolved.missingSecrets.length) {
      if (resolved.claude && !resolved.claude.proxy) for (const name of ['ANTHROPIC_API_KEY', 'ENABLE_TOOL_SEARCH', 'ANTHROPIC_MODEL']) delete this.lastEnv[name];
      this.lastEnv = this.envManager.apply(resolved);
      this.appliedRevisions.set(provider.id, provider.updatedAt);
      delete this.toolFailures[tool];
      if (tool === 'claude' && !resolved.claude?.proxy) this.proxyServer.stopRoute(provider.id);
    }

    this.status = statusFromResolved(resolved);
    await this.scanCurrentProvidersFromConfig();
    this.refreshStatus();
    return resolved;
  }

  private async activateProvider(provider: ProviderProfile): Promise<void> {
    const previous = this.store.getCurrentProviderId(provider.tool);
    await this.store.setCurrentProviderId(provider.tool, provider.id);
    try {
      const result = await this.applyProvider(provider.tool);
      if (result?.missingSecrets.length) throw new Error('Unable to identify API key; enter it again');
    } catch (error) {
      await this.store.setCurrentProviderId(provider.tool, previous);
      await this.scanCurrentProvidersFromConfig(); this.refreshStatus();
      throw error;
    }
  }

  private async restoreAppliedProxy(): Promise<void> {
    const record = this.context.workspaceState.get<AppliedProxyRecord>('vscodemodelswitch.appliedProxy');
    if (!record || !this.store.getProvider(record.provider.id)) return;
    const current = await this.claudeAdapter.readActiveConfig().catch(() => ({} as { baseUrl?: string; key?: string }));
    const synced = vscode.workspace.getConfiguration('vscodemodelswitch').get<boolean>('globalCliSync', true);
    if (synced && (current.baseUrl !== record.localUrl || managedProxyId(current.baseUrl, current.key) !== record.provider.id)) return;
    try {
      const key = await this.secretStore.get(record.keyRef);
      if (!key) throw new Error('Applied proxy key is missing; Apply this provider again');
      const model = record.provider.modelPolicy.type === 'fixed' || record.provider.modelPolicy.type === 'custom' ? record.provider.modelPolicy.model : undefined;
      await this.proxyServer.start(record.port);
      const endpoint = await this.proxyServer.register(record.provider.id, record.provider.baseUrl, key, model, normalizeProxyConfig(record.provider.proxy, 'claude'));
      this.appliedRevisions.set(record.provider.id, record.provider.updatedAt);
      if (!synced) this.lastEnv = this.envManager.apply({ missingSecrets: [], degraded: [], claude: { providerId: record.provider.id, providerName: record.provider.name, ...endpoint, model, configText: proxyClientConfig(record.provider.configText!, endpoint), proxy: true } });
    } catch (error) {
      this.toolFailures.claude = error instanceof Error ? error.message : 'Proxy restore failed';
      this.outputChannel.warn(`proxy restore failed: ${this.toolFailures.claude}`);
    }
  }

  async controlProxyFromSidebar(providerId: string, action: 'start' | 'stop' | 'restart' | 'log'): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider || provider.tool !== 'claude') throw new Error('Claude provider not found');
    if (action === 'log') { this.outputChannel.show(); return; }
    if (action === 'stop' || action === 'restart') this.proxyServer.stopRoute(providerId);
    if (action === 'start' || action === 'restart') {
      if (!this.proxyServer.resumeRoute(providerId)) {
        if (this.appliedRevisions.has(providerId) && this.appliedRevisions.get(providerId) !== provider.updatedAt) throw new Error('Apply pending changes before starting this proxy');
        await this.activateProvider(provider);
      }
      delete this.toolFailures.claude;
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
            title: `Refreshing ${labelTool(item)} models`,
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
      void vscode.window.showWarningMessage(`Model refresh finished with issues: ${failed.join('; ')}`);
    } else {
      this.status = { kind: 'ready' };
      await this.scanCurrentProvidersFromConfig();
      this.refreshStatus();
      void vscode.window.showInformationMessage(`Model refresh complete: ${refreshed.join(', ') || 'no active providers'}`);
    }
  }

  private async updateProviderModel(providerId: string): Promise<void> {
    const provider = this.store.getProvider(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }
    this.ensureToolEnabled(provider.tool);

    const key = await this.secretStore.get(provider.secretRef);
    if (!key) {
      throw new Error(`${labelTool(provider.tool)} key missing for ${provider.name}`);
    }

    if (provider.codexMode === 'official') throw new Error('Official Codex mode has no API model endpoint');
    const models = await this.fetchAndCacheModels(provider.tool, provider.baseUrl, key, provider.proxy);
    const model = await this.pickModel(provider.tool, models);
    if (!model) {
      return;
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

    if (this.store.getCurrentProviderId(provider.tool) === provider.id) {
      await this.applyProvider(provider.tool);
    } else {
      this.refreshStatus();
    }
  }

  private async openClaudeTerminal(): Promise<void> {
    const resolved = await this.applyProvider('claude');
    if (!resolved?.claude) {
      void vscode.window.showWarningMessage('Claude Code provider is not configured.');
      return;
    }
    this.terminalManager.openClaude(this.lastEnv);
  }

  private async openCodexTerminal(): Promise<void> {
    if (await this.codexAdapter.readMode() === 'official') {
      this.terminalManager.openCodex(this.lastEnv);
      return;
    }
    const resolved = await this.applyProvider('codex');
    if (!resolved?.codex) {
      void vscode.window.showWarningMessage('Codex provider is not configured.');
      return;
    }
    this.terminalManager.openCodex(this.lastEnv);
  }

  private async viewConfig(tool: ToolId): Promise<void> {
    const filePath = tool === 'claude' ? this.claudeAdapter.getConfigPath() : this.codexAdapter.getConfigPath();
    if (!(await pathExists(filePath))) {
      void vscode.window.showWarningMessage(`${labelTool(tool)} config file does not exist yet: ${filePath}`);
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async exportPublicConfig(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      title: 'Export Public Config',
      filters: { JSON: ['json'] },
      saveLabel: 'Export'
    });
    if (!uri) {
      return;
    }

    const config: PublicConfigFile = {
      version: 1,
      currentProviderIds: this.store.getCurrentProviderIds(),
      providers: this.store.getProviders()
    };
    await fs.writeFile(uri.fsPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    void vscode.window.showInformationMessage('Public config exported without API keys.');
  }

  private async importPublicConfig(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: 'Import Public Config',
      canSelectMany: false,
      filters: { JSON: ['json'] },
      openLabel: 'Import'
    });
    const uri = uris?.[0];
    if (!uri) {
      return;
    }

    const parsed = JSON.parse(await fs.readFile(uri.fsPath, 'utf8')) as PublicConfigFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.providers)) {
      throw new Error('Unsupported config file');
    }

    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Merge', description: 'Keep existing providers and add imported providers', value: 'merge' },
        { label: 'Replace', description: 'Replace all local provider metadata', value: 'replace' }
      ],
      { title: 'Import Strategy' }
    );
    if (!mode) {
      return;
    }

    const imported = parsed.providers.map((provider) => ({
      ...provider,
      name: provider.name.trim(),
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      proxy: normalizeProxyConfig(provider.proxy, provider.tool)
    }));
    if (mode.value === 'replace') {
      validateImportedNames(imported);
      await this.store.saveProviders(imported);
    } else {
      const providers = this.store.getProviders();
      for (const provider of imported) {
        const index = providers.findIndex((item) => item.id === provider.id);
        if (index >= 0) {
          providers[index] = provider;
        } else {
          providers.push(provider);
        }
      }
      validateImportedNames(providers);
      await this.store.saveProviders(providers);
    }

    if (parsed.currentProviderIds) {
      if (parsed.currentProviderIds.claude) {
        await this.store.setCurrentProviderId('claude', parsed.currentProviderIds.claude);
      }
      if (parsed.currentProviderIds.codex) {
        await this.store.setCurrentProviderId('codex', parsed.currentProviderIds.codex);
      }
    }

    this.status = { kind: 'missingKey', detail: 'Imported provider metadata does not include API keys.' };
    this.refreshStatus();
    void vscode.window.showInformationMessage('Public config imported. API keys must be entered on this machine.');
  }

  private async fetchAndCacheModels(tool: ToolId, baseUrl: string, key: string, proxy?: ProxyConfig): Promise<ModelInfo[]> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fetching ${labelTool(tool)} models`,
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
      void vscode.window.showWarningMessage(`${labelTool(tool)} model list is empty.`);
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: model.id,
        description: model.displayName,
        model
      })),
      { title: `Select ${labelTool(tool)} Model` }
    );
    return selected?.model.id;
  }

  private async promptRequiredInput(title: string, placeHolder: string, password = false): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title,
      placeHolder,
      password,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Required')
    });
  }

  private ensureToolEnabled(tool: ToolId): void {
    if (!this.store.getToolEnabled(tool)) throw new Error(`${labelTool(tool)} is turned off`);
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

function normalizeProviderName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function validateImportedNames(providers: ProviderProfile[]): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    const key = `${provider.tool}:${normalizeProviderName(provider.name)}`;
    if (seen.has(key)) throw new Error(`Duplicate imported provider name: ${provider.name}`);
    seen.add(key);
  }
}
