import * as vscode from 'vscode';
import { ApiStatusRow, CodexMode, CompatibilityResult, ModelInfo, ModelPolicy, NetworkTestResult, ProviderProfile, ProxyConfig, ProxyRuntime, StatusState, ToolId, UsageQueryConfig, UsageQueryResult } from '../types';
import { proxyDefaults } from '../proxy/config';
import { SpeedReport } from '../speed/types';
import { NetworkProxyState } from '../network/manager';
import { NetworkProxyConfig } from '../network/transport';

export interface SidebarProviderSummary {
  id: string;
  name: string;
  tool: ToolId;
  baseUrl: string;
  modelPolicy: ModelPolicy;
  hasKey: boolean;
  configMode: 'generated' | 'custom';
  networkTest?: NetworkTestResult;
  usageResult?: UsageQueryResult;
  usageEnabled: boolean;
  compatibility?: CompatibilityResult;
  proxy?: ProxyConfig;
  proxyRuntime?: ProxyRuntime;
  needsApply?: boolean;
  codexMode?: CodexMode;
  speedResult?: SpeedReport;
}

export interface SidebarViewState {
  networkProxy?: NetworkProxyState;
  officialSpeedResult?: SpeedReport;
  speedDirectory: string;
  providers: SidebarProviderSummary[];
  currentProviderIds: Partial<Record<ToolId, string>>;
  status: StatusState;
  globalCliSync: boolean;
  configTarget: string;
  configPaths: Record<ToolId, string>;
  toolEnabled: Record<ToolId, boolean>;
  codexMode: CodexMode | 'unknown';
  apiStatuses: ApiStatusRow[];
  storageSizes: {
    logBytes: number;
    backupBytes: number;
    claudeBackupBytes: number;
    codexBackupBytes: number;
  };
}

export interface CreateProviderInput {
  tool: ToolId;
  name: string;
  baseUrl: string;
  key: string;
  model: string;
  applyNow: boolean;
  configMode?: 'generated' | 'custom';
  configText?: string;
  proxy?: ProxyConfig;
  codexMode?: CodexMode;
}

export interface SidebarController {
  applyNetworkProxyFromSidebar(config: NetworkProxyConfig): Promise<void>;
  restoreNetworkProxyFromSidebar(): Promise<void>;
  testNetworkProxyFromSidebar(config: NetworkProxyConfig): Promise<void>;
  getSidebarState(): Promise<SidebarViewState>;
  reloadStateFromSidebar(): Promise<void>;
  previewModelsFromSidebar(tool: ToolId, baseUrl: string, key: string, proxy?: ProxyConfig): Promise<ModelInfo[]>;
  createProviderFromSidebar(input: CreateProviderInput): Promise<void>;
  setCurrentProviderFromSidebar(providerId: string): Promise<void>;
  getProviderConfigFromSidebar(providerId: string): Promise<{ providerId: string; tool: ToolId; text: string; hasKey: boolean; usageQuery: UsageQueryConfig; usageHasToken: boolean; proxy: ProxyConfig; codexMode?: CodexMode }>;
  saveProviderConfigFromSidebar(providerId: string, text: string, key?: string, usageQuery?: UsageQueryConfig, usageAccessToken?: string, proxy?: ProxyConfig, codexMode?: CodexMode): Promise<void>;
  controlProxyFromSidebar(providerId: string, action: 'start' | 'stop' | 'restart' | 'log'): Promise<void>;
  applyProviderFromSidebar(providerId: string): Promise<void>;
  applyCodexModeFromSidebar(mode: CodexMode): Promise<void>;
  deleteProviderFromSidebar(providerId: string): Promise<void>;
  moveProviderFromSidebar(providerId: string, beforeProviderId: string): Promise<void>;
  testProviderNetworkFromSidebar(providerId: string): Promise<void>;
  testToolNetworkFromSidebar(tool: ToolId): Promise<void>;
  testUsageQueryFromSidebar(providerId: string, usageQuery: UsageQueryConfig, usageAccessToken?: string): Promise<void>;
  verifyProviderModelFromSidebar(providerId: string): Promise<void>;
  speedTestFromSidebar(providerId: string | undefined, runs: 1 | 3): Promise<void>;
  copySpeedQuery(): Promise<void>;
  deleteBackupsFromSidebar(tool: ToolId): Promise<void>;
  setToolEnabledFromSidebar(tool: ToolId, enabled: boolean): Promise<void>;
  updateProviderModelFromSidebar(providerId: string): Promise<void>;
  refreshModelsFromSidebar(tool?: ToolId): Promise<void>;
  openClaudeTerminalFromSidebar(): Promise<void>;
  openCodexTerminalFromSidebar(): Promise<void>;
  viewConfigFromSidebar(tool: ToolId): Promise<void>;
  exportPublicConfigFromSidebar(): Promise<void>;
  importPublicConfigFromSidebar(): Promise<void>;
  clearLogFromSidebar(): Promise<boolean>;
}

