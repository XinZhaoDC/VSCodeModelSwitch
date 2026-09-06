import * as vscode from 'vscode';
import { ApiStatusRow, CompatibilityResult, ModelInfo, ModelPolicy, NetworkTestResult, ProviderProfile, StatusState, ToolId, UsageQueryConfig, UsageQueryResult } from '../types';

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
}

export interface SidebarViewState {
  providers: SidebarProviderSummary[];
  currentProviderIds: Partial<Record<ToolId, string>>;
  status: StatusState;
  globalCliSync: boolean;
  configTarget: string;
  configPaths: Record<ToolId, string>;
  toolEnabled: Record<ToolId, boolean>;
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
}

export interface SidebarController {
  getSidebarState(): Promise<SidebarViewState>;
  reloadStateFromSidebar(): Promise<void>;
  previewModelsFromSidebar(tool: ToolId, baseUrl: string, key: string): Promise<ModelInfo[]>;
  createProviderFromSidebar(input: CreateProviderInput): Promise<void>;
  setCurrentProviderFromSidebar(providerId: string): Promise<void>;
  getProviderConfigFromSidebar(providerId: string): Promise<{ providerId: string; tool: ToolId; text: string; hasKey: boolean; usageQuery: UsageQueryConfig; usageHasToken: boolean }>;
  saveProviderConfigFromSidebar(providerId: string, text: string, key?: string, usageQuery?: UsageQueryConfig, usageAccessToken?: string): Promise<void>;
  applyProviderFromSidebar(providerId: string): Promise<void>;
  deleteProviderFromSidebar(providerId: string): Promise<void>;
  moveProviderFromSidebar(providerId: string, beforeProviderId: string): Promise<void>;
  testProviderNetworkFromSidebar(providerId: string): Promise<void>;
  testToolNetworkFromSidebar(tool: ToolId): Promise<void>;
  testUsageQueryFromSidebar(providerId: string, usageQuery: UsageQueryConfig, usageAccessToken?: string): Promise<void>;
  verifyProviderModelFromSidebar(providerId: string): Promise<void>;
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
  | { type: 'ready' }
  | { type: 'previewModels'; tool: ToolId; baseUrl: string; key: string }
  | { type: 'createProvider'; payload: CreateProviderInput }
  | { type: 'setCurrentProvider'; providerId: string }
  | { type: 'openProviderConfig'; providerId: string }
  | { type: 'saveProviderConfig'; providerId: string; text: string; key?: string; usageQuery?: UsageQueryConfig; usageAccessToken?: string }
  | { type: 'applyProvider'; providerId: string }
  | { type: 'deleteProvider'; providerId: string }
  | { type: 'moveProvider'; providerId: string; beforeProviderId: string }
  | { type: 'testProviderNetwork'; providerId: string }
  | { type: 'testToolNetwork'; tool: ToolId }
  | { type: 'testUsageQuery'; providerId: string; usageQuery: UsageQueryConfig; usageAccessToken?: string }
  | { type: 'verifyProviderModel'; providerId: string }
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
          const models = await this.controller.previewModelsFromSidebar(message.tool, message.baseUrl, message.key);
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
                  await this.controller.saveProviderConfigFromSidebar(message.providerId, message.text, message.key, message.usageQuery, message.usageAccessToken);
                  await this.view?.webview.postMessage({ type: 'configSaved', text: message.text, usageQuery: message.usageQuery });
                  await this.postNotice('Provider configuration saved.');
                  break;
                case 'applyProvider':
                  await this.controller.applyProviderFromSidebar(message.providerId);
                  await this.postNotice('Provider applied.');
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
    .statusGrid { display: grid; grid-template-columns: 0.7fr 1fr 1.3fr 0.8fr; gap: 5px 8px; overflow-x: auto; }
    .statusRows { display: contents; }
    .statusGrid > div { min-width: 0; overflow-wrap: anywhere; }
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
    .empty {
      padding: 9px;
      border-style: dashed;
      color: var(--vscode-descriptionForeground);
    }
    .small { color: var(--vscode-descriptionForeground); font-size: 12px; }
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
        <div class="statusHead">API</div><div class="statusHead">Provider Name</div><div class="statusHead">Model ID</div><div class="statusHead">Status</div>
        <div id="statusRows" class="statusRows">Loading...</div>
      </div>
      <div id="syncStatus" class="syncStatus"></div>
      <div id="storageStatus" class="syncStatus"></div>
    </div>
    <div id="notice" class="notice"></div>
    <section id="configEditor" class="section" hidden>
      <h2>Provider Configuration</h2>
      <div class="panel">
        <div id="configEditorTool" class="small"></div>
        <textarea id="configText" spellcheck="false"></textarea>
        <div class="field">
          <label for="configKey">API Key</label>
          <input id="configKey" type="password" placeholder="Leave empty to keep the stored key" autocomplete="off">
        </div>
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
    let state = {
      providers: [],
      currentProviderIds: {},
      status: { kind: 'off' },
      globalCliSync: true,
      configTarget: 'real',
      configPaths: { claude: '', codex: '' },
      toolEnabled: { claude: true, codex: true },
      apiStatuses: [],
      storageSizes: { logBytes: 0, backupBytes: 0, claudeBackupBytes: 0, codexBackupBytes: 0 }
    };
    let busy = false;
    let fetchedModels = [];
    let configEditorProviderId = '';
    let configEditorTool = '';
    let templateTool = '';
    let configOriginalText = '';
    let configOriginalKey = '';
    let configOriginalUsage = undefined;
    const savedViewState = vscode.getState() || {};
    const collapsed = { claude: Boolean(savedViewState.claudeCollapsed), codex: Boolean(savedViewState.codexCollapsed) };