type IncomingMessage =
  | { type: 'applyNetworkProxy'; config: NetworkProxyConfig }
  | { type: 'restoreNetworkProxy' }
  | { type: 'testNetworkProxy'; config: NetworkProxyConfig }
  | { type: 'ready' }
  | { type: 'previewModels'; tool: ToolId; baseUrl: string; key: string; proxy?: ProxyConfig }
  | { type: 'createProvider'; payload: CreateProviderInput }
  | { type: 'setCurrentProvider'; providerId: string }
  | { type: 'openProviderConfig'; providerId: string }
  | { type: 'saveProviderConfig'; providerId: string; text: string; key?: string; usageQuery?: UsageQueryConfig; usageAccessToken?: string; proxy?: ProxyConfig; codexMode?: CodexMode }
  | { type: 'controlProxy'; providerId: string; action: 'start' | 'stop' | 'restart' | 'log' }
  | { type: 'applyProvider'; providerId: string }
  | { type: 'applyCodexMode'; mode: CodexMode }
  | { type: 'deleteProvider'; providerId: string }
  | { type: 'moveProvider'; providerId: string; beforeProviderId: string }
  | { type: 'testProviderNetwork'; providerId: string }
  | { type: 'testToolNetwork'; tool: ToolId }
  | { type: 'testUsageQuery'; providerId: string; usageQuery: UsageQueryConfig; usageAccessToken?: string }
  | { type: 'verifyProviderModel'; providerId: string }
  | { type: 'speedTest'; providerId?: string; runs: 1 | 3 }
  | { type: 'copySpeedQuery' }
  | { type: 'deleteBackups'; tool: ToolId }
  | { type: 'setToolEnabled'; tool: ToolId; enabled: boolean }
  | { type: 'updateProviderModel'; providerId: string }
  | { type: 'refreshModels'; tool?: ToolId }
  | { type: 'openClaudeTerminal' }
  | { type: 'openCodexTerminal' }
  | { type: 'viewConfig'; tool: ToolId }
  | { type: 'exportPublicConfig' }
  | { type: 'importPublicConfig' }
  | { type: 'clearLog' };

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'vscodemodelswitch.providerView';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: SidebarController
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webview.html = this.getHtml();

    this.disposables.push(
      webview.onDidReceiveMessage(async (message: IncomingMessage) => {
        await this.handleMessage(message);
      })
    );

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    await this.view.webview.postMessage({
      type: 'state',
      state: await this.controller.getSidebarState()
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    try {
      if (message.type !== 'ready') {
        await this.postBusy(true);
      }

      switch (message.type) {
        case 'ready':
          await this.controller.reloadStateFromSidebar();
          await this.refresh();
          return;
        case 'previewModels': {
          const models = await this.controller.previewModelsFromSidebar(message.tool, message.baseUrl, message.key, message.proxy);
          await this.view?.webview.postMessage({ type: 'models', models });
          await this.postNotice(`Fetched ${models.length} models.`);
          break;
        }
        case 'createProvider':
          await this.controller.createProviderFromSidebar(message.payload);
          await this.view?.webview.postMessage({ type: 'providerCreated' });
          await this.postNotice('Provider saved.');
          break;
        case 'setCurrentProvider':
          await this.controller.setCurrentProviderFromSidebar(message.providerId);
          await this.postNotice('Provider applied.');
          break;
                case 'openProviderConfig': {
                  const config = await this.controller.getProviderConfigFromSidebar(message.providerId);
                  await this.view?.webview.postMessage({ type: 'configEditor', ...config });
                  break;
                }
                case 'saveProviderConfig':
                  await this.controller.saveProviderConfigFromSidebar(message.providerId, message.text, message.key, message.usageQuery, message.usageAccessToken, message.proxy, message.codexMode);
                  const saved = await this.controller.getProviderConfigFromSidebar(message.providerId);
                  await this.view?.webview.postMessage({ type: 'configSaved', text: saved.text, usageQuery: saved.usageQuery, proxy: saved.proxy, codexMode: saved.codexMode });
                  await this.postNotice('Provider configuration saved. Apply to use these changes.');
                  break;
                case 'controlProxy':
                  await this.controller.controlProxyFromSidebar(message.providerId, message.action);
                  break;
                case 'applyProvider':
                  await this.controller.applyProviderFromSidebar(message.providerId);
                  await this.postNotice('Provider applied.');
                  break;
        case 'applyCodexMode':
          await this.controller.applyCodexModeFromSidebar(message.mode);
          await this.postNotice(message.mode === 'official'
            ? 'Codex official mode applied. Open Codex and sign in again.'
            : 'Codex API mode applied.');
          break;
                case 'deleteProvider':
                  await this.controller.deleteProviderFromSidebar(message.providerId);
                  await this.postNotice('Provider deleted. Applied config files were kept.');
                  break;
                case 'moveProvider':
                  await this.controller.moveProviderFromSidebar(message.providerId, message.beforeProviderId);
                  break;
                case 'testProviderNetwork':
                  await this.controller.testProviderNetworkFromSidebar(message.providerId);
                  break;
                case 'testToolNetwork':
                  await this.controller.testToolNetworkFromSidebar(message.tool);
                  break;
                case 'testUsageQuery':
                  await this.controller.testUsageQueryFromSidebar(message.providerId, message.usageQuery, message.usageAccessToken);
                  await this.postNotice('Usage query finished.');
                  break;
                case 'verifyProviderModel':
                  await this.controller.verifyProviderModelFromSidebar(message.providerId);
                  break;
                case 'speedTest':
                  await this.controller.speedTestFromSidebar(message.providerId, message.runs);
                  break;
                case 'copySpeedQuery':
                  await this.controller.copySpeedQuery();
                  break;
                case 'deleteBackups':
                  await this.controller.deleteBackupsFromSidebar(message.tool);
                  await this.postNotice(`${labelTool(message.tool)} backups deleted.`);
                  break;
                case 'setToolEnabled':
                  await this.controller.setToolEnabledFromSidebar(message.tool, message.enabled);
                  break;
        case 'updateProviderModel':
          await this.controller.updateProviderModelFromSidebar(message.providerId);
          await this.postNotice('Provider model updated.');
          break;
        case 'refreshModels':
          await this.controller.refreshModelsFromSidebar(message.tool);
          await this.postNotice('Model refresh finished.');
          break;
        case 'openClaudeTerminal':
          await this.controller.openClaudeTerminalFromSidebar();
          break;
        case 'openCodexTerminal':
          await this.controller.openCodexTerminalFromSidebar();
          break;
        case 'viewConfig':
          await this.controller.viewConfigFromSidebar(message.tool);
          break;
        case 'exportPublicConfig':
          await this.controller.exportPublicConfigFromSidebar();
          break;
        case 'importPublicConfig':
          await this.controller.importPublicConfigFromSidebar();
          break;
        case 'clearLog':
          if (await this.controller.clearLogFromSidebar()) await this.postNotice('VSCodeModelSwitch output log cleared.');
          break;
        case 'applyNetworkProxy':
          await this.controller.applyNetworkProxyFromSidebar(message.config);
          await this.postNotice('Network proxy configured. Keep TUN on until clients have restarted and chat has been checked.');
          break;
        case 'restoreNetworkProxy':
          await this.controller.restoreNetworkProxyFromSidebar();
          await this.postNotice('Original network proxy settings restored. Restart existing clients.');
          break;
        case 'testNetworkProxy':
          await this.controller.testNetworkProxyFromSidebar(message.config);
          break;
      }

      await this.refresh();
    } catch (error) {
      const text = describeError(error);
      if (message.type === 'previewModels') {
        await this.view?.webview.postMessage({
          type: 'modelFetchWarning',
          message: `Unable to fetch models. Enter a Model ID manually. ${text}`
        });
        void vscode.window.showWarningMessage('VSCodeModelSwitch: model list unavailable; enter a Model ID manually.');
        return;
      }
      await this.postError(text, message.type);
      void vscode.window.showErrorMessage(`VSCodeModelSwitch: ${text}`);
    } finally {
      await this.postBusy(false);
    }
  }

  private async postBusy(busy: boolean): Promise<void> {
    await this.view?.webview.postMessage({ type: 'busy', busy });
  }

  private async postNotice(message: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'notice', message });
  }

  private async postError(message: string, action?: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'error', message, action });
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>VSCodeModelSwitch</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-sideBar-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 16px; font-weight: 650; }
    h2 { font-size: 13px; font-weight: 650; }
    h3 { font-size: 12px; font-weight: 650; }
    .shell { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .status, .notice, .empty, .panel, .provider {
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      border-radius: 6px;
    }
    .status {
      padding: 7px 8px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBarSectionHeader-background);
    }
    .statusGrid { display: grid; grid-template-columns: minmax(54px, 0.7fr) minmax(65px, 0.8fr) minmax(90px, 1fr) minmax(100px, 1.3fr) minmax(80px, 0.9fr); gap: 5px 8px; overflow-x: auto; }
    .statusRows { display: contents; }
    .statusGrid > div, .statusRows > div { min-width: 0; overflow-wrap: anywhere; }
    .statusHead { font-weight: 650; color: var(--vscode-sideBar-foreground); }
    .syncStatus { margin-top: 7px; color: var(--vscode-descriptionForeground); }
    .toolSwitch { display: flex; align-items: center; gap: 5px; font-size: 12px; }
    .toolSwitch input { width: auto; min-height: auto; margin: 0; }
    .toolDisabled .panel, .toolDisabled .sectionHeader h2 { opacity: 0.5; }
    .notice {
      display: none;
      padding: 7px 8px;
      border-color: var(--vscode-inputValidation-infoBorder);
      background: var(--vscode-inputValidation-infoBackground);
      color: var(--vscode-inputValidation-infoForeground);
    }
    .notice.visible { display: block; }
    .notice.error {
      border-color: var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
    }
    .notice.warning {
      border-color: var(--vscode-inputValidation-warningBorder);
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground);
    }
    .section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .sectionHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .sectionTitle { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .sectionTitle button { min-width: 26px; padding: 2px 5px; }
    .sectionHeader button {
      flex: 0 0 auto;
      min-height: 24px;
      padding: 2px 7px;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }
    .providerList { display: flex; flex-direction: column; gap: 4px; }
    .provider {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 7px 8px;
      background: var(--vscode-sideBar-background);
    }
    .provider.active { border-color: var(--vscode-focusBorder); }
    .provider[draggable="true"] { cursor: grab; }
    .provider[draggable="true"]:active { cursor: grabbing; }
    .providerName { font-weight: 650; overflow-wrap: anywhere; }
    .providerModel {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .providerWarning {
      color: var(--vscode-inputValidation-warningForeground);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .providerMeta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .rowActions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: center;
      gap: 4px;
    }
    .rowActions button {
      min-height: 24px;
      padding: 2px 7px;
      white-space: normal;
    }
    .badge {
      flex: 0 0 auto;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      line-height: 16px;
    }
    .networkProxyBadge {
      display: inline-block;
      align-self: flex-start;
      padding: 4px 9px;
      border: 1px solid var(--vscode-descriptionForeground);
      border-radius: 4px;
      font-weight: 650;
      color: var(--vscode-descriptionForeground);
    }
    .networkProxyBadge.enabled, button.networkProxyCurrent {
      color: var(--vscode-testing-iconPassed, #73c991);
      border-color: var(--vscode-testing-iconPassed, #73c991);
    }
    button.networkProxyCurrent:disabled { opacity: 1; }
    .actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .actions.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .actions.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .actions.tool { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    button {
      min-height: 28px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border-color: var(--vscode-inputValidation-errorBorder); }
    button.danger:hover { background: var(--vscode-inputValidation-errorBackground); filter: brightness(1.15); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    form { display: flex; flex-direction: column; gap: 10px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    input, select {
      width: 100%;
      min-height: 28px;
      padding: 4px 7px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 12px;
    }
    textarea {
      width: 100%;
      min-height: 220px;
      padding: 7px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      resize: vertical;
    }
    input:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .check { display: flex; align-items: center; gap: 7px; color: var(--vscode-sideBar-foreground); font-size: 12px; }
    .check input { width: auto; min-height: auto; margin: 0; }
    .modeCurrent { font-weight: 650; color: var(--vscode-sideBar-foreground); }
    .modeActions { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
    .proxySettings { display: flex; flex-direction: column; gap: 7px; }
    .proxySettings[hidden], .proxyOptions[hidden] { display: none; }
    .proxyOptions { display: flex; flex-direction: column; gap: 7px; }
    .proxySettings details { border-top: 1px solid var(--vscode-widget-border); padding-top: 7px; }
    .proxySettings summary, .proxyDetails summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
    .proxySettings textarea { min-height: 75px; }
    .proxyDetails { font-size: 12px; overflow-wrap: anywhere; }
    .empty {
      padding: 9px;
      border-style: dashed;
      color: var(--vscode-descriptionForeground);
    }
    .small { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .diagnosticResults { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .diagnosticRow { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; padding: 2px 0; }
    .diagnosticLabel { color: var(--vscode-sideBar-foreground); }
    .diagnosticValues { display: flex; flex-wrap: wrap; gap: 2px 10px; min-width: 0; }
    .diagnosticValue { overflow-wrap: anywhere; }
    .diagnosticWarning { color: var(--vscode-inputValidation-warningForeground); }
    .diagnosticDetails { margin-top: 3px; overflow-wrap: anywhere; }
    .diagnosticDetails summary { cursor: pointer; }
    .diagnosticDetails p { margin: 5px 0; }
    .diagnosticDetails button { margin-top: 3px; min-height: 24px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topline">
      <h1>VSCodeModelSwitch</h1>
      <button id="reloadButton">Reload Status</button>
    </div>
    <div id="status" class="status">
      <div class="statusGrid">
        <div class="statusHead">Tool</div><div class="statusHead">Mode</div><div class="statusHead">Provider Name</div><div class="statusHead">Model ID</div><div class="statusHead">Status</div>
        <div id="statusRows" class="statusRows">Loading...</div>
      </div>
      <div id="syncStatus" class="syncStatus"></div>
      <div id="storageStatus" class="syncStatus"></div>
    </div>
    <div id="notice" class="notice"></div>
    <details class="panel" id="networkProxyPanel">
      <summary>通过 VPN 联网 / Network proxy</summary>
      <div id="networkProxyBadge" class="networkProxyBadge" role="status" aria-live="polite">读取状态中 / Loading</div>
      <div id="networkProxyStatus" class="small"></div>
      <div class="small">Use the host VPN's HTTP proxy for Claude Code, Codex and this extension's outgoing requests. API compatibility proxy settings remain separate.</div>
      <div class="field"><label for="networkProxyUrl">HTTP proxy URL</label><input id="networkProxyUrl" type="text" value="http://127.0.0.1:12000" autocomplete="off"></div>
      <div class="actions">
        <label class="check"><input id="networkProxyClaude" type="checkbox" checked> Claude Code</label>
        <label class="check"><input id="networkProxyCodex" type="checkbox" checked> Codex</label>
      </div>
      <div class="field"><label for="networkProxyBypass">Bypass hosts (comma-separated)</label><input id="networkProxyBypass" type="text" value="localhost,127.0.0.1,::1" autocomplete="off"></div>
      <div class="actions">
        <button id="testNetworkProxyButton" class="secondary" disabled>测试连接 / Test</button>
        <button id="applyNetworkProxyButton" class="primary" disabled>启用代理 / Enable</button>
        <button id="restoreNetworkProxyButton" class="secondary" disabled>已停用 / Disabled</button>
      </div>
      <div id="networkProxyTest" class="small"></div>
      <div class="small">Apply changes client launch settings; restart clients or reload the window. VS Code HTTP proxy can also affect other extensions. Connection tests do not verify login or chat.</div>
    </details>
    <section id="configEditor" class="section" hidden>
      <h2>Provider Configuration</h2>
      <div class="panel">
        <div id="configEditorTool" class="small"></div>
        <textarea id="configText" spellcheck="false"></textarea>
        <div class="field">
          <label for="configKey">API Key</label>
          <input id="configKey" type="password" placeholder="Leave empty to keep the stored key" autocomplete="off">
        </div>
        ${renderProxyFields('edit')}
        <label class="check"><input id="usageEnabled" type="checkbox"> Enable Usage Query</label>
        <div id="usageFields" class="field">
          <label for="usagePreset">Usage preset</label>
          <select id="usagePreset">
            <option value="auto">Auto Detect</option>
            <option value="generic">Generic Balance</option>
            <option value="deepseek">DeepSeek</option>
            <option value="siliconflow">SiliconFlow</option>
            <option value="openrouter">OpenRouter</option>
            <option value="newapi">New API</option>
            <option value="custom">Custom</option>
          </select>
          <div id="usageAdvancedFields" class="field" hidden>
            <label for="usageUrl" title="Usage API URL. {{baseUrl}} is replaced with this Provider's Base URL.">Usage URL</label>
            <input id="usageUrl" type="text" placeholder="{{baseUrl}}/user/balance" autocomplete="off">
            <label for="usageRemainingPath" title="Dot-separated JSON path containing the remaining quota.">Remaining JSON path</label>
            <input id="usageRemainingPath" type="text" placeholder="balance" autocomplete="off">
            <label for="usageUsedPath" title="Optional dot-separated JSON path containing used quota.">Used JSON path (optional)</label>
            <input id="usageUsedPath" type="text" autocomplete="off">
            <label for="usageTotalPath" title="Optional dot-separated JSON path containing total quota.">Total JSON path (optional)</label>
            <input id="usageTotalPath" type="text" autocomplete="off">
            <label for="usageUnit" title="Display unit only; it does not convert currencies.">Display unit</label>
            <input id="usageUnit" type="text" placeholder="USD" autocomplete="off">
            <label for="usageDivisor" title="Raw values are divided by this number before display.">Value divisor</label>
            <input id="usageDivisor" type="number" min="0.000001" step="any" value="1">
          </div>
          <div id="newApiFields" class="field" hidden>
            <label for="usageUserId" title="Required by New API-style management endpoints; optional for Auto Detect.">Management User ID</label>
            <input id="usageUserId" type="text" autocomplete="off">
            <label for="usageAccessToken" title="Console access token, not the model API key.">Management Access Token</label>
            <input id="usageAccessToken" type="password" placeholder="Leave empty to keep the stored token" autocomplete="off">
          </div>
          <button id="testUsageButton" type="button">Test Usage Query</button>
        </div>
        <div class="actions">
          <button id="saveConfigButton" class="primary">Save</button>
          <button id="cancelConfigButton">Cancel</button>
          <button id="closeConfigButton">Close</button>
        </div>
      </div>
    </section>

    <section id="claudeSection" class="section">
      <div class="sectionHeader">
        <div class="sectionTitle">
          <h2>Claude Code Providers</h2>
          <button id="collapseClaudeButton" title="Collapse Claude tool" aria-label="Collapse Claude tool">▾</button>
        </div>
        <label class="toolSwitch"><input id="claudeEnabled" type="checkbox" checked> Enabled</label>
        <button id="viewClaudeConfigButton">Applied Config</button>
      </div>
      <div id="claudeToolPanel" class="panel">
        <div id="claudeProviders" class="providerList"></div>
        <div class="actions four">
          <button id="openClaudeButton">Terminal</button>
          <button id="refreshClaudeModelsButton">Refresh Claude Models</button>
          <button id="testClaudeNetworkButton">Network & Usage</button>
          <button id="deleteClaudeBackupsButton">Delete Backups</button>
        </div>
        <div id="claudePath" class="small"></div>
      </div>
    </section>

    <section id="codexSection" class="section">
      <div class="sectionHeader">
        <div class="sectionTitle">
          <h2>Codex Providers</h2>
          <button id="collapseCodexButton" title="Collapse Codex tool" aria-label="Collapse Codex tool">▾</button>
        </div>
        <label class="toolSwitch"><input id="codexEnabled" type="checkbox" checked> Enabled</label>
        <button id="viewCodexConfigButton">Applied Config</button>
      </div>
      <div id="codexToolPanel" class="panel">
        <div class="field">
          <div id="codexCurrentMode" class="modeCurrent" role="status" aria-live="polite">Current mode: Checking…</div>
          <div id="codexModeDetail" class="small"></div>
          <div class="modeActions">
            <button id="codexOfficialMode" type="button">Use Official Account</button>
            <button id="codexApiMode" type="button">Apply API Provider</button>
          </div>
          <div class="small">Both actions clear config.toml and auth.json first. Official mode then requires Codex login; API mode applies the selected API provider.</div>
        </div>
        <div class="actions">
          <button id="quickOfficialSpeedButton" title="One real short request using the active official Codex login; uses model quota">Quick Speed Test · Official</button>
          <button id="standardOfficialSpeedButton" title="Three serial real short requests using the active official Codex login; uses model quota">Standard Speed Test · Official</button>
        </div>
        <div id="officialSpeedResult" class="diagnosticResults"></div>
        <div id="codexProviders" class="providerList"></div>
        <div class="actions four">
          <button id="openCodexButton">Terminal</button>
          <button id="refreshCodexModelsButton">Refresh Codex Models</button>
          <button id="testCodexNetworkButton">Network & Usage</button>
          <button id="deleteCodexBackupsButton">Delete Backups</button>
        </div>
        <div id="codexPath" class="small"></div>
      </div>
    </section>

    <section class="section">
      <h2>Add Provider</h2>
      <form id="providerForm" class="panel">
        <div class="field">
          <label for="tool">Tool</label>
          <select id="tool">
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </div>
        <div class="field">
          <label for="providerName">Name</label>
          <input id="providerName" type="text" placeholder="Local Mock" autocomplete="off" required>
        </div>
        <div class="field">
          <label for="addMode">Add mode</label>
          <select id="addMode">
            <option value="fields">Key fields</option>
            <option value="text">Full configuration</option>
          </select>
        </div>
        <div class="field" id="configTextField" hidden>
          <label for="addConfigText">Configuration template</label>
          <textarea id="addConfigText" spellcheck="false"></textarea>
        </div>
        <div class="field" id="baseUrlField">
          <label for="baseUrl">Base URL</label>
          <input id="baseUrl" type="text" placeholder="http://localhost:8787" autocomplete="off" required>
        </div>
        <div class="field" id="apiKeyField">
          <label for="apiKey">API Key</label>
          <input id="apiKey" type="password" placeholder="test-key" autocomplete="off" required>
        </div>
        <button id="fetchModelsButton" type="button">Fetch Models</button>
        <div class="field" id="modelField">
          <label for="modelSelect">Model ID</label>
          <input id="modelSelect" type="text" list="modelOptions" placeholder="Fetch models or enter an ID" autocomplete="off">
          <datalist id="modelOptions"></datalist>
        </div>
        ${renderProxyFields('add')}
        <label class="check"><input id="applyNow" type="checkbox"> Set active after saving</label>
        <button id="saveButton" class="primary" type="submit" disabled>Save Provider</button>
        <div id="addNotice" class="notice"></div>
        <div class="small">Each provider belongs to exactly one tool. Model ID is optional and can be fetched or entered manually.</div>
      </form>
    </section>

    <section class="section">
      <h2>Configuration</h2>
      <div class="actions three">
        <button id="exportButton">Export</button>
        <button id="importButton">Import</button>
        <button id="clearLogButton" class="danger">Delete Log</button>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const proxyPresets = ${JSON.stringify({ anthropic: { justdowork: proxyDefaults('justdowork'), custom: proxyDefaults('custom') }, responses: { justdowork: proxyDefaults('justdowork', 'responses'), custom: proxyDefaults('custom', 'responses') } })};
    let state = {
      providers: [],
      currentProviderIds: {},
      status: { kind: 'off' },
      globalCliSync: true,
      configTarget: 'real',
      configPaths: { claude: '', codex: '' },
      toolEnabled: { claude: true, codex: true },
      codexMode: 'unknown',
      apiStatuses: [],
      storageSizes: { logBytes: 0, backupBytes: 0, claudeBackupBytes: 0, codexBackupBytes: 0 }
    };
    let busy = false;
    let networkProxyDirty = false;
    let networkProxyLoaded = false;
    let networkProxyPending = '';
    let fetchedModels = [];
    let configEditorProviderId = '';
    let configEditorTool = '';
    let templateTool = '';
    let configOriginalText = '';
    let configOriginalKey = '';
    let configOriginalUsage = undefined;
    let configOriginalProxy = undefined;
    const savedViewState = vscode.getState() || {};
    const collapsed = { claude: Boolean(savedViewState.claudeCollapsed), codex: Boolean(savedViewState.codexCollapsed) };

    const el = {
      networkProxyUrl: document.getElementById('networkProxyUrl'),
      networkProxyClaude: document.getElementById('networkProxyClaude'),
      networkProxyCodex: document.getElementById('networkProxyCodex'),
      networkProxyBypass: document.getElementById('networkProxyBypass'),
      networkProxyStatus: document.getElementById('networkProxyStatus'),
      networkProxyBadge: document.getElementById('networkProxyBadge'),
      networkProxyTest: document.getElementById('networkProxyTest'),
      testNetworkProxyButton: document.getElementById('testNetworkProxyButton'),
      applyNetworkProxyButton: document.getElementById('applyNetworkProxyButton'),
      restoreNetworkProxyButton: document.getElementById('restoreNetworkProxyButton'),
      status: document.getElementById('status'),
      statusRows: document.getElementById('statusRows'),
      syncStatus: document.getElementById('syncStatus'),
      storageStatus: document.getElementById('storageStatus'),
      notice: document.getElementById('notice'),
      claudeProviders: document.getElementById('claudeProviders'),
      codexProviders: document.getElementById('codexProviders'),
      claudeSection: document.getElementById('claudeSection'),
      codexSection: document.getElementById('codexSection'),
      claudeToolPanel: document.getElementById('claudeToolPanel'),
      codexToolPanel: document.getElementById('codexToolPanel'),
      claudeEnabled: document.getElementById('claudeEnabled'),
      codexEnabled: document.getElementById('codexEnabled'),
      collapseClaudeButton: document.getElementById('collapseClaudeButton'),
      collapseCodexButton: document.getElementById('collapseCodexButton'),
      form: document.getElementById('providerForm'),
      tool: document.getElementById('tool'),
      providerName: document.getElementById('providerName'),
      baseUrl: document.getElementById('baseUrl'),
      apiKey: document.getElementById('apiKey'),
      fetchModelsButton: document.getElementById('fetchModelsButton'),
      modelSelect: document.getElementById('modelSelect'),
      modelOptions: document.getElementById('modelOptions'),
      applyNow: document.getElementById('applyNow'),
      saveButton: document.getElementById('saveButton'),
      addNotice: document.getElementById('addNotice'),
      reloadButton: document.getElementById('reloadButton'),
      openClaudeButton: document.getElementById('openClaudeButton'),
      openCodexButton: document.getElementById('openCodexButton'),
      viewClaudeConfigButton: document.getElementById('viewClaudeConfigButton'),
      viewCodexConfigButton: document.getElementById('viewCodexConfigButton'),
      claudePath: document.getElementById('claudePath'),
      codexPath: document.getElementById('codexPath'),
      refreshClaudeModelsButton: document.getElementById('refreshClaudeModelsButton'),
      refreshCodexModelsButton: document.getElementById('refreshCodexModelsButton'),
      testClaudeNetworkButton: document.getElementById('testClaudeNetworkButton'),
      testCodexNetworkButton: document.getElementById('testCodexNetworkButton'),
      exportButton: document.getElementById('exportButton'),
      importButton: document.getElementById('importButton'),
      clearLogButton: document.getElementById('clearLogButton'),
      quickOfficialSpeedButton: document.getElementById('quickOfficialSpeedButton'),
      standardOfficialSpeedButton: document.getElementById('standardOfficialSpeedButton'),
      officialSpeedResult: document.getElementById('officialSpeedResult'),
      addMode: document.getElementById('addMode'),
      configTextField: document.getElementById('configTextField'),
      addConfigText: document.getElementById('addConfigText'),
      baseUrlField: document.getElementById('baseUrlField'),
      apiKeyField: document.getElementById('apiKeyField'),
      modelField: document.getElementById('modelField'),
      configEditor: document.getElementById('configEditor'),
      configEditorTool: document.getElementById('configEditorTool'),
      codexOfficialMode: document.getElementById('codexOfficialMode'),
      codexApiMode: document.getElementById('codexApiMode'),
      codexCurrentMode: document.getElementById('codexCurrentMode'),
      codexModeDetail: document.getElementById('codexModeDetail'),
      configText: document.getElementById('configText'),
      configKey: document.getElementById('configKey'),
      usageEnabled: document.getElementById('usageEnabled'),
      usageFields: document.getElementById('usageFields'),
      usagePreset: document.getElementById('usagePreset'),
      usageAdvancedFields: document.getElementById('usageAdvancedFields'),
      usageUrl: document.getElementById('usageUrl'),
      usageRemainingPath: document.getElementById('usageRemainingPath'),
      usageUsedPath: document.getElementById('usageUsedPath'),
      usageTotalPath: document.getElementById('usageTotalPath'),
      usageUnit: document.getElementById('usageUnit'),
      usageDivisor: document.getElementById('usageDivisor'),
      newApiFields: document.getElementById('newApiFields'),
      usageUserId: document.getElementById('usageUserId'),
      usageAccessToken: document.getElementById('usageAccessToken'),
      testUsageButton: document.getElementById('testUsageButton'),
      saveConfigButton: document.getElementById('saveConfigButton'),
      cancelConfigButton: document.getElementById('cancelConfigButton'),
      closeConfigButton: document.getElementById('closeConfigButton'),
      deleteClaudeBackupsButton: document.getElementById('deleteClaudeBackupsButton'),
      deleteCodexBackupsButton: document.getElementById('deleteCodexBackupsButton')
    };

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        state = message.state;
        networkProxyLoaded = true;
        // Only confirmed results replace a draft; failed Apply keeps it for retry.
        if (networkProxyPending === 'apply' && sameNetworkProxy(state.networkProxy?.config, networkProxyInput()) ||
            networkProxyPending === 'restore' && !state.networkProxy?.config) networkProxyDirty = false;
        render();
        return;
      }
      if (message.type === 'models') {
        fetchedModels = message.models || [];
        renderModelOptions();
        el.addNotice.classList.remove('visible', 'warning', 'error');
        return;
      }
      if (message.type === 'configEditor') {
        configEditorProviderId = message.providerId;
        configEditorTool = message.tool;
        el.configEditorTool.textContent = labelTool(message.tool) + (message.hasKey ? ' - API key stored' : ' - API key missing');
        el.configText.value = message.text;
        el.configKey.value = '';
        setUsageQuery(message.usageQuery);
        el.usageAccessToken.placeholder = message.usageHasToken ? 'Leave empty to keep the stored token' : 'Access Token required';
        configOriginalText = message.text;
        configOriginalKey = '';
        configOriginalUsage = message.usageQuery;
        configOriginalProxy = message.proxy;
        setProxyConfig('edit', message.proxy);
        updateProxyVisibility('edit', message.tool);
        el.configEditor.hidden = false;
        el.configText.focus();
        return;
      }
      if (message.type === 'configSaved') {
        configOriginalText = message.text;
        configOriginalKey = '';
        configOriginalUsage = message.usageQuery;
        configOriginalProxy = message.proxy;
        el.configText.value = message.text;
        setProxyConfig('edit', message.proxy);
        el.configKey.value = '';
        return;
      }
      if (message.type === 'busy') {
        busy = message.busy;
        if (!busy) networkProxyPending = '';
        setBusy(busy);
        return;
      }
      if (message.type === 'notice') {
        showNotice(message.message, false);
        return;
      }
      if (message.type === 'providerCreated') {
        el.applyNow.checked = false;
        showAddNotice('Provider saved.', false);
        return;
      }
      if (message.type === 'modelFetchWarning') {
        fetchedModels = [];
        renderModelOptions();
        showAddWarning(message.message);
        return;
      }
      if (message.type === 'error') {
        if (message.action === 'createProvider') showAddNotice(message.message, true);
        showNotice(message.message, true);
      }
    });

    el.reloadButton.addEventListener('click', () => post({ type: 'ready' }));
    function networkProxyInput() {
      return { url: el.networkProxyUrl.value.trim(), noProxy: el.networkProxyBypass.value,
        claude: el.networkProxyClaude.checked, codex: el.networkProxyCodex.checked };
    }
    function sameNetworkProxy(a, b) {
      if (!a || !b) return false;
      const signature = config => JSON.stringify([
        config.url.trim().replace(/[/]$/, ''),
        [...new Set(('localhost,127.0.0.1,::1,' + config.noProxy).split(',').map(host => host.trim()).filter(Boolean))].sort(),
        config.claude, config.codex
      ]);
      return signature(a) === signature(b);
    }
    function renderNetworkProxyActions() {
      const network = state.networkProxy || {};
      const enabled = Boolean(network.config);
      const changed = enabled && !sameNetworkProxy(network.config, networkProxyInput());
      const locked = busy || !networkProxyLoaded;
      el.networkProxyBadge.textContent = !networkProxyLoaded ? '读取状态中 / Loading' : enabled ? '● 已启用 / Enabled' : '○ 已停用 / Disabled';
      el.networkProxyBadge.className = 'networkProxyBadge' + (enabled ? ' enabled' : '');
      el.networkProxyStatus.textContent = enabled
        ? (changed ? '当前代理仍已启用；有更改待应用。 / Enabled — changes not applied. ' : '当前为启用状态，无需重复启用。 / Enabled — no changes. ') + (network.message || '')
        : '代理已停用，点击启用代理以开启。 / Disabled. ' + (network.message || '');
      el.applyNetworkProxyButton.textContent = networkProxyPending === 'apply' ? '应用中… / Applying…'
        : !enabled ? '启用代理 / Enable' : changed ? '应用更改 / Apply changes' : '✓ 已启用 / Enabled';
      el.applyNetworkProxyButton.className = enabled && !changed ? 'networkProxyCurrent' : 'primary';
      el.applyNetworkProxyButton.disabled = locked || enabled && !changed;
      el.restoreNetworkProxyButton.textContent = networkProxyPending === 'restore' ? '停用中… / Disabling…'
        : enabled ? '停用并恢复 / Disable' : '已停用 / Disabled';
      el.restoreNetworkProxyButton.disabled = locked || !enabled;
      el.testNetworkProxyButton.textContent = networkProxyPending === 'test' ? '测试中… / Testing…' : '测试连接 / Test';
      el.testNetworkProxyButton.disabled = locked;
      for (const input of [el.networkProxyUrl, el.networkProxyBypass, el.networkProxyClaude, el.networkProxyCodex]) input.disabled = locked;
    }
    function submitNetworkProxy(action) {
      networkProxyPending = action;
      setBusy(true); // Lock immediately, before the extension host acknowledges it.
      post(action === 'restore' ? { type: 'restoreNetworkProxy' }
        : { type: action === 'apply' ? 'applyNetworkProxy' : 'testNetworkProxy', config: networkProxyInput() });
    }
    for (const input of [el.networkProxyUrl, el.networkProxyBypass, el.networkProxyClaude, el.networkProxyCodex]) {
      input.addEventListener('input', () => { networkProxyDirty = true; renderNetworkProxyActions(); el.networkProxyTest.textContent = ''; });
    }
    el.testNetworkProxyButton.addEventListener('click', () => {
      if (!el.testNetworkProxyButton.disabled) submitNetworkProxy('test');
    });
    el.applyNetworkProxyButton.addEventListener('click', () => {
      if (!el.applyNetworkProxyButton.disabled) submitNetworkProxy('apply');
    });
    el.restoreNetworkProxyButton.addEventListener('click', () => {
      if (!el.restoreNetworkProxyButton.disabled) submitNetworkProxy('restore');
    });
    el.quickOfficialSpeedButton.addEventListener('click', () => post({ type: 'speedTest', runs: 1 }));
    el.standardOfficialSpeedButton.addEventListener('click', () => post({ type: 'speedTest', runs: 3 }));
    el.openClaudeButton.addEventListener('click', () => post({ type: 'openClaudeTerminal' }));
    el.openCodexButton.addEventListener('click', () => post({ type: 'openCodexTerminal' }));
    el.viewClaudeConfigButton.addEventListener('click', () => post({ type: 'viewConfig', tool: 'claude' }));
    el.viewCodexConfigButton.addEventListener('click', () => post({ type: 'viewConfig', tool: 'codex' }));
    el.refreshClaudeModelsButton.addEventListener('click', () => post({ type: 'refreshModels', tool: 'claude' }));
    el.refreshCodexModelsButton.addEventListener('click', () => post({ type: 'refreshModels', tool: 'codex' }));
    el.testClaudeNetworkButton.addEventListener('click', () => post({ type: 'testToolNetwork', tool: 'claude' }));
    el.testCodexNetworkButton.addEventListener('click', () => post({ type: 'testToolNetwork', tool: 'codex' }));
    el.claudeEnabled.addEventListener('change', () => post({ type: 'setToolEnabled', tool: 'claude', enabled: el.claudeEnabled.checked }));
    el.codexEnabled.addEventListener('change', () => post({ type: 'setToolEnabled', tool: 'codex', enabled: el.codexEnabled.checked }));
    el.collapseClaudeButton.addEventListener('click', () => toggleCollapse('claude'));
    el.collapseCodexButton.addEventListener('click', () => toggleCollapse('codex'));
    el.exportButton.addEventListener('click', () => post({ type: 'exportPublicConfig' }));
    el.importButton.addEventListener('click', () => post({ type: 'importPublicConfig' }));
    el.clearLogButton.addEventListener('click', () => post({ type: 'clearLog' }));
    el.deleteClaudeBackupsButton.addEventListener('click', () => post({ type: 'deleteBackups', tool: 'claude' }));
    el.deleteCodexBackupsButton.addEventListener('click', () => post({ type: 'deleteBackups', tool: 'codex' }));
    el.codexOfficialMode.addEventListener('click', () => post({ type: 'applyCodexMode', mode: 'official' }));
    el.codexApiMode.addEventListener('click', () => post({ type: 'applyCodexMode', mode: 'api' }));
    el.addMode.addEventListener('change', updateAddMode);
    el.tool.addEventListener('change', () => { resetModels(); setProxyConfig('add'); updateAddMode(); });
    el.addConfigText.addEventListener('input', updateSaveState);
    el.saveConfigButton.addEventListener('click', () => {
      try { post({ type: 'saveProviderConfig', providerId: configEditorProviderId, text: el.configText.value, key: el.configKey.value, usageQuery: getUsageQuery(), usageAccessToken: el.usageAccessToken.value, proxy: getProxyConfig('edit') }); }
      catch (error) { showNotice(error.message, true); }
    });
    el.usageEnabled.addEventListener('change', updateUsageVisibility);
    el.usagePreset.addEventListener('change', applyUsagePreset);
    el.testUsageButton.addEventListener('click', () => post({ type: 'testUsageQuery', providerId: configEditorProviderId, usageQuery: getUsageQuery(), usageAccessToken: el.usageAccessToken.value }));
    el.cancelConfigButton.addEventListener('click', () => {
      el.configText.value = configOriginalText;
      el.configKey.value = configOriginalKey;
      setUsageQuery(configOriginalUsage);
      setProxyConfig('edit', configOriginalProxy);
    });
    el.closeConfigButton.addEventListener('click', () => {
      el.configText.value = configOriginalText;
      el.configKey.value = configOriginalKey;
      setUsageQuery(configOriginalUsage);
      setProxyConfig('edit', configOriginalProxy);
      el.configEditor.hidden = true;
    });
    el.fetchModelsButton.addEventListener('click', () => fetchModels());
    el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      try { saveProvider(); } catch (error) { showAddNotice(error.message, true); }
    });
    el.baseUrl.addEventListener('input', resetModels);
    el.apiKey.addEventListener('input', resetModels);
      el.modelSelect.addEventListener('input', updateSaveState);

    function render() {
      const network = state.networkProxy || {};
      if (!networkProxyDirty) {
        const config = network.config || { url: 'http://127.0.0.1:12000', noProxy: 'localhost,127.0.0.1,::1', claude: true, codex: true };
        el.networkProxyUrl.value = config.url; el.networkProxyBypass.value = config.noProxy;
        el.networkProxyClaude.checked = config.claude; el.networkProxyCodex.checked = config.codex;
      }
      renderNetworkProxyActions();
      el.networkProxyTest.textContent = network.test ? 'Transport test via ' + network.test.proxyUrl + ' at ' + network.test.checkedAt + ': ' + network.test.results.map(item => item.target + ' — ' + (item.reachable ? 'reachable (HTTP ' + item.status + ')' : item.error)).join('; ') + '. Login/chat not verified.' : '';
      renderStatus();
      renderProviderList('claude', el.claudeProviders, state.toolEnabled.claude);
      renderProviderList('codex', el.codexProviders, state.toolEnabled.codex);
      el.claudePath.textContent = 'Config: ' + state.configPaths.claude;
      el.codexPath.textContent = 'Config: ' + state.configPaths.codex;
      el.claudeEnabled.checked = state.toolEnabled.claude;
      el.codexEnabled.checked = state.toolEnabled.codex;
      el.codexCurrentMode.textContent = 'Current mode: ' + labelMode(state.codexMode);
      el.officialSpeedResult.hidden = state.codexMode !== 'official';
      if (!el.officialSpeedResult.hidden) renderDiagnostics(el.officialSpeedResult, undefined, undefined, false, state.officialSpeedResult);
      const codexStatus = state.apiStatuses.find(row => row.tool === 'codex');
      el.codexModeDetail.textContent = state.codexMode === 'official'
        ? codexStatus && codexStatus.status === 'loginRequired' ? 'Official mode is selected. Sign in from the Codex client.' : 'Uses Codex sign-in. Model selection follows the Codex client.'
        : state.codexMode === 'api' ? 'Uses the applied API provider configuration. Saved edits take effect after Apply.'
        : 'Mode could not be determined. Reload Status or apply a mode below.';
      el.claudeSection.classList.toggle('toolDisabled', !state.toolEnabled.claude);
      el.codexSection.classList.toggle('toolDisabled', !state.toolEnabled.codex);
      applyCollapseState();
      updateActionState();
      updateSaveState();
      updateAddMode();
    }

    function renderStatus() {
      el.statusRows.textContent = '';
      for (const row of state.apiStatuses) {
        const tool = document.createElement('div'); tool.textContent = labelTool(row.tool);
        const mode = document.createElement('div'); mode.textContent = labelMode(row.mode);
        const provider = document.createElement('div'); provider.textContent = row.providerName || (row.mode === 'official' ? 'Official account' : 'Not configured');
        const model = document.createElement('div'); model.textContent = row.model || (row.mode === 'official' || row.mode === 'api' ? 'Client default' : '—');
        const status = document.createElement('div'); status.textContent = labelStatus(row.status);
        el.statusRows.append(tool, mode, provider, model, status);
      }
      el.syncStatus.textContent = state.globalCliSync ? 'Config sync: ' + state.configTarget : 'Config sync: Off';
      const sizes = state.storageSizes || { logBytes: 0, backupBytes: 0, claudeBackupBytes: 0, codexBackupBytes: 0 };
      el.storageStatus.textContent = 'Storage: Log folder ' + formatBytes(sizes.logBytes) +
        ' | Backup folders ' + formatBytes(sizes.backupBytes) +
        ' (Claude ' + formatBytes(sizes.claudeBackupBytes) + ', Codex ' + formatBytes(sizes.codexBackupBytes) + ')';
    }

    function toggleCollapse(tool) {
      collapsed[tool] = !collapsed[tool];
      vscode.setState({ claudeCollapsed: collapsed.claude, codexCollapsed: collapsed.codex });
      applyCollapseState();
    }

    function applyCollapseState() {
      el.claudeToolPanel.hidden = collapsed.claude;
      el.codexToolPanel.hidden = collapsed.codex;
      el.collapseClaudeButton.textContent = collapsed.claude ? '▸' : '▾';
      el.collapseCodexButton.textContent = collapsed.codex ? '▸' : '▾';
      el.collapseClaudeButton.title = collapsed.claude ? 'Expand Claude tool' : 'Collapse Claude tool';
      el.collapseCodexButton.title = collapsed.codex ? 'Expand Codex tool' : 'Collapse Codex tool';
    }

    function renderProviderList(tool, container, enabled) {
      container.textContent = '';
      const providers = state.providers.filter((provider) => provider.tool === tool);
      if (!providers.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No ' + labelTool(tool) + ' providers yet.';
        container.appendChild(empty);
        return;
      }

      for (const provider of providers) {
        const active = enabled && state.currentProviderIds[tool] === provider.id;
        const item = document.createElement('div');
        item.className = 'provider' + (active ? ' active' : '');
        item.draggable = enabled;
        item.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', provider.id));
        item.addEventListener('dragover', (event) => event.preventDefault());
        item.addEventListener('drop', (event) => {
          event.preventDefault();
          const providerId = event.dataTransfer.getData('text/plain');
          if (providerId && providerId !== provider.id) post({ type: 'moveProvider', providerId, beforeProviderId: provider.id });
        });

        const meta = document.createElement('div');
        meta.className = 'providerMeta';
        const name = document.createElement('div');
        name.className = 'providerName';
        name.textContent = provider.name;
        const model = document.createElement('div');
        model.className = 'providerModel';
        model.textContent = labelModel(provider.modelPolicy);
        meta.appendChild(name);
        meta.appendChild(model);
        if (active) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'Active';
          meta.appendChild(badge);
        }
        const connection = document.createElement('div');
        connection.className = 'providerModel';
        connection.textContent = provider.codexMode === 'official'
          ? 'Connection: Codex Official account'
          : provider.proxy && provider.proxy.mode === 'proxy'
          ? 'Connection: Built-in proxy · ' + (provider.proxy.apiFormat === 'responses' ? 'Responses · ' : '') + provider.proxy.preset + (Object.keys(provider.proxy.overrides || {}).length ? ' · Customized' : '')
          : 'Connection: Direct';
        meta.appendChild(connection);
        if (provider.needsApply) {
          const pending = document.createElement('div'); pending.className = 'providerWarning';
          pending.textContent = 'Configuration changed · Pending Apply'; meta.appendChild(pending);
        }
        if (provider.proxy && provider.proxy.mode === 'proxy' || provider.needsApply && provider.proxyRuntime && provider.proxyRuntime.localUrl) {
          const runtime = provider.proxyRuntime || { state: 'stopped', requests: 0, succeeded: 0, failed: 0, retries: 0, trimmedMessages: 0 };
          const local = document.createElement('div'); local.className = 'providerModel';
          local.textContent = 'Proxy: ' + (runtime.state === 'running' ? 'Running' : 'Stopped'); meta.appendChild(local);
          const upstream = document.createElement('div'); upstream.className = runtime.lastRequest && !runtime.lastRequest.ok ? 'providerWarning' : 'providerModel';
          upstream.textContent = runtime.lastRequest ? 'Last model request: ' + (runtime.lastRequest.ok ? 'Passed' : 'Failed · HTTP ' + runtime.lastRequest.status + ' · ' + runtime.lastRequest.error) : 'Model availability: Not verified';
          meta.appendChild(upstream);
          const details = document.createElement('details'); details.className = 'proxyDetails';
          const summary = document.createElement('summary'); summary.textContent = 'Proxy Details'; details.appendChild(summary);
          const info = document.createElement('div');
          info.textContent = (runtime.localUrl || 'Apply to start a local endpoint') + ' | Requests ' + runtime.requests + ', passed ' + runtime.succeeded + ', failed ' + runtime.failed + ', retries ' + runtime.retries + ', omitted history messages ' + runtime.trimmedMessages;
          details.appendChild(info);
          const controls = document.createElement('div'); controls.className = 'actions three';
          for (const action of [runtime.state === 'running' ? 'stop' : 'start', 'restart', 'log']) {
            const button = document.createElement('button'); button.textContent = action[0].toUpperCase() + action.slice(1);
            button.disabled = busy || !enabled || (action !== 'log' && !active && !runtime.localUrl);
            button.title = action === 'start' || action === 'restart' ? 'Resume the last applied configuration; use Apply for saved changes.' : '';
            button.addEventListener('click', () => post({ type: 'controlProxy', providerId: provider.id, action })); controls.appendChild(button);
          }
          details.appendChild(controls); meta.appendChild(details);
        }
        if (provider.compatibility) {
          const compatibility = document.createElement('div');
          compatibility.className = provider.compatibility.ok ? 'providerModel' : 'providerWarning';
          compatibility.textContent = provider.compatibility.ok
            ? 'Compatibility: Passed | ' + provider.compatibility.latencyMs + ' ms'
            : 'Compatibility: ' + compatibilityFailureLabel(provider.compatibility.failureKind) + ' | ' + (provider.compatibility.error || 'Failed');
          meta.appendChild(compatibility);
        }
        if (provider.speedResult || provider.networkTest || provider.usageResult || provider.usageEnabled) {
          const results = document.createElement('div'); results.className = 'diagnosticResults';
          renderDiagnostics(results, provider.networkTest, provider.usageResult, provider.usageEnabled, provider.speedResult);
          meta.appendChild(results);
        }
        if (!provider.hasKey) {
          const warning = document.createElement('div');
          warning.className = 'providerWarning';
          warning.textContent = 'Key missing on this machine';
          meta.appendChild(warning);
        }
        item.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'rowActions';
        const applyButton = document.createElement('button');
        applyButton.className = active ? '' : 'primary';
        applyButton.textContent = 'Apply';
        applyButton.disabled = busy || !enabled || !provider.hasKey;
        applyButton.addEventListener('click', () => post({ type: 'applyProvider', providerId: provider.id }));
        actions.appendChild(applyButton);
        const configButton = document.createElement('button');
        configButton.textContent = 'Config';
        configButton.disabled = busy || !enabled;
        configButton.addEventListener('click', () => post({ type: 'openProviderConfig', providerId: provider.id }));
        actions.appendChild(configButton);
        const deleteButton = document.createElement('button');
        deleteButton.className = 'danger';
        deleteButton.textContent = 'Delete';
        deleteButton.disabled = busy || !enabled;
        deleteButton.addEventListener('click', () => post({ type: 'deleteProvider', providerId: provider.id }));
        const networkButton = document.createElement('button');
        networkButton.textContent = 'Network & Usage';
        networkButton.disabled = busy || !enabled || !provider.hasKey || (provider.tool === 'codex' && provider.codexMode === 'official');
        networkButton.addEventListener('click', () => post({ type: 'testProviderNetwork', providerId: provider.id }));
        actions.appendChild(networkButton);
        const modelButton = document.createElement('button');
        modelButton.textContent = 'Model';
        modelButton.disabled = busy || !enabled || !provider.hasKey || (provider.tool === 'codex' && provider.codexMode === 'official');
        modelButton.addEventListener('click', () => post({ type: 'updateProviderModel', providerId: provider.id }));
        actions.appendChild(modelButton);
        const verifyButton = document.createElement('button');
        verifyButton.textContent = 'Verify Model';
        verifyButton.disabled = busy || !enabled || !provider.hasKey || (provider.tool === 'codex' && provider.codexMode === 'official') || !hasConfiguredModel(provider.modelPolicy);
        verifyButton.addEventListener('click', () => post({ type: 'verifyProviderModel', providerId: provider.id }));
        actions.appendChild(verifyButton);
        for (const runs of [1, 3]) {
          const speedButton = document.createElement('button');
          speedButton.textContent = runs === 1 ? 'Quick Speed Test' : 'Standard Speed Test';
          speedButton.title = runs + ' real short request(s); uses saved connection settings and model quota; does not Apply';
          const official = provider.codexMode === 'official';
          speedButton.disabled = busy || !enabled || (official ? state.codexMode !== 'official' : !provider.hasKey || !hasConfiguredModel(provider.modelPolicy));
          speedButton.addEventListener('click', () => post({ type: 'speedTest', providerId: provider.id, runs }));
          actions.appendChild(speedButton);
        }
        actions.appendChild(deleteButton);
        item.appendChild(actions);
        container.appendChild(item);
      }
    }

    function fetchModels() {
      const tool = el.tool.value;
      const baseUrl = el.baseUrl.value.trim();
      const key = el.apiKey.value;
      if (!baseUrl || !key) {
        showNotice('URL and key are required before fetching models.', true);
        return;
      }
      try { post({ type: 'previewModels', tool, baseUrl, key, proxy: getProxyConfig('add') }); }
      catch (error) { showAddNotice(error.message, true); }
    }

    function updateAddMode() {
      updateProxyVisibility('add', el.tool.value);
      for (const option of el.tool.options) option.disabled = !state.toolEnabled[option.value];
      if (el.tool.options[el.tool.selectedIndex].disabled) {
        el.tool.value = state.toolEnabled.claude ? 'claude' : 'codex';
      }
      const textMode = el.addMode.value === 'text';
      el.configTextField.hidden = !textMode;
      el.baseUrlField.hidden = textMode;
      el.apiKeyField.hidden = textMode;
      el.modelField.hidden = textMode;
      el.fetchModelsButton.hidden = textMode;
      el.baseUrl.required = !textMode;
      el.apiKey.required = !textMode;
      if (textMode && (templateTool !== el.tool.value || !el.addConfigText.value)) {
        el.addConfigText.value = defaultTemplate(el.tool.value);
        templateTool = el.tool.value;
      }
      if (!textMode) { el.addConfigText.value = ''; templateTool = ''; }
      updateSaveState();
    }

    function defaultTemplate(tool) {
      if (tool === 'claude') return [
        '{',
        '  "$schema": "https://json.schemastore.org/claude-code-settings.json",',
        '  "env": {',
        '    "ANTHROPIC_BASE_URL": "",',
        '    "ANTHROPIC_AUTH_TOKEN": "",',
        '    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",',
        '    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"',
        '  },',
        '  "model": "",',
        '  "effortLevel": ""',
        '}'
      ].join('\\n');
      return [
        'model_provider = "OpenAI"',
        'model = ""',
        '#review_model = ""',
        'model_context_window=1000000',
        'model_auto_compact_token_limit=900000',
        '#model_reasoning_effort = ""',
        'disable_response_storage = true',
        '#model_catalog_json = "~/.codex/codex-models.json"',
        'network_access = "enabled"',
        'windows_wsl_setup_acknowledged = true',
        '',
        '[model_providers.OpenAI]',
        'name = "OpenAI"',
        'base_url = ""',
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'experimental_bearer_token = ""',
        'http_headers = { "x-openai-actor-authorization" = "local-image-extension" }',
        '',
        '[features]',
        'goals = true',
        ''
      ].join('\\n');
    }

    function renderModelOptions() {
      el.modelOptions.textContent = '';
      if (!fetchedModels.length) {
        el.modelSelect.placeholder = 'No list available; enter a model ID';
        updateSaveState();
        return;
      }
      for (const model of fetchedModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.label = model.displayName || model.id;
        el.modelOptions.appendChild(option);
      }
      el.modelSelect.placeholder = 'Select or enter a model ID';
      if (!el.modelSelect.value && fetchedModels[0]) el.modelSelect.value = fetchedModels[0].id;
      updateSaveState();
    }

    function saveProvider() {
      if (el.addMode.value === 'text') {
        if (!el.providerName.value.trim() || !el.addConfigText.value.trim()) {
          showNotice('Name and complete configuration are required.', true);
          return;
        }
        showAddNotice('Saving provider...', false);
        post({ type: 'createProvider', payload: { tool: el.tool.value, name: el.providerName.value.trim(), key: '', baseUrl: '', model: '', applyNow: el.applyNow.checked, configMode: 'custom', configText: el.addConfigText.value, proxy: getProxyConfig('add') } });
        return;
      }
      const payload = {
        tool: el.tool.value,
        name: el.providerName.value.trim(),
        baseUrl: el.baseUrl.value.trim(),
        key: el.apiKey.value,
        model: el.modelSelect.value,
        applyNow: el.applyNow.checked,
        proxy: getProxyConfig('add')
      };
      if (!payload.name || !payload.baseUrl || !payload.key) {
        showNotice('Name, URL, and key are required.', true);
        return;
      }
      post({ type: 'createProvider', payload });
    }

    function resetModels() {
      fetchedModels = [];
      el.modelOptions.textContent = '';
      el.modelSelect.value = '';
      el.modelSelect.placeholder = 'Fetch models or enter an ID';
      updateSaveState();
    }

    function setUsageQuery(config) {
      el.usageEnabled.checked = Boolean(config && config.enabled);
      el.usagePreset.value = config && config.preset ? config.preset : 'auto';
      el.usageUrl.value = config && config.url ? config.url : '{{baseUrl}}/user/balance';
      el.usageRemainingPath.value = config && config.remainingPath ? config.remainingPath : 'balance';
      el.usageUsedPath.value = config && config.usedPath ? config.usedPath : '';
      el.usageTotalPath.value = config && config.totalPath ? config.totalPath : '';
      el.usageUnit.value = config && config.unit ? config.unit : 'USD';
      el.usageDivisor.value = config && config.divisor ? String(config.divisor) : '1';
      el.usageUserId.value = config && config.userId ? config.userId : '';
      el.usageAccessToken.value = '';
      updateUsageVisibility();
    }

    function getUsageQuery() {
      return {
        enabled: el.usageEnabled.checked,
        preset: el.usagePreset.value,
        url: el.usageUrl.value.trim(),
        remainingPath: el.usageRemainingPath.value.trim(),
        usedPath: el.usageUsedPath.value.trim(),
        totalPath: el.usageTotalPath.value.trim(),
        unit: el.usageUnit.value.trim() || 'USD',
        divisor: Number(el.usageDivisor.value) || 1,
        userId: el.usageUserId.value.trim()
      };
    }

    function applyUsagePreset() {
      const preset = el.usagePreset.value;
      if (preset === 'custom') { updateUsageVisibility(); return; }
      const values = {
        auto: ['', '', '', '', 'USD', '1'],
        generic: ['{{baseUrl}}/user/balance', 'balance', '', '', 'USD', '1'],
        deepseek: ['{{baseUrl}}/user/balance', 'balance_infos.0.total_balance', '', '', 'USD', '1'],
        siliconflow: ['{{baseUrl}}/user/info', 'data.balance', '', 'data.totalBalance', 'CNY', '1'],
        openrouter: ['{{baseUrl}}/key', 'data.limit_remaining', 'data.usage', 'data.limit', 'USD', '1'],
        newapi: ['{{baseUrl}}/api/user/self', 'data.quota', 'data.used_quota', '', 'USD', '500000']
      }[preset];
      if (values) {
        [el.usageUrl.value, el.usageRemainingPath.value, el.usageUsedPath.value, el.usageTotalPath.value, el.usageUnit.value, el.usageDivisor.value] = values;
      }
      updateUsageVisibility();
    }

    function updateUsageVisibility() {
      el.usageFields.hidden = !el.usageEnabled.checked;
      el.usageAdvancedFields.hidden = el.usagePreset.value !== 'custom';
      el.newApiFields.hidden = el.usagePreset.value !== 'newapi' && el.usagePreset.value !== 'auto';
    }

    function updateActionState() {
      el.openClaudeButton.disabled = busy || !state.toolEnabled.claude || !findCurrent('claude');
      el.openCodexButton.disabled = busy || !state.toolEnabled.codex || (state.codexMode !== 'official' && !findCurrent('codex'));
      el.viewClaudeConfigButton.disabled = busy;
      el.viewCodexConfigButton.disabled = busy;
      el.refreshClaudeModelsButton.disabled = busy || !state.toolEnabled.claude;
      el.refreshCodexModelsButton.disabled = busy || !state.toolEnabled.codex || state.codexMode === 'official';
      el.testClaudeNetworkButton.disabled = busy || !state.toolEnabled.claude;
      el.testCodexNetworkButton.disabled = busy || !state.toolEnabled.codex || state.codexMode === 'official';
      el.deleteClaudeBackupsButton.disabled = busy || !state.toolEnabled.claude;
      el.deleteCodexBackupsButton.disabled = busy || !state.toolEnabled.codex;
      el.codexOfficialMode.disabled = busy || !state.toolEnabled.codex || state.codexMode === 'official';
      el.codexOfficialMode.title = state.codexMode === 'official' ? 'Official mode is already active; your login is kept.' : 'Switch to official mode, clear the current Codex configuration and sign in again.';
      el.codexApiMode.disabled = busy || !state.toolEnabled.codex || !state.providers.some((provider) => provider.tool === 'codex' && provider.codexMode !== 'official' && provider.hasKey);
      el.quickOfficialSpeedButton.disabled = busy || !state.toolEnabled.codex || state.codexMode !== 'official';
      el.standardOfficialSpeedButton.disabled = el.quickOfficialSpeedButton.disabled;
    }

    function updateSaveState() {
      el.saveButton.disabled = busy || !state.toolEnabled[el.tool.value] || (el.addMode.value === 'text' && !el.addConfigText.value.trim());
    }

    function setBusy(nextBusy) {
      busy = nextBusy;
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        button.disabled = nextBusy;
      }
      render();
    }

    function findCurrent(tool) {
      const id = state.currentProviderIds[tool];
      return state.providers.find((provider) => provider.id === id);
    }

    function labelTool(tool) {
      return tool === 'claude' ? 'Claude Code' : 'Codex';
    }

    function labelModel(policy) {
      if (!policy || policy.type === 'toolDefault') return 'NULL';
      if (policy.type === 'providerAuto') return policy.preferred ? 'Auto: ' + policy.preferred : 'NULL';
      return policy.model || 'NULL';
    }

    function hasConfiguredModel(policy) {
      if (!policy || policy.type === 'toolDefault') return false;
      if (policy.type === 'providerAuto') return Boolean(policy.preferred);
      return Boolean(policy.model);
    }

    function labelStatus(kind) {
      if (kind === 'signedIn') return 'Signed in';
      if (kind === 'loginRequired') return 'Login required';
      if (kind === 'unactivated') return 'Unactivated';
      if (kind === 'networkError') return 'Network error';
      if (kind === 'missingKey') return 'Key missing';
      if (kind === 'modelsStale') return 'Models stale';
      if (kind === 'degraded') return 'Degraded';
      if (kind === 'ready') return 'Ready';
      return 'Off';
    }

    function labelMode(mode) {
      return mode === 'official' ? 'Official account' : mode === 'api' ? 'API' : 'Unknown';
    }

    function formatNetwork(result) {
      if (result.cancelled) return 'Network: Cancelled';
      const dns = formatDns(result);
      if (result.reachable === false) {
        const stage = result.failureStage === 'dns' ? 'DNS error' : 'Transport error';
        return 'Network: Unreachable | ' + stage + ' | ' + (result.error || 'Failed') + dns;
      }
      if (result.reachable === undefined && !result.ok) {
        return 'Network: Not tested | ' + (result.error || 'Failed') + dns;
      }
      const parts = ['Network: Reachable'];
      if (result.modelsApi === 'available') {
        parts.push('Models API: Available');
        if (result.modelCount !== undefined) parts.push(result.modelCount + ' models');
      } else if (result.modelsApi === 'httpError') {
        parts.push('Models API: ' + (result.modelsError || 'HTTP error'));
      } else if (result.modelsApi === 'unreachable') {
        parts.push('Models API: Unavailable');
      }
      if (result.httpStatus !== undefined) parts.push('HTTP ' + result.httpStatus);
      if (result.latencyMs !== undefined) parts.push(result.latencyMs + ' ms');
      if (result.responseBytes !== undefined) parts.push(formatBytes(result.responseBytes) + ' response');
      if (result.endpoint) parts.push('Endpoint: ' + result.endpoint);
      return parts.join(' | ') + dns;
    }

    function formatDns(result) {
      if (result.dnsError) return ' | DNS: ' + result.dnsError;
      if (!result.resolvedAddresses || !result.resolvedAddresses.length) return '';
      const mode = result.dnsMode === 'vpnFakeIp'
        ? ' (VPN Fake-IP)'
        : result.dnsMode === 'loopback' ? ' (container loopback)' : '';
      return ' | DNS: ' + result.resolvedAddresses.join(', ') + mode;
    }

    function compatibilityFailureLabel(kind) {
      if (kind === 'network') return 'Network error';
      if (kind === 'authentication') return 'Authentication error';
      if (kind === 'unsupported') return 'Unsupported endpoint';
      if (kind === 'request') return 'Request rejected';
      return 'Failed';
    }

    function renderDiagnostics(container, network, usage, usageEnabled, report) {
      container.textContent = '';
      // All diagnostic values, including model IDs and errors, stay plain text.
      const add = (parent, tag, className, text) => {
        const node = document.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        parent.appendChild(node); return node;
      };
      const row = (label, values, warning) => {
        const line = add(container, 'div', 'diagnosticRow' + (warning ? ' diagnosticWarning' : ''));
        add(line, 'span', 'diagnosticLabel', label);
        const body = add(line, 'div', 'diagnosticValues');
        for (const value of values) add(body, 'span', 'diagnosticValue', value);
      };
      const info = [];
      const time = value => new Date(value).toLocaleString();
      if (network) {
        const values = [network.cancelled ? 'Cancelled' : network.reachable === false ? 'Unreachable' : network.reachable === undefined && !network.ok ? 'Not tested' : 'Reachable'];
        if (network.failureStage === 'dns') values.push('DNS error');
        if (network.latencyMs !== undefined) values.push(network.latencyMs + ' ms');
        if (network.httpStatus !== undefined) values.push('HTTP ' + network.httpStatus);
        if (network.modelsApi === 'available') values.push(network.modelCount === undefined ? 'Models OK' : network.modelCount + ' models');
        if (network.modelsApi === 'httpError') values.push('Models error');
        if (network.modelsApi === 'unreachable') values.push('Models unavailable');
        row('Network', values, !network.ok || network.modelsApi === 'httpError' || network.modelsApi === 'unreachable');
        info.push(formatNetwork(network) + ' | Checked: ' + time(network.checkedAt));
      }
      if (network || usage || usageEnabled) {
        const values = usage ? usage.ok ? ['Remaining ' + usage.remaining + (usage.unit ? ' ' + usage.unit : '')] : [usage.error === 'Cancelled' ? 'Cancelled' : 'Unavailable'] : [usageEnabled ? 'Not tested' : 'Not enabled'];
        if (usage && !usage.ok && usage.httpStatus !== undefined) values.push('HTTP ' + usage.httpStatus);
        row('Usage', values, usage && !usage.ok);
        if (usage) info.push(formatUsage(usage) + ' | Checked: ' + time(usage.checkedAt));
      }
      if (report) {
        const summary = report.summary;
        const rate = (value, unit) => summary.comparable && summary.succeeded > 0 && Number.isFinite(value) ? value.toFixed(2) + unit : 'N/A';
        const values = ['Output ' + rate(summary.generationMedianTps, ' tok/s'), 'TTFT ' + rate(summary.ttftMedianMs === null ? null : summary.ttftMedianMs / 1000, ' s'), 'Overall ' + rate(summary.endToEndMedianTps, ' tok/s'), summary.succeeded + '/' + report.parameters.runs + ' passed', 'estimated'];
        const stale = Date.now() - Date.parse(report.finishedAt) > 15 * 60 * 1000;
        const buffered = report.rounds.some(round => round.metrics && round.metrics.timingSource === 'buffered-proxy');
        if (stale) values.push('Stale');
        if (summary.failed) values.push(summary.failed + ' failed');
        if (summary.cancelled) values.push(summary.cancelled + ' cancelled');
        if (!summary.comparable && summary.succeeded) values.push('Mixed conditions');
        if (buffered) values.push('Buffered stream');
        else if (summary.succeeded && summary.comparable && summary.generationMedianTps === null) values.push('Output timing unavailable');
        row('Speed', values, stale || summary.failed || summary.cancelled || !summary.comparable);
        const models = Array.from(new Set(report.rounds.filter(round => round.metrics).map(round => round.metrics.actualModel))).join(', ');
        info.push('Speed: ' + time(report.finishedAt) + ' | Model: ' + (models || report.target.model));
        info.push('Output = visible-text generation rate; TTFT = request to first text; Overall = throughput including first-text wait. tok/s means tokens per second, estimated locally. Comparable successful samples only; medians shown. Client startup and session preparation are excluded.');
        if (buffered) info.push('The proxy buffers or rebuilds the stream; original generation timing is unavailable.');
        else if (summary.succeeded && summary.comparable && summary.generationMedianTps === null) info.push('Text arrived in one batch or the timing interval was too short; no output rate is available.');
        if (!summary.comparable && summary.succeeded) info.push('Mixed models or measurement conditions; aggregate metrics are suppressed.');
        info.push('Fixed short-text benchmark, not live conversation monitoring. For work efficiency, compare time to a correct completed task on the same task and acceptance criteria.');
      }
      if (!container.children.length) return;
      const details = add(container, 'details', 'diagnosticDetails');
      add(details, 'summary', '', 'Details');
      for (const text of info) add(details, 'p', '', text);
      if (report) {
        const query = add(details, 'button', '', 'Copy AI Speed Query');
        query.type = 'button'; query.disabled = busy;
        query.title = 'Choose a tool and copy a read-only command for its current provider. Reads stored results; no new model request.';
        query.addEventListener('click', () => post({ type: 'copySpeedQuery' }));
      }
    }

    function formatBytes(value) {
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function formatUsage(result) {
      if (!result) return 'Quota: Unsupported';
      if (!result.ok) {
        const attempts = result.attempts && result.attempts.length ? ' | Tried ' + result.attempts.length + ' endpoints' : '';
        return 'Quota: ' + (result.error || 'Query failed') + attempts;
      }
      const unit = result.unit || '';
      const parts = ['Quota: ' + result.remaining + ' ' + unit];
      if (result.used !== undefined) parts.push('used ' + result.used);
      if (result.total !== undefined) parts.push('total ' + result.total);
      if (result.strategy) parts.push(result.strategy);
      if (result.endpoint) parts.push('Endpoint: ' + result.endpoint);
      return parts.join(' | ');
    }

    function post(message) {
      vscode.postMessage(message);
    }

    function showNotice(message, isError) {
      el.notice.textContent = message;
      el.notice.classList.toggle('error', isError);
      el.notice.classList.add('visible');
      if (isError) el.notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.setTimeout(() => el.notice.classList.remove('visible'), isError ? 7000 : 3500);
    }

    function showAddNotice(message, isError) {
      el.addNotice.textContent = message;
      el.addNotice.classList.toggle('error', isError);
      el.addNotice.classList.remove('warning');
      el.addNotice.classList.add('visible');
    }

    function showAddWarning(message) {
      el.addNotice.textContent = message;
      el.addNotice.classList.remove('error');
      el.addNotice.classList.add('warning', 'visible');
    }

    function proxyElement(prefix, name) { return document.getElementById(prefix + 'Proxy' + name); }
    function updateProxyVisibility(prefix, tool) {
      proxyElement(prefix, '').hidden = false;
      proxyElement(prefix, 'ApiFormatField').hidden = tool !== 'codex';
      if (tool !== 'codex') proxyElement(prefix, 'ApiFormat').value = 'anthropic';
      const responses = proxyElement(prefix, 'ApiFormat').value === 'responses';
      proxyElement(prefix, 'ResponsesNote').hidden = !responses;
      for (const name of ['extraThinkingBudget', 'maxThinkingBudget']) proxyElement(prefix, name).disabled = responses;
      proxyElement(prefix, 'Options').hidden = proxyElement(prefix, 'Mode').value !== 'proxy';
    }
    function setProxyConfig(prefix, config) {
      const tool = prefix === 'add' ? el.tool.value : configEditorTool;
      config = config || { mode: 'direct', preset: 'justdowork' };
      proxyElement(prefix, 'Mode').value = config.mode;
      proxyElement(prefix, 'Preset').value = config.preset;
      const apiFormat = config.apiFormat || (tool === 'codex' ? 'responses' : 'anthropic');
      proxyElement(prefix, 'ApiFormat').value = apiFormat;
      const values = Object.assign({}, proxyPresets[apiFormat][config.preset], config.overrides || {});
      for (const key of Object.keys(values)) {
        const field = proxyElement(prefix, key);
        if (!field) continue;
        if (field.type === 'checkbox') field.checked = values[key];
        else field.value = typeof values[key] === 'object' ? JSON.stringify(values[key], null, 2) : String(values[key]);
      }
      updateProxyVisibility(prefix, prefix === 'add' ? el.tool.value : configEditorTool);
    }
    function getProxyConfig(prefix) {
      const preset = proxyElement(prefix, 'Preset').value;
      const apiFormat = proxyElement(prefix, 'ApiFormat').value;
      const defaults = proxyPresets[apiFormat][preset], overrides = {};
      for (const key of Object.keys(defaults)) {
        const field = proxyElement(prefix, key);
        if (!field) continue;
        let value;
        if (field.type === 'checkbox') value = field.checked;
        else if (typeof defaults[key] === 'number') value = Number(field.value);
        else if (typeof defaults[key] === 'object') {
          try { value = JSON.parse(field.value); } catch { throw new Error('Invalid JSON in proxy setting: ' + key); }
        } else value = field.value;
        if (JSON.stringify(value) !== JSON.stringify(defaults[key])) overrides[key] = value;
      }
      return { mode: proxyElement(prefix, 'Mode').value, preset, apiFormat, overrides };
    }
    for (const prefix of ['add', 'edit']) {
      proxyElement(prefix, 'Mode').addEventListener('change', () => updateProxyVisibility(prefix, prefix === 'add' ? el.tool.value : configEditorTool));
      const reset = () => setProxyConfig(prefix, { mode: proxyElement(prefix, 'Mode').value, preset: proxyElement(prefix, 'Preset').value, apiFormat: proxyElement(prefix, 'ApiFormat').value, overrides: {} });
      proxyElement(prefix, 'ApiFormat').addEventListener('change', reset);
      proxyElement(prefix, 'Preset').addEventListener('change', reset);
      proxyElement(prefix, 'Reset').addEventListener('click', reset);
      setProxyConfig(prefix);
    }
    updateAddMode();
    resetModels();
    post({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function renderProxyFields(prefix: string): string {
  const id = (name: string) => `${prefix}Proxy${name}`;
  const numbers = [
    ['timeoutMs', 'Request timeout (ms)', 1000, 900000], ['maxAttempts', 'Maximum attempts', 1, 5],
    ['keepAliveMs', 'Keepalive interval (ms)', 100, 60000], ['maxHistoryChars', 'History character budget (0 = unlimited)', 0, ''],
    ['maxToolResultChars', 'Tool result characters (0 = unlimited)', 0, ''], ['maxOutputTokens', 'Output token cap (0 = client limit)', 0, ''],
    ['toolDescriptionChars', 'Tool description characters (0 = full)', 0, ''], ['extraThinkingBudget', 'Extra thinking tokens (0 = follow client)', 0, ''],
    ['maxThinkingBudget', 'Thinking token cap (0 = client limit)', 0, ''], ['webSearchResults', 'Web search result count', 1, 10],
    ['webFetchMaxChars', 'Web fetch characters (0 = unlimited)', 0, ''], ['maxWebIterations', 'Maximum web tool rounds', 1, 5]
  ];
  const flags = [
    ['rebuildStream', 'Rebuild the response stream'], ['toolInjection', 'Use text protocol for unmapped tools'],
    ['repairToolJson', 'Repair malformed tool JSON'], ['cacheSystemPrefix', 'Add a system cache breakpoint'],
    ['webTools', 'Let the proxy execute web search / fetch']
  ];
  return `<div id="${id('')}" class="proxySettings">
    <div class="field"><label for="${id('Mode')}">Connection mode</label><select id="${id('Mode')}"><option value="direct">Direct connection</option><option value="proxy">Built-in proxy</option></select></div>
    <div id="${id('Options')}" class="proxyOptions" hidden>
      <div id="${id('ApiFormatField')}" class="field" hidden><label for="${id('ApiFormat')}">Upstream API format</label><select id="${id('ApiFormat')}"><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages (translate Codex requests)</option></select><div class="small">Choose the API your provider serves. Changing the format restores that format's preset defaults. Anthropic translation needs full history and stream rebuilding; hosted OpenAI tools and encrypted OpenAI state require Responses.</div></div>
      <div class="field"><label for="${id('Preset')}">Compatibility preset</label><select id="${id('Preset')}"><option value="justdowork">justdowork</option><option value="custom">Custom upstream</option></select></div>
      <div class="small">Enter the real upstream URL and key above. The local endpoint is generated on Apply. Keep this VS Code window open while using the proxy.</div>
      <details><summary>Advanced proxy settings</summary><div class="field">
        <button id="${id('Reset')}" type="button">Restore preset defaults</button>
        <label for="${id('messagesPath')}">Upstream API path</label><input id="${id('messagesPath')}" type="text">
        <label for="${id('authMode')}">Upstream authentication</label><select id="${id('authMode')}"><option value="both">Bearer + x-api-key</option><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="custom">Custom header</option></select>
        <label for="${id('authHeader')}">Custom authentication header name (key comes from SecretStorage)</label><input id="${id('authHeader')}" type="text">
        ${['headers', 'parameters', 'nativeToolMap'].map(name => `<label for="${id(name)}">${name === 'headers' ? 'Additional headers (JSON, no credentials)' : name === 'parameters' ? 'Additional request parameters (JSON)' : 'Native tool name map (JSON)'}</label><textarea id="${id(name)}" spellcheck="false"></textarea>`).join('')}
        ${flags.map(([name, label]) => `<label class="check"><input id="${id(name)}" type="checkbox"> ${label}</label>`).join('')}
        ${numbers.map(([name, label, min, max]) => `<label for="${id(String(name))}">${label}</label><input id="${id(String(name))}" type="number" min="${min}" ${max !== '' ? `max="${max}"` : ''} step="1">`).join('')}
        <div id="${id('ResponsesNote')}" class="small" hidden>Responses uses reasoning.effort (for example {"reasoning":{"effort":"high"}} in additional parameters), not numeric thinking budgets. System caching sets a stable prompt_cache_key; the upstream decides whether to cache. Native function and custom tools, images and encrypted reasoning retain their Responses formats.</div>
        <div class="small">Overrides apply only to this provider. History/tool-output limits may omit context; omissions are marked. Stream rebuilding is required for tool mapping and proxy web tools.</div>
      </div></details>
    </div>
  </div>`;
}

export async function toSidebarSummary(
  provider: ProviderProfile,
  hasSecret: (provider: ProviderProfile) => Promise<boolean>,
  networkTest?: NetworkTestResult,
  usageResult?: UsageQueryResult,
  compatibility?: CompatibilityResult,
  proxyRuntime?: ProxyRuntime,
  needsApply?: boolean
): Promise<SidebarProviderSummary> {
  return {
    id: provider.id,
    name: provider.name,
    tool: provider.tool,
    baseUrl: provider.baseUrl,
    modelPolicy: provider.modelPolicy,
    hasKey: await hasSecret(provider),
    configMode: provider.configMode ?? 'generated',
    networkTest,
    usageResult,
    usageEnabled: provider.usageQuery?.enabled === true,
    compatibility,
    proxy: provider.proxy, proxyRuntime, needsApply, codexMode: provider.codexMode
  };
}

function labelTool(tool: ToolId): string {
  return tool === 'claude' ? 'Claude Code' : 'Codex';
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object' || !('causeText' in error)) return message;
  const causeText = (error as { causeText?: unknown }).causeText;
  return typeof causeText === 'string' && causeText.trim() ? `${message}: ${causeText}` : message;
}