    const el = {
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
      addMode: document.getElementById('addMode'),
      configTextField: document.getElementById('configTextField'),
      addConfigText: document.getElementById('addConfigText'),
      baseUrlField: document.getElementById('baseUrlField'),
      apiKeyField: document.getElementById('apiKeyField'),
      modelField: document.getElementById('modelField'),
      configEditor: document.getElementById('configEditor'),
      configEditorTool: document.getElementById('configEditorTool'),
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
        el.configEditor.hidden = false;
        el.configText.focus();
        return;
      }
      if (message.type === 'configSaved') {
        configOriginalText = message.text;
        configOriginalKey = '';
        configOriginalUsage = message.usageQuery;
        el.configKey.value = '';
        return;
      }
      if (message.type === 'busy') {
        busy = message.busy;
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
    el.addMode.addEventListener('change', updateAddMode);
    el.tool.addEventListener('change', () => { resetModels(); updateAddMode(); });
    el.addConfigText.addEventListener('input', updateSaveState);
    el.saveConfigButton.addEventListener('click', () => post({ type: 'saveProviderConfig', providerId: configEditorProviderId, text: el.configText.value, key: el.configKey.value, usageQuery: getUsageQuery(), usageAccessToken: el.usageAccessToken.value }));
    el.usageEnabled.addEventListener('change', updateUsageVisibility);
    el.usagePreset.addEventListener('change', applyUsagePreset);
    el.testUsageButton.addEventListener('click', () => post({ type: 'testUsageQuery', providerId: configEditorProviderId, usageQuery: getUsageQuery(), usageAccessToken: el.usageAccessToken.value }));
    el.cancelConfigButton.addEventListener('click', () => {
      el.configText.value = configOriginalText;
      el.configKey.value = configOriginalKey;
      setUsageQuery(configOriginalUsage);
    });
    el.closeConfigButton.addEventListener('click', () => {
      el.configText.value = configOriginalText;
      el.configKey.value = configOriginalKey;
      setUsageQuery(configOriginalUsage);
      el.configEditor.hidden = true;
    });
    el.fetchModelsButton.addEventListener('click', () => fetchModels());
    el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveProvider();
    });
    el.baseUrl.addEventListener('input', resetModels);
    el.apiKey.addEventListener('input', resetModels);
      el.modelSelect.addEventListener('input', updateSaveState);

    function render() {
      renderStatus();
      renderProviderList('claude', el.claudeProviders, state.toolEnabled.claude);
      renderProviderList('codex', el.codexProviders, state.toolEnabled.codex);
      el.claudePath.textContent = 'Config: ' + state.configPaths.claude;
      el.codexPath.textContent = 'Config: ' + state.configPaths.codex;
      el.claudeEnabled.checked = state.toolEnabled.claude;
      el.codexEnabled.checked = state.toolEnabled.codex;
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
        const api = document.createElement('div'); api.textContent = labelTool(row.tool);
        const provider = document.createElement('div'); provider.textContent = row.providerName || 'NULL';
        const model = document.createElement('div'); model.textContent = row.model || 'NULL';
        const status = document.createElement('div'); status.textContent = labelStatus(row.status);
        el.statusRows.append(api, provider, model, status);
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
        if (provider.compatibility) {
          const compatibility = document.createElement('div');
          compatibility.className = provider.compatibility.ok ? 'providerModel' : 'providerWarning';
          compatibility.textContent = provider.compatibility.ok
            ? 'Compatibility: Passed | ' + provider.compatibility.latencyMs + ' ms'
            : 'Compatibility: ' + compatibilityFailureLabel(provider.compatibility.failureKind) + ' | ' + (provider.compatibility.error || 'Failed');
          meta.appendChild(compatibility);
        }
        if (provider.networkTest) {
          const network = document.createElement('div');
          const networkWarning = provider.networkTest.reachable === false ||
            provider.networkTest.modelsApi === 'httpError' ||
            provider.networkTest.modelsApi === 'unreachable';
          network.className = networkWarning ? 'providerWarning' : 'providerModel';
          network.textContent = formatNetwork(provider.networkTest);
          meta.appendChild(network);
        }
        if (provider.networkTest || provider.usageResult || provider.usageEnabled) {
          const quota = document.createElement('div');
          quota.className = provider.usageResult && !provider.usageResult.ok ? 'providerWarning' : 'providerModel';
          quota.textContent = formatUsage(provider.usageResult);
          meta.appendChild(quota);
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
        networkButton.disabled = busy || !enabled || !provider.hasKey;
        networkButton.addEventListener('click', () => post({ type: 'testProviderNetwork', providerId: provider.id }));
        actions.appendChild(networkButton);
        const modelButton = document.createElement('button');
        modelButton.textContent = 'Model';
        modelButton.disabled = busy || !enabled || !provider.hasKey;
        modelButton.addEventListener('click', () => post({ type: 'updateProviderModel', providerId: provider.id }));
        actions.appendChild(modelButton);
        const verifyButton = document.createElement('button');
        verifyButton.textContent = 'Verify Model';
        verifyButton.disabled = busy || !enabled || !provider.hasKey || !hasConfiguredModel(provider.modelPolicy);
        verifyButton.addEventListener('click', () => post({ type: 'verifyProviderModel', providerId: provider.id }));
        actions.appendChild(verifyButton);
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
      post({ type: 'previewModels', tool, baseUrl, key });
    }

    function updateAddMode() {
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
        post({ type: 'createProvider', payload: { tool: el.tool.value, name: el.providerName.value.trim(), key: '', baseUrl: '', model: '', applyNow: el.applyNow.checked, configMode: 'custom', configText: el.addConfigText.value } });
        return;
      }
      const payload = {
        tool: el.tool.value,
        name: el.providerName.value.trim(),
        baseUrl: el.baseUrl.value.trim(),
        key: el.apiKey.value,
        model: el.modelSelect.value,
        applyNow: el.applyNow.checked
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
      el.openCodexButton.disabled = busy || !state.toolEnabled.codex || !findCurrent('codex');
      el.viewClaudeConfigButton.disabled = busy;
      el.viewCodexConfigButton.disabled = busy;
      el.refreshClaudeModelsButton.disabled = busy || !state.toolEnabled.claude;
      el.refreshCodexModelsButton.disabled = busy || !state.toolEnabled.codex;
      el.testClaudeNetworkButton.disabled = busy || !state.toolEnabled.claude;
      el.testCodexNetworkButton.disabled = busy || !state.toolEnabled.codex;
      el.deleteClaudeBackupsButton.disabled = busy || !state.toolEnabled.claude;
      el.deleteCodexBackupsButton.disabled = busy || !state.toolEnabled.codex;
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
      if (kind === 'unactivated') return 'Unactivated';
      if (kind === 'networkError') return 'Network error';
      if (kind === 'missingKey') return 'Key missing';
      if (kind === 'modelsStale') return 'Models stale';
      if (kind === 'degraded') return 'Degraded';
      if (kind === 'ready') return 'Ready';
      return 'Off';
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

export async function toSidebarSummary(
  provider: ProviderProfile,
  hasSecret: (provider: ProviderProfile) => Promise<boolean>,
  networkTest?: NetworkTestResult,
  usageResult?: UsageQueryResult,
  compatibility?: CompatibilityResult
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
    compatibility
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
