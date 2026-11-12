import { createClientRegistry } from '../clients';
import type { ClientModule } from '../shell/clientRegistry';
import { renderProxyFields } from '../shared/ui/proxyFields';
import { ClientRegistry } from '../shell/clientRegistry';
import type { OrganizationAction } from '../clients/codex/organizationController';
import type { OrganizationView } from '../shared/providers/organization';
import { localeScript, userFacingError } from './locale';
import { OfficialCodexInfo } from '../clients/codex/diagnostics/info';
import { ReloadNotice } from '../storage/reloadState';
import { sessionPanelHtml, sessionPanelScript, storagePanelHtml } from '../clients/codex/sessionView';
import { SessionAction, SessionState } from '../clients/codex/history/controller';
import * as vscode from 'vscode';
import { ApiStatusRow, CodexMode, CompatibilityResult, ModelInfo, ModelPolicy, NetworkTestResult, ProviderProfile, ProxyConfig, ProxyRuntime, StatusState, ToolId, UsageQueryConfig, UsageQueryResult } from '../types';
import { proxyDefaults } from '../proxy/config';
import { SpeedReport } from '../speed/types';
import { NetworkProxyState } from '../network/manager';
import { NetworkProxyConfig } from '../network/transport';
import { randomUUID } from 'crypto';
import { OperationEvent, operationFailure } from '../storage/operationLog';

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
  groupId?: string;
  disabled?: boolean;
  groupDisabled?: boolean;
  codexMode?: CodexMode;
  speedResult?: SpeedReport;
}

export interface SidebarViewState {
  codexOrganization?: OrganizationView;
  reloadNotices?: ReloadNotice[];
  networkPresets?: Partial<Record<ToolId, Array<NetworkProxyConfig & { name: string }>>>;
  networkProxy?: NetworkProxyState;
  sessions?: SessionState;
  lastBatch?: { tool: ToolId; providerIds: string[]; at: number };
  officialInfo?: OfficialCodexInfo;
  officialSpeedResult?: SpeedReport;
  speedDirectory: string;
  logDirectory: string;
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
  groupId?: string;
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
  organizationActionFromSidebar(input: OrganizationAction): Promise<Record<string, unknown>>;
  recordOperation(event: OperationEvent): Promise<void>;
  logActionFromSidebar(action: 'view' | 'folder' | 'export'): Promise<void>;
  sessionActionFromSidebar(action: SessionAction, id?: string, file?: string): Promise<void>;
  applyNetworkProxyFromSidebar(config: NetworkProxyConfig, tool?: ToolId): Promise<void>;
  restoreNetworkProxyFromSidebar(tool?: ToolId): Promise<void>;
  testNetworkProxyFromSidebar(config: NetworkProxyConfig, tool?: ToolId): Promise<void>;
  networkClipboardFromSidebar(tool: ToolId, action: 'copy' | 'paste', input?: NetworkProxyConfig): Promise<NetworkProxyConfig | undefined>;
  networkPresetFromSidebar(tool: ToolId, action: 'save' | 'delete', input?: NetworkProxyConfig, name?: string): Promise<void>;
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
  officialInfoFromSidebar(): Promise<void>;
  refreshProviderModelsFromSidebar(providerId: string): Promise<void>;
  speedTestFromSidebar(providerId: string | undefined, runs: 1 | 3): Promise<void>;
  copySpeedQuery(): Promise<void>;
  deleteBackupsFromSidebar(tool: ToolId): Promise<void>;
  setToolEnabledFromSidebar(tool: ToolId, enabled: boolean): Promise<void>;
  updateProviderModelFromSidebar(providerId: string): Promise<void>;
  refreshModelsFromSidebar(tool?: ToolId): Promise<void>;
  openClaudeTerminalFromSidebar(): Promise<void>;
  openCodexTerminalFromSidebar(): Promise<void>;
  viewConfigFromSidebar(tool: ToolId): Promise<void>;
  exportPublicConfigFromSidebar(tool?: ToolId): Promise<void>;
  importPublicConfigFromSidebar(tool?: ToolId): Promise<void>;
  clearLogFromSidebar(): Promise<boolean>;
}

export type IncomingMessage = (
  | { type: 'sessionAction'; action: SessionAction; identityId?: string; file?: string }
  | { type: 'applyNetworkProxy'; config: NetworkProxyConfig; tool?: ToolId }
  | { type: 'restoreNetworkProxy'; tool?: ToolId }
  | { type: 'testNetworkProxy'; config: NetworkProxyConfig; tool?: ToolId }
  | { type: 'networkClipboard'; tool: ToolId; action: 'copy' | 'paste'; config?: NetworkProxyConfig }
  | { type: 'networkPreset'; tool: ToolId; action: 'save' | 'delete'; config?: NetworkProxyConfig; name?: string }
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
  | { type: 'officialInfo' }
  | { type: 'refreshProviderModels'; providerId: string }
  | { type: 'speedTest'; providerId?: string; runs: 1 | 3 }
  | { type: 'copySpeedQuery' }
  | { type: 'deleteBackups'; tool: ToolId }
  | { type: 'setToolEnabled'; tool: ToolId; enabled: boolean }
  | { type: 'updateProviderModel'; providerId: string }
  | { type: 'refreshModels'; tool?: ToolId }
  | { type: 'openClaudeTerminal' }
  | { type: 'openCodexTerminal' }
  | { type: 'viewConfig'; tool: ToolId }
  | { type: 'exportPublicConfig'; tool?: ToolId }
  | { type: 'importPublicConfig'; tool?: ToolId }
  | { type: 'clearLog' }
  | { type: 'clientAction'; action: string; payload?: unknown }
  | { type: 'organizationAction'; input: OrganizationAction }
  | { type: 'logAction'; action: 'view' | 'folder' | 'export' }
  ) & { target?: string; page?: string; automatic?: boolean };

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'vscodemodelswitch.providerView';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private handling = false;
  readonly clients: ClientRegistry;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: SidebarController,
    additionalClients: ClientModule[] = []
  ) {
    const reply = (message: unknown) => this.view?.webview.postMessage(message);
    this.clients = createClientRegistry(controller, reply, additionalClients);
  }

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
    const page = message.page ?? ('tool' in message && message.tool ? message.tool : 'codex');
    const target = feedbackTarget(message, page);
    if (this.handling) {
      await this.postFeedback(target, page, 'cancelled', '已有操作正在执行，请等待完成。');
      return;
    }
    this.handling = true;
    const id = randomUUID(), started = Date.now();
    const action = message.type === 'sessionAction' ? 'session.' + message.action : message.type === 'organizationAction' ? 'organization.' + message.input.action : message.type;
    const record = (status: OperationEvent['status'], error?: unknown) => this.controller.recordOperation({
      id, action, status, target, durationMs: Date.now() - started,
      ...(error === undefined ? {} : operationFailure(error))
    });
    try {
      await this.postBusy(true);
      await this.postFeedback(target, page, 'started', operationLabel(message) + '…');
      await record('started');
      await this.clients.get(page).handle(message);
      const state = await this.controller.getSidebarState();
      await this.view?.webview.postMessage({ type: 'state', state });
      const failure = diagnosticFailure(message, state);
      if (failure) throw new Error(failure);
      try { await record('succeeded'); }
      catch { await this.postFeedback(target, page, 'failed', '操作已完成，但结果日志写入失败。请检查日志目录权限或挂载。'); return; }
      await this.postFeedback(target, page, message.automatic ? 'clear' : message.type === 'officialInfo' && state.officialInfo?.unavailable.length ? 'partial' : 'succeeded', operationSuccess(message, state));
    } catch (error) {
      const raw = describeError(error), text = userFacingError(raw), cancelled = raw.startsWith('已取消') || raw.startsWith('操作失败，已恢复') && raw.includes('已取消：');
      let logFailure = '';
      try { await record(cancelled ? 'cancelled' : 'failed', error); }
      catch { logFailure = ' 操作日志也未能写入，请检查日志目录权限或挂载。'; }
      if (message.type === 'previewModels') await this.view?.webview.postMessage({ type: 'modelFetchWarning', message: '模型列表获取失败，可以手动填写 Model ID。' });
      await this.postFeedback(target, page, cancelled ? 'cancelled' : 'failed', text + logFailure + (cancelled ? '' : '（操作编号：' + id.slice(0, 8) + '）'));
      // The module itself carries Codex errors; don't duplicate them in a
      // notification or scroll the user away from the originating controls.
      if (page === 'claude' && !cancelled) void vscode.window.showErrorMessage(`AgentDeck：${text}`);
      await this.refresh().catch(() => {});
    } finally {
      this.handling = false;
      await this.postBusy(false);
    }
  }

  private async postBusy(busy: boolean): Promise<void> {
    await this.view?.webview.postMessage({ type: 'busy', busy });
  }
  private async postFeedback(target: string, page: string, status: string, message: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'operationFeedback', target, page, status, message });
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>AgentDeck</title>
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
    .organizationDisabled { opacity: 0.65; }
    .groupActions { padding: 0 8px; }
    .dragHandle { cursor: grab; }
    .providerGroup > summary { overflow-wrap: anywhere; }
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
    .modeBadge { padding: 7px 10px; border: 1px solid var(--vscode-descriptionForeground); border-radius: 5px; font-weight: 650; }
    .modeBadge.official, button.modeCurrent.official { color: var(--vscode-testing-iconPassed, #73c991); border-color: var(--vscode-testing-iconPassed, #73c991); }
    .modeBadge.api, button.modeCurrent.api { color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); }
    .modeBadge.warning { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); }
    button.modeCurrent:disabled { opacity: 1; font-weight: 650; }
    .workflowHint { padding: 6px 8px; border-left: 3px solid var(--vscode-focusBorder); color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); }

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

    .networkBody { display: contents; }
    .codexPage .module { border: 1px solid var(--vscode-widget-border, #555); border-radius: 6px; background: var(--vscode-editor-background); min-width: 0; }
    .codexPage .module > summary, .codexPage .submodule > summary { cursor: pointer; padding: 10px; line-height: 1.5; }
    .codexPage summary h2, .codexPage summary h3 { display: inline; font-weight: 650; }
    .codexPage .module > summary h2 { font-size: 14px; }
    .codexPage .submodule > summary h3 { font-size: 13px; }
    .codexPage .moduleBody { display: flex; flex-direction: column; gap: 9px; padding: 0 10px 10px; min-width: 0; }
    .codexPage .submodule { border: 1px solid var(--vscode-sideBarSectionHeader-border, #444); border-radius: 5px; min-width: 0; }
    .codexPage .proxyDetails, .codexPage .diagnosticDetails, .codexPage .proxySettings details { border: 1px solid var(--vscode-sideBarSectionHeader-border, #444); border-radius: 5px; padding: 7px; }
    .codexPage .proxyDetails summary, .codexPage .diagnosticDetails summary, .codexPage .proxySettings summary { cursor: pointer; font-size: 12px; font-weight: 650; }
    .codexPage .moduleBody > .panel, .codexPage #codexToolPanel, .codexPage #providerForm { border: 0; padding: 0; background: transparent; }
    .codexPage #codexToolPanel { padding: 0 10px 10px; }
    .codexPage #status { border: 0; background: transparent; }
    .codexPage #networkProxyPanel { display: block; padding: 0; }
    .codexPage #addProviderSection { margin-top: 8px; }
    .codexPage .providerList { gap: 9px; }
    .operationNotice { display: flex; align-items: start; gap: 7px; padding: 8px 10px; border: 1px solid var(--vscode-focusBorder, #007acc); border-radius: 5px; overflow-wrap: anywhere; }
    .operationNotice.success { border-color: var(--vscode-testing-iconPassed, #73c991); background: rgba(60, 150, 90, 0.12); }
    .operationNotice.error { border-color: var(--vscode-inputValidation-errorBorder, #f14c4c); background: var(--vscode-inputValidation-errorBackground, #492020); }
    .operationNotice.cancelled { border-color: var(--vscode-widget-border, #666); }
    .operationNotice .message { flex: 1; min-width: 0; white-space: pre-wrap; }
    .operationNotice button { flex: 0 0 auto; min-height: 20px; padding: 0 5px; }
    .feedbackWrap { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
    .moduleBody, #operationLogPath, #sessionStorage { overflow-wrap: anywhere; }
    .moduleIntro { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.55; }
    .usageNote { margin: 0; padding: 6px 8px; border-left: 2px solid var(--vscode-textLink-foreground); color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.6; }
    .environmentBadge { padding: 9px; border: 1px solid var(--vscode-focusBorder); border-radius: 5px; font-weight: 600; overflow-wrap: anywhere; }
    .codexPage #codexOverview > .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .overviewFacts { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); gap: 6px 10px; margin: 0; font-size: 12px; }
    .overviewFacts dt { color: var(--vscode-descriptionForeground); } .overviewFacts dd { margin: 0; overflow-wrap: anywhere; }
    .codexPage #codexAccountsBody > section { margin: 0; } .codexPage h4 { font-size: 12px; margin: 0; }
    .persistentError { color: var(--vscode-errorForeground, #f14c4c); } .operationRecoveryError { outline: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c); border-radius: 5px; }
    .reloadRequired { outline: 1px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 5px; }
    .reloadAdvisory { outline: 1px solid var(--vscode-focusBorder); border-radius: 5px; }
    .reloadNotice { padding: 8px; border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); display: flex; gap: 8px; align-items: center; font-size: 12px; }
    .reloadNotice span { flex: 1; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topline">
      <h1>AgentDeck</h1>
      <button id="reloadButton">刷新状态 / Reload Status</button>
    </div>
    <div class="actions toolTabs" role="tablist" aria-label="工具 / Tool">
      ${this.clients.list().map(c => `<button id="${c.id}PageTab" data-client-tab="${c.id}" type="button">${escapeHtml(c.label)}</button>`).join('')}
    </div>
    <section id="overviewSection" class="section moduleWrap"><details id="overviewDetails" class="module" data-fold="overview" open><summary id="overviewTitle"><h2>总览 / Overview</h2></summary>
    <div id="status" class="status">
      <div class="statusGrid">
        <div class="statusHead">Tool</div><div class="statusHead">Mode</div><div class="statusHead">Provider Name</div><div class="statusHead">Model ID</div><div class="statusHead">Status</div>
        <div id="statusRows" class="statusRows">Loading...</div>
      </div>
      <div id="syncStatus" class="syncStatus"></div>
      <div id="storageStatus" class="syncStatus"></div>
      <div id="codexOverview" hidden>
        <div id="codexEnvironmentStatus" class="environmentBadge"></div>
        <p class="usageNote">ⓘ 注：影响运行的设置变更前会要求确认；请先结束扩展和 CLI 中正在进行的任务。</p>
        <dl id="codexOverviewFacts" class="overviewFacts"></dl><div class="actions"><button id="viewCodexConfigButton">打开当前配置 / Open current files</button><button id="openCodexButton">打开 Codex 终端 / Open Codex terminal</button></div><details class="submodule" data-fold="management"><summary><h3>配置管理 / Configuration management</h3></summary><div class="moduleBody"><label class="toolSwitch"><input id="codexEnabled" type="checkbox" checked> 启用 Codex 配置管理 / Manage Codex configuration</label><p class="usageNote">ⓘ 注：停用后本插件不再应用 Codex 配置；不会卸载 Codex，也不会撤销已写入配置。终端按钮启动命令行客户端，不更换当前供应商。</p></div></details>
      </div>
    </div>
    </details></section>
    <div id="notice" class="notice"></div>
    ${storagePanelHtml()}
    <section id="networkSection" class="section moduleWrap"><details class="panel" id="networkProxyPanel" data-fold="network">
      <summary><h2 id="networkProxyTitle">网络设置 / Network</h2></summary>
      <div class="networkBody">
      <p class="moduleIntro">设置当前工具使用的 HTTP 代理入口。Codex 与 Claude 分别保存和应用；VPN 节点选择及浏览器路由由 VPN 或浏览器管理。</p>
      <div id="networkProxyBadge" class="networkProxyBadge" role="status" aria-live="polite">读取状态中 / Loading</div>
      <div id="networkProxyActions" class="actions three">
        <button id="testNetworkProxyButton" class="secondary" disabled>测试连接 / Test</button>
        <button id="applyNetworkProxyButton" class="primary" disabled>启用代理 / Enable</button>
        <button id="restoreNetworkProxyButton" class="secondary" disabled>已停用 / Disabled</button>
      </div>
      <div id="networkProxyStatus" class="small"></div>
      <div class="field"><label for="networkPreset">网络预设 / Network preset</label><select id="networkPreset"></select></div><div class="field"><label for="networkNote">备注 / Note</label><input id="networkNote" type="text" placeholder="例如：宿主机 VPN 入口"></div>
      <div class="field"><label for="networkProxyUrl">HTTP 代理入口 / HTTP proxy URL</label><input id="networkProxyUrl" type="text" value="http://127.0.0.1:12000" autocomplete="off"></div>
      <p class="usageNote">ⓘ 注：复制包含当前填写的代理入口、绕过列表和备注。粘贴只填入当前工具的草稿，不会立即启用，也不包含账号、API 密钥或历史记录。</p>
      <div class="actions"><button id="copyNetworkSettingsButton">复制设置 / Copy settings</button><button id="pasteNetworkSettingsButton">粘贴设置 / Paste settings</button></div><div class="actions"><button id="saveNetworkPresetButton">保存为预设 / Save preset</button><button id="deleteNetworkPresetButton" class="danger">删除预设 / Delete preset</button></div>
      <div class="field"><label for="networkProxyBypass">绕过代理的目标地址 / Bypass targets</label><input id="networkProxyBypass" type="text" value="localhost,127.0.0.1,::1" autocomplete="off"></div>
      <div id="networkProxyTest" class="small"></div>
      <details class="submodule" data-fold="network-help"><summary><h3>网络使用说明 / Network guide</h3></summary><div class="moduleBody"><p class="usageNote">ⓘ 注：代理入口是 VPN 软件提供的本地 HTTP 监听地址，不是远端 VPN 节点。示例端口仅用于填写参考，请以 VPN 软件为准。host 网络容器可使用宿主回环地址，其他容器模式通常需要宿主可达地址。</p><p class="usageNote">ⓘ 注：访问目标如 api.example.com 时，若它不在绕过列表，请求交给代理；访问 localhost、127.0.0.1 或 ::1 时绕过 HTTP 代理。绕过列表填写目标主机，不填写完整网址。保留本地例外让客户端连接本地兼容转发。</p><p class="usageNote">ⓘ 注：连接测试只检查传输，不代表账号或聊天可用。粘贴和选择预设只更改草稿，应用后才改变启动配置。插件不自动切换为直连。</p><p class="usageNote">ⓘ 注：Codex Linux 独立入口目前为实验功能；应用前会说明公共启动注册及 Windows/WSL 限制。</p></div></details>
      </div>
    </details></section>
    ${sessionPanelHtml()}
    <section id="configEditor" class="section" hidden>
      <h2 id="configEditorHeading">Provider Configuration</h2>
      <details id="codexConfigEditorDetails" class="submodule" open><summary><h3>供应商配置 / Configuration</h3></summary></details>
      <div class="panel" id="configEditorBody">
        <div id="configEditorTool" class="small"></div>
        <textarea id="configText" spellcheck="false"></textarea>
        <div class="field">
          <label for="configKey">API Key</label>
          <input id="configKey" type="password" placeholder="Leave empty to keep the stored key" autocomplete="off">
        </div>
        ${renderProxyFields('edit')}
        <details id="codexRequestDetails" class="submodule"><summary><h4>API 请求处理 / API request handling</h4></summary><div id="codexRequestBody" class="moduleBody"><p class="usageNote">ⓘ 注：选择直接调用或本地协议兼容转发，与 VPN 网络路由分别设置。</p></div></details><details id="codexUsageDetails" class="submodule"><summary><h4>额度查询 / Quota query</h4></summary><div id="codexUsageBody" class="moduleBody"><p class="usageNote">ⓘ 注：仅部分供应商支持额度查询；管理令牌可能不同于模型 API 密钥。启用后连接诊断会同时查询额度。</p></div></details><label id="usageEnabledLabel" class="check"><input id="usageEnabled" type="checkbox"> Enable Usage Query</label>
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

    ${this.clients.get('claude').browser?.markup ?? ''}

    ${this.clients.get('codex').browser?.markup ?? ''}

    <section class="section" id="addProviderSection">
      <h2 id="addProviderHeading">Add Provider</h2>
      <details id="codexAddProviderDetails" class="submodule" data-fold="add"><summary><h3>添加 API 供应商 / Add API provider</h3></summary><div id="codexAddProviderBody" class="moduleBody"></div></details>
      <form id="providerForm" class="panel">
        <div class="field">
          <label for="tool">Tool</label>
          <select id="tool">
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </div>
        <div id="codexProviderGroupField" class="field"><label for="codexProviderGroup">群组</label><select id="codexProviderGroup"></select><div class="actions"><button id="codexAddGroup" type="button">新建群组</button><button id="codexLoadGroupDefaults" type="button">载入群组模板</button></div><p class="usageNote">ⓘ 注：选择群组只决定归属；载入模板只填入草稿，保存后仍需明确应用。</p></div>
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

    ${this.clients.list().filter(c => c.browser && !c.browser.sharedFrame).map(c => `<section id="client-${c.id}" data-client-root="${c.id}" hidden>${c.browser!.markup}</section>`).join('')}
    <section class="section" id="configurationSection">
      <h2>Configuration</h2>
      <div class="actions three" id="configurationActions">
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
    ${localeScript('zh-CN')}
    const registeredClientIds = ${JSON.stringify(this.clients.list().map(c => c.id))};
    const customClientIds = ${JSON.stringify(this.clients.list().filter(c => c.browser && !c.browser.sharedFrame).map(c => c.id))};
    const savedClient = vscode.getState?.()?.activeTool;
    let activeTool = registeredClientIds.includes(savedClient) ? savedClient : 'codex';
    const networkDrafts = {};
    const providerNodes = new Map();
    let busy = false;
    const feedback = new Map();
    const feedbackTimers = new Map();
    const dismissedReload = new Set(vscode.getState()?.dismissedReload || []);
    const reloadTimers = new Map();
    const foldsByEnvironment = vscode.getState?.()?.foldsByEnvironment || {};
    let foldEnvironment = '';
    let restoringFolds = false;
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
      codexPageTab: document.getElementById('codexPageTab'),
      claudePageTab: document.getElementById('claudePageTab'),
      copyNetworkSettingsButton: document.getElementById('copyNetworkSettingsButton'),
      networkProxyTitle: document.getElementById('networkProxyTitle'),
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

    };

    el.tool.value = activeTool;
    ${sessionPanelScript()}
    ${this.clients.list().map(c => c.browser?.script ?? '').join('\n')}
    const clientPages = { ${this.clients.list().filter(c => c.browser).map(c => JSON.stringify(c.id) + ': new ' + c.browser!.controller + '()').join(', ')} };

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (customClientIds.includes(activeTool) && !['state', 'busy'].includes(message.type)) { clientPages[activeTool]?.receive?.(message); return; }
      if (message.type === 'organizationResult') { clientPages.codex.receive(message); return; }
      if (message.type === 'state') {
        state = message.state;
        networkProxyLoaded = true;
        // Only confirmed results replace a draft; failed Apply keeps it for retry.
        if (networkProxyPending === 'apply' && sameNetworkProxy(currentNetwork().config, networkProxyInput()) ||
            networkProxyPending === 'restore' && !currentNetwork().config) { networkProxyDirty = false; delete networkDrafts[activeTool]; }
        render();
        return;
      }
      if (message.type === 'networkDraft') { if (message.tool === activeTool) fillNetworkDraft(message.config); return; }
      if (message.type === 'models') {
        fetchedModels = message.models || [];
        renderModelOptions();
        el.addNotice.classList.remove('visible', 'warning', 'error');
        return;
      }
      if (message.type === 'configEditor') {
        configEditorProviderId = message.providerId;
        configEditorTool = message.tool;
        el.configEditorTool.textContent = labelTool(message.tool) + (message.hasKey ? ' — 已保存 API 密钥' : ' — 尚未保存 API 密钥');
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
        document.getElementById('codexConfigEditorDetails').open = true;
        if (message.tool === 'codex') { const item = Array.from(el.codexProviders.querySelectorAll('[data-provider-id]')).find(node => node.dataset.providerId === message.providerId); if (item) item.after(el.configEditor); }
        else document.getElementById('sessionPanel').after(el.configEditor);
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
      if (message.type === 'operationFeedback') {
        const key = message.target;
        setFeedback(key, message.status === 'clear' ? undefined : { ...message });
        renderFeedback(); return;
      }
      if (message.type === 'notice') {
        showNotice(message.message, false);
        return;
      }
      if (message.type === 'providerCreated') {
        el.applyNow.checked = false;

        return;
      }
      if (message.type === 'modelFetchWarning') {
        fetchedModels = [];
        renderModelOptions();

        return;
      }
      if (message.type === 'error') {
        if (message.action === 'createProvider') showAddNotice(message.message, true);
        showNotice(message.message, true);
      }
    });

    el.reloadButton.addEventListener('click', () => post({ type: 'ready' }));
    function currentNetwork() { return state.networkProxy?.tools?.[activeTool] || {}; }
    function selectToolPage(tool) {
      if (busy) return;
      if (configEditorProviderId && !el.configEditor.hidden) { showNotice('Close the configuration editor before changing tool pages.', true); return; }
      clientPages[activeTool]?.leave?.();
      if (networkProxyDirty) networkDrafts[activeTool] = networkProxyInput();
      activeTool = tool; networkProxyDirty = Boolean(networkDrafts[tool]);
      if (networkProxyDirty) { el.networkProxyUrl.value = networkDrafts[tool].url; el.networkProxyBypass.value = networkDrafts[tool].noProxy; networkNote.value = networkDrafts[tool].note || ''; }
      foldEnvironment = ''; render(); if (!customClientIds.includes(activeTool)) { resetModels(); setProxyConfig('add'); } clientPages[activeTool]?.enter?.();
      vscode.setState?.({ ...(vscode.getState?.() || {}), activeTool }); render();
    }
    for (const id of registeredClientIds) document.getElementById(id + 'PageTab').addEventListener('click', () => selectToolPage(id));
    const networkNote = document.getElementById('networkNote'), presetSelect = document.getElementById('networkPreset');
    const builtInNetworkPresets = [{ name: '本机 HTTP 入口（示例 12000）', url: 'http://127.0.0.1:12000' }, { name: '本机 HTTP 入口（示例 7890）', url: 'http://127.0.0.1:7890' }, { name: '宿主机地址（需环境支持）', url: 'http://host.docker.internal:7890' }];
    function renderNetworkPresets() {
      const old = presetSelect.value; presetSelect.textContent = '';
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '选择预设（只填入草稿）'; presetSelect.appendChild(empty);
      for (const [i, preset] of [...builtInNetworkPresets, ...(state.networkPresets?.[activeTool] || [])].entries()) { const option = document.createElement('option'); option.value = String(i); option.textContent = preset.name; presetSelect.appendChild(option); }
      presetSelect.value = old;
    }
    function fillNetworkDraft(config) { el.networkProxyUrl.value = config.url; el.networkProxyBypass.value = config.noProxy || 'localhost,127.0.0.1,::1'; networkNote.value = config.note || ''; networkProxyDirty = true; networkDrafts[activeTool] = networkProxyInput(); renderNetworkProxyActions(); }
    presetSelect.addEventListener('change', () => { const preset = [...builtInNetworkPresets, ...(state.networkPresets?.[activeTool] || [])][Number(presetSelect.value)]; if (preset && presetSelect.value !== '') fillNetworkDraft({ ...preset, note: preset.note || preset.name }); });
    el.copyNetworkSettingsButton.addEventListener('click', () => post({ type: 'networkClipboard', tool: activeTool, action: 'copy', config: networkProxyInput() }));
    document.getElementById('pasteNetworkSettingsButton').addEventListener('click', () => post({ type: 'networkClipboard', tool: activeTool, action: 'paste' }));
    document.getElementById('saveNetworkPresetButton').addEventListener('click', () => post({ type: 'networkPreset', tool: activeTool, action: 'save', name: networkNote.value.trim(), config: networkProxyInput() }));
    document.getElementById('deleteNetworkPresetButton').addEventListener('click', () => { const preset = (state.networkPresets?.[activeTool] || [])[Number(presetSelect.value) - builtInNetworkPresets.length]; if (preset) post({ type: 'networkPreset', tool: activeTool, action: 'delete', name: preset.name }); else showLocalFeedback('network', '请先选择一个自定义预设。', true); });
    networkNote.addEventListener('input', () => { networkProxyDirty = true; renderNetworkProxyActions(); });
    function networkProxyInput() {
      return { note: networkNote.value, url: el.networkProxyUrl.value.trim(), noProxy: el.networkProxyBypass.value,
        claude: activeTool === 'claude', codex: activeTool === 'codex' };
    }
    function sameNetworkProxy(a, b) {
      if (!a || !b) return false;
      const signature = config => JSON.stringify([
        config.url.trim().replace(/[/]$/, ''),
        [...new Set(('localhost,127.0.0.1,::1,' + config.noProxy).split(',').map(host => host.trim()).filter(Boolean))].sort(),
        config.claude, config.codex, config.note || ''
      ]);
      return signature(a) === signature(b);
    }
    function renderNetworkProxyActions() {
      const network = currentNetwork();
      const enabled = Boolean(network.config);
      const changed = enabled && (!network.managed || !sameNetworkProxy(network.config, networkProxyInput()));
      const locked = busy || !networkProxyLoaded;
      el.networkProxyBadge.textContent = !networkProxyLoaded ? '读取状态中 / Loading' : enabled ? '● 已配置代理 / Proxy configured' : '○ 未管理代理 / Unmanaged';
      el.networkProxyBadge.className = 'networkProxyBadge' + (enabled ? ' enabled' : '');
      el.networkProxyStatus.className = network.error ? 'small persistentError' : 'small';
      document.getElementById('networkSection').classList.toggle('operationRecoveryError', Boolean(network.error));
      el.networkProxyStatus.textContent = (enabled
        ? uiText(changed ? '当前代理仍已启用；有更改待应用。 / Enabled — changes not applied. ' : '代理配置未变化。 / Proxy configuration unchanged. ')
        : uiText('未接管客户端代理；原有环境或 VPN 仍可能提供路由。 / Client proxy is unmanaged; existing environment or VPN routes may still apply. ')) + ' ' + uiText(network.message || '');
      el.applyNetworkProxyButton.textContent = networkProxyPending === 'apply' ? '应用中… / Applying…'
        : !enabled ? '启用代理 / Enable' : changed ? '应用更改 / Apply changes' : '✓ 已启用 / Enabled';
      el.applyNetworkProxyButton.className = enabled && !changed ? 'networkProxyCurrent' : 'primary';
      el.applyNetworkProxyButton.disabled = locked || enabled && !changed;
      el.restoreNetworkProxyButton.textContent = networkProxyPending === 'restore' ? '停用中… / Disabling…'
        : enabled ? '停用并恢复 / Disable' : '已停用 / Disabled';
      el.restoreNetworkProxyButton.disabled = locked || !enabled;
      el.testNetworkProxyButton.textContent = networkProxyPending === 'test' ? '测试中… / Testing…' : '测试连接 / Test';
      el.testNetworkProxyButton.disabled = locked;
      for (const input of [el.networkProxyUrl, el.networkProxyBypass]) input.disabled = locked;
      localizeUi(document.querySelector('.networkBody'));
    }
    function submitNetworkProxy(action) {
      networkProxyPending = action;
      post(action === 'restore' ? { type: 'restoreNetworkProxy', tool: activeTool }
        : { type: action === 'apply' ? 'applyNetworkProxy' : 'testNetworkProxy', config: networkProxyInput(), tool: activeTool });
    }
    for (const input of [el.networkProxyUrl, el.networkProxyBypass]) {
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
    document.getElementById('officialInfoButton').addEventListener('click', () => post({ type: 'officialInfo' }));
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
    el.exportButton.addEventListener('click', () => post({ type: 'exportPublicConfig', tool: activeTool }));
    el.importButton.addEventListener('click', () => post({ type: 'importPublicConfig', tool: activeTool }));
    el.clearLogButton.addEventListener('click', () => post({ type: 'clearLog' }));
    for (const [id, action] of [['viewOperationLogButton', 'view'], ['openOperationLogButton', 'folder'], ['exportOperationLogButton', 'export']]) document.getElementById(id).addEventListener('click', () => post({ type: 'logAction', action }));
    el.deleteClaudeBackupsButton.addEventListener('click', () => post({ type: 'deleteBackups', tool: 'claude' }));
    el.codexOfficialMode.addEventListener('click', () => submitCodexMode('official'));
    el.codexApiMode.addEventListener('click', () => submitCodexMode('api'));
    function submitCodexMode(mode) {
      if ((mode === 'official' ? el.codexOfficialMode : el.codexApiMode).disabled) return;
      post({ type: 'applyCodexMode', mode });
    }
    el.addMode.addEventListener('change', updateAddMode);
    el.tool.addEventListener('change', () => { resetModels(); setProxyConfig('add'); updateAddMode(); });
    el.addConfigText.addEventListener('input', updateSaveState);
    el.saveConfigButton.addEventListener('click', () => {
      try { post({ type: 'saveProviderConfig', providerId: configEditorProviderId, text: el.configText.value, key: el.configKey.value, usageQuery: getUsageQuery(), usageAccessToken: el.usageAccessToken.value, proxy: getProxyConfig('edit') }); }
      catch (error) { showLocalFeedback('editor', error.message, true); }
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

    function setToolChoices(choices) {
      if (el.tool.options.length !== choices.length) {
        el.tool.textContent = ''; for (const [value, label] of choices) { const option = document.createElement('option'); option.value = value; option.textContent = label; el.tool.appendChild(option); }
      }
    }
    function render() {
      for (const id of registeredClientIds) { const tab = document.getElementById(id + 'PageTab'); tab.disabled = busy; tab.className = activeTool === id ? 'primary' : ''; tab.setAttribute('aria-selected', String(activeTool === id)); }
      for (const id of customClientIds) document.getElementById('client-' + id).hidden = activeTool !== id;
      const custom = customClientIds.includes(activeTool);
      for (const id of ['overviewSection', 'networkSection', 'codexAccountsSection', 'codexDataSection', 'claudeSection', 'codexSection', 'addProviderSection', 'configurationSection']) document.getElementById(id).hidden = custom;
      if (custom) { el.configEditor.hidden = true; clientPages[activeTool]?.render(state, busy); return; }
      clientPages[activeTool]?.layout?.();
      renderSessions();
      const network = currentNetwork();
      if (!networkProxyDirty) {
        const config = network.config || { url: 'http://127.0.0.1:12000', noProxy: 'localhost,127.0.0.1,::1' };
        el.networkProxyUrl.value = config.url; el.networkProxyBypass.value = config.noProxy; networkNote.value = config.note || '';

      }
      renderNetworkPresets();
      renderNetworkProxyActions();
      el.networkProxyTest.textContent = network.test ? '代理连接测试：' + network.test.proxyUrl + '；检查时间：' + network.test.checkedAt + '；' + network.test.results.map(item => item.target + ' — ' + (item.reachable ? '可达（HTTP ' + item.status + '）' : item.error)).join('；') + '。仅检查连接，未验证登录或聊天。' : '连接测试：本次启动尚未测试。启动时只核查本地配置；点击“测试连接”检查代理入口。';
      renderStatus();
      clientPages[activeTool]?.render();
      el.claudePath.textContent = '配置位置：' + state.configPaths.claude;
      el.claudeEnabled.checked = state.toolEnabled.claude;
      el.codexEnabled.checked = state.toolEnabled.codex;
      document.getElementById('officialInfoButton').disabled = busy || state.codexMode !== 'official' || !codexIdentityReady('official');
      const info = state.officialInfo; document.getElementById('officialInfoResult').dataset.rawValue = 'true'; document.getElementById('officialInfoResult').textContent = info ? ui('可用模型：', 'Available models: ') + (info.models.join(', ') || ui('未返回', 'None returned')) + '\\n' + ui('额度窗口：', 'Quota windows: ') + info.windows.map(w => ui('已用 ', 'Used ') + w.usedPercent + '%' + (w.minutes ? ' / ' + w.minutes + ui(' 分钟', ' minutes') : '')).join('; ') + '\\n' + info.unavailable.map(uiText).join('; ') : '';
      el.officialSpeedResult.hidden = state.codexMode !== 'official' || !codexIdentityReady('official');
      if (!el.officialSpeedResult.hidden) renderDiagnostics(el.officialSpeedResult, undefined, undefined, false, state.officialSpeedResult);
      el.claudeSection.classList.toggle('toolDisabled', !state.toolEnabled.claude);
      el.codexSection.classList.toggle('toolDisabled', !state.toolEnabled.codex || !codexApiEditable());
      document.getElementById('codexApiReadOnly').textContent = codexApiEditable() ? '选择供应商并应用；配置只应用到当前环境。' : '当前为官方模式或等待重载，本区域只读。通过上方模式按钮切换到 API。';
      applyCollapseState();
      updateActionState();
      updateSaveState();
      updateAddMode();
      if (activeTool === 'codex' && !el.configEditor.hidden) { const provider = state.providers.find(p => p.id === configEditorProviderId); if (provider?.disabled || provider?.groupDisabled) for (const field of el.configEditor.querySelectorAll('input, select, textarea, button')) field.disabled = field.id !== 'closeConfigButton'; }
      restoreFoldState();
      renderFeedback();
      renderOverviewFacts();
      renderReloadState();
      localizeUi(document.querySelector('.shell'));
    }

    function renderOverviewFacts() {
      const node = document.getElementById('codexOverviewFacts'); node.textContent = '';
      const row = state.apiStatuses.find(r => r.tool === 'codex') || {};
      const p = state.providers.find(p => p.id === state.currentProviderIds.codex);
      const network = state.networkProxy?.tools?.codex;
      const facts = [['配置写入', state.globalCliSync ? state.configTarget === 'real' ? '当前环境的 Codex 配置文件' : '隔离测试目录' : '已关闭'], ['登录方式', labelMode(state.codexMode)], ['当前账号或供应商', state.codexMode === 'official' ? activeCodexIdentity()?.name || ui('未管理的官方账号', 'Unmanaged official account') : row.providerName || p?.name || ui('尚未应用', 'Not applied')], ['认证或连接配置', labelStatus(row.status)], ['聊天网络路由', network?.config ? network.config.url + (network.error ? '（配置核查异常，请查看网络设置）' : network.managed ? '（独立路由配置）' : '（旧网络配置，待重新应用）') : '未由本插件管理'], ['API 请求处理', state.codexMode !== 'api' ? '不适用' : p?.proxy?.mode === 'proxy' ? '本地协议兼容转发' : '直接调用 API'], ['默认模型', row.model || ui('由 Codex 客户端选择', 'Selected in Codex')], ['历史绑定', state.sessions?.root ? (state.sessions.attached ? activeCodexIdentity()?.name || '已连接' : '绑定异常') : '当前环境原目录'], ['配置位置', state.configPaths.codex || '读取中']];
      for (const [key, value] of facts) { const k = document.createElement('dt'), v = document.createElement('dd'); k.textContent = key; v.textContent = value; if (key === '当前账号或供应商' || key === '默认模型') v.dataset.rawValue = 'true'; node.append(k, v); }
    }

    function renderStatus() {
      el.statusRows.textContent = '';
      for (const row of state.apiStatuses.filter(row => row.tool === activeTool)) {
        const tool = document.createElement('div'); tool.textContent = labelTool(row.tool);
        const mode = document.createElement('div'); mode.textContent = labelMode(row.mode);
        const provider = document.createElement('div'); provider.textContent = row.providerName || (row.mode === 'official' ? 'Official account' : 'Not configured');
        const model = document.createElement('div'); model.textContent = row.model || (row.mode === 'official' || row.mode === 'api' ? 'Client default' : '—');
        const status = document.createElement('div'); status.textContent = labelStatus(row.status);
        if (row.tool === 'codex') {
          const active = activeCodexIdentity();
          if (state.sessions?.restartRequired) {
            mode.textContent = '待重载 / Pending'; provider.textContent = active?.name || 'Identity changed';
            model.textContent = '—'; status.textContent = 'Reload required';
          } else if (active?.kind === 'api' && row.mode !== 'api') {
            mode.textContent = 'API · 待配置'; provider.textContent = 'Not configured';
            model.textContent = '—'; status.textContent = 'Apply API Provider';
          } else if (active?.kind === 'official' && row.mode === 'official') provider.textContent = active.name;
        }
        el.statusRows.append(tool, mode, provider, model, status);
      }
      el.syncStatus.hidden = activeTool === 'codex';
      document.querySelector('.statusGrid').hidden = activeTool === 'codex';
      el.storageStatus.hidden = activeTool === 'codex';
      el.syncStatus.textContent = activeTool === 'codex' ? (state.globalCliSync ? state.configTarget === 'real' ? '配置写入：当前环境实际 CLI 文件' : '配置写入：隔离测试目录' : '配置写入：关闭，仅影响新终端环境') : state.globalCliSync ? 'Config sync: ' + state.configTarget : 'Config sync: Off';
      document.getElementById('codexOverview').hidden = activeTool !== 'codex';
      document.getElementById('codexEnvironmentStatus').textContent = '运行环境：' + (state.sessions?.environment || '读取中');

      const sizes = state.storageSizes || { logBytes: 0, backupBytes: 0, claudeBackupBytes: 0, codexBackupBytes: 0 };
      el.storageStatus.textContent = activeTool === 'codex' ? '插件日志：' + formatBytes(sizes.logBytes) + '；账号数据位置见“数据与存储”。' : 'Storage: Log folder ' + formatBytes(sizes.logBytes) +
        ' | Backup folders ' + formatBytes(sizes.backupBytes) +
        ' (Claude ' + formatBytes(sizes.claudeBackupBytes) + ', Codex ' + formatBytes(sizes.codexBackupBytes) + ')';
    }

    function toggleCollapse(tool) {
      collapsed[tool] = !collapsed[tool];
      vscode.setState({ ...(vscode.getState() || {}), claudeCollapsed: collapsed.claude });
      applyCollapseState();
    }

    function applyCollapseState() {
      el.claudeToolPanel.hidden = collapsed.claude;
      el.collapseClaudeButton.textContent = collapsed.claude ? '▸' : '▾';
      el.collapseClaudeButton.title = collapsed.claude ? 'Expand Claude tool' : 'Collapse Claude tool';
    }

    function renderProviderList(tool, container, enabled) {
      const editorHere = el.configEditor.parentElement === container;
      const locked = false;
      const providers = state.providers.filter((provider) => provider.tool === tool && (tool !== 'codex' || provider.codexMode !== 'official'));
      if (tool === 'codex') enabled = enabled && codexApiEditable();
      for (const node of [...container.querySelectorAll('[data-provider-id]')]) if (node.dataset.providerId && !providers.some(p => p.id === node.dataset.providerId)) { providerNodes.delete(tool + ':' + node.dataset.providerId); node.remove(); }
      if (!providers.length && tool !== 'codex') {
        container.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No ' + labelTool(tool) + ' providers yet.';
        container.appendChild(empty);
        return;
      }

      for (const empty of container.querySelectorAll('.empty')) empty.remove();
      for (const provider of providers) {
        const providerEnabled = enabled && !provider.disabled && !provider.groupDisabled;
        const key = tool + ':' + provider.id;
        const signature = JSON.stringify([provider, enabled, state.currentProviderIds[tool], state.codexMode, state.sessions?.environmentId, state.sessions?.activeId, state.sessions?.restartRequired, state.sessions?.attached]);
        const cached = providerNodes.get(key);
        if (cached?.signature === signature) continue;
        const active = enabled && state.currentProviderIds[tool] === provider.id;
        const item = document.createElement('div');
        item.dataset.providerId = provider.id;
        item.className = 'provider' + (active ? ' active' : '') + (provider.disabled || provider.groupDisabled ? ' organizationDisabled' : '');
        item.draggable = tool === 'claude' && enabled;
        if (tool === 'claude') item.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', provider.id));
        item.addEventListener('dragover', (event) => event.preventDefault());
        item.addEventListener('drop', (event) => {
          event.preventDefault();
          const providerId = event.dataTransfer.getData('application/agentdeck-provider') || event.dataTransfer.getData('text/plain');
          if (!providerId) return; // A group drag bubbles to the owning group's drop target.
          event.stopPropagation?.();
          if (enabled && !busy && providerId && providerId !== provider.id) { if (tool === 'codex') clientPages.codex.send({ action: 'moveProvider', providerId, beforeProviderId: provider.id, groupId: provider.groupId || 'independent' }); else post({ type: 'moveProvider', providerId, beforeProviderId: provider.id }); }
        });

        const meta = document.createElement('div');
        meta.className = 'providerMeta';
        const name = document.createElement('div');
        name.className = 'providerName';
        name.textContent = provider.name;
        const model = document.createElement('div');
        model.className = 'providerModel'; model.dataset.rawValue = 'true';
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
          ? '请求处理：Codex 官方账号'
          : provider.proxy && provider.proxy.mode === 'proxy'
          ? (tool === 'codex' ? '请求处理：本地兼容转发 · ' : '请求处理：本地兼容转发 · ') + (provider.proxy.apiFormat === 'responses' ? 'Responses · ' : '') + provider.proxy.preset + (Object.keys(provider.proxy.overrides || {}).length ? ' · 自定义参数' : '')
          : tool === 'codex' ? '请求处理：直接调用 API' : '请求处理：直接调用 API';
        meta.appendChild(connection);
        if (provider.needsApply) {
          const pending = document.createElement('div'); pending.className = 'providerWarning';
          pending.textContent = 'Configuration changed · Pending Apply'; meta.appendChild(pending);
        }
        if (provider.proxy && provider.proxy.mode === 'proxy' || provider.needsApply && provider.proxyRuntime && provider.proxyRuntime.localUrl) {
          const runtime = provider.proxyRuntime || { state: 'stopped', requests: 0, succeeded: 0, failed: 0, retries: 0, trimmedMessages: 0 };
          const local = document.createElement('div'); local.className = 'providerModel';
          local.textContent = '兼容转发：' + (runtime.state === 'running' ? '运行中' : '已停止'); meta.appendChild(local);
          const upstream = document.createElement('div'); upstream.className = runtime.lastRequest && !runtime.lastRequest.ok ? 'providerWarning' : 'providerModel';
          upstream.textContent = runtime.lastRequest ? '上次模型请求：' + (runtime.lastRequest.ok ? '通过' : '失败 · HTTP ' + runtime.lastRequest.status + ' · ' + runtime.lastRequest.error) : '模型可用性：尚未验证';
          meta.appendChild(upstream);
          const details = document.createElement('details'); details.className = 'proxyDetails';
          const summary = document.createElement('summary'); summary.textContent = 'Proxy Details'; details.appendChild(summary);
          const info = document.createElement('div');
          info.textContent = (runtime.localUrl || 'Apply to start a local endpoint') + ' | 请求 ' + runtime.requests + '，成功 ' + runtime.succeeded + '，失败 ' + runtime.failed + '，重试 ' + runtime.retries + '，省略历史消息 ' + runtime.trimmedMessages;
          details.appendChild(info);
          const controls = document.createElement('div'); controls.className = 'actions three';
          for (const action of [runtime.state === 'running' ? 'stop' : 'start', 'restart', 'log']) {
            const button = document.createElement('button'); button.textContent = action[0].toUpperCase() + action.slice(1);
            button.disabled = locked || !providerEnabled || (action !== 'log' && !active && !runtime.localUrl);
            button.title = action === 'start' || action === 'restart' ? 'Resume the last applied configuration; use Apply for saved changes.' : '';
            button.addEventListener('click', () => post({ type: 'controlProxy', providerId: provider.id, action })); controls.appendChild(button);
          }
          details.appendChild(controls); meta.appendChild(details);
        }
        if (provider.compatibility) {
          const compatibility = document.createElement('div');
          compatibility.className = provider.compatibility.ok ? 'providerModel' : 'providerWarning';
          compatibility.textContent = provider.compatibility.ok
            ? '模型验证：通过 | ' + provider.compatibility.latencyMs + ' ms'
            : '模型验证：' + uiText(compatibilityFailureLabel(provider.compatibility.failureKind)) + ' | ' + (provider.compatibility.error || 'Failed');
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
        applyButton.disabled = locked || !providerEnabled || !provider.hasKey || tool === 'codex' && (!codexIdentityReady(provider.codexMode === 'official' ? 'official' : 'api') || !state.sessions?.root && state.codexMode === 'official' && provider.codexMode !== 'official');
        if (tool === 'codex' && applyButton.disabled && !locked && enabled && provider.hasKey) applyButton.title = '请先在上方设置、启用匹配的身份并重载，再 Apply。';
        applyButton.addEventListener('click', () => post({ type: 'applyProvider', providerId: provider.id }));
        actions.appendChild(applyButton);
        if (tool === 'codex') {
        const drag = document.createElement('button'); drag.type = 'button'; drag.textContent = '↕ 排序'; drag.className = 'dragHandle'; drag.draggable = enabled; drag.disabled = !enabled;
        drag.addEventListener('dragstart', event => { event.stopPropagation?.(); event.dataTransfer.setData(tool === 'codex' ? 'application/agentdeck-provider' : 'text/plain', provider.id); }); actions.appendChild(drag);

          const move = document.createElement('button'); move.textContent = '移动到群组'; move.disabled = !providerEnabled; move.addEventListener('click', () => clientPages.codex.send({ action: 'moveProvider', providerId: provider.id })); actions.appendChild(move);
          const toggle = document.createElement('button'); toggle.textContent = provider.disabled ? '恢复供应商' : '禁用供应商'; toggle.disabled = !enabled || provider.groupDisabled; toggle.addEventListener('click', () => clientPages.codex.send({ action: 'toggleProvider', providerId: provider.id, enabled: Boolean(provider.disabled) })); actions.appendChild(toggle);
          const template = document.createElement('button'); template.textContent = '载入群组模板'; template.disabled = !providerEnabled; template.addEventListener('click', () => clientPages.codex.send({ action: 'providerTemplate', providerId: provider.id })); actions.appendChild(template);
        }
        const configButton = document.createElement('button');
        configButton.textContent = 'Config';
        configButton.disabled = locked || !providerEnabled;
        configButton.addEventListener('click', () => post({ type: 'openProviderConfig', providerId: provider.id }));
        actions.appendChild(configButton);
        const deleteButton = document.createElement('button');
        deleteButton.className = 'danger';
        deleteButton.textContent = 'Delete';
        deleteButton.disabled = locked || !providerEnabled;
        deleteButton.addEventListener('click', () => post({ type: 'deleteProvider', providerId: provider.id }));
        const networkButton = document.createElement('button');
        networkButton.textContent = tool === 'codex' ? '检查连接与额度' : 'Network & Usage';
        networkButton.disabled = locked || !providerEnabled || !provider.hasKey || (provider.tool === 'codex' && provider.codexMode === 'official');
        networkButton.addEventListener('click', () => post({ type: 'testProviderNetwork', providerId: provider.id }));
        actions.appendChild(networkButton);
        const modelButton = document.createElement('button');
        modelButton.textContent = tool === 'codex' ? '选择模型' : 'Model';
        modelButton.disabled = locked || !providerEnabled || !provider.hasKey || (provider.tool === 'codex' && provider.codexMode === 'official');
        modelButton.addEventListener('click', () => post({ type: 'updateProviderModel', providerId: provider.id }));
        actions.appendChild(modelButton);
        const verifyButton = document.createElement('button');
        verifyButton.textContent = tool === 'codex' ? '验证所选模型' : 'Verify Model';
        verifyButton.disabled = locked || !providerEnabled || !provider.hasKey || (provider.tool === 'codex' && provider.codexMode === 'official') || !hasConfiguredModel(provider.modelPolicy);
        verifyButton.addEventListener('click', () => post({ type: 'verifyProviderModel', providerId: provider.id }));
        actions.appendChild(verifyButton);
        for (const runs of tool === 'codex' ? [3] : [1, 3]) {
          const speedButton = document.createElement('button');
          speedButton.textContent = tool === 'codex' ? '测试生成与速度' : runs === 1 ? 'Quick Speed Test' : 'Standard Speed Test';
          speedButton.title = runs + ' real short request(s); uses saved connection settings and model quota; does not Apply';
          const official = provider.codexMode === 'official';
          speedButton.disabled = locked || !providerEnabled || (official ? state.codexMode !== 'official' : !provider.hasKey || !hasConfiguredModel(provider.modelPolicy));
          speedButton.addEventListener('click', () => post({ type: 'speedTest', providerId: provider.id, runs }));
          actions.appendChild(speedButton);
        }
        actions.appendChild(deleteButton);
        if (tool === 'codex') {
          const modelPanel = document.createElement('details'); modelPanel.className = 'submodule'; modelPanel.dataset.fold = 'model:' + provider.id; modelPanel.open = Boolean(foldsByEnvironment[state.sessions?.environmentId]?.[modelPanel.dataset.fold]); const modelTitle = document.createElement('summary'); modelTitle.textContent = '模型'; modelPanel.appendChild(modelTitle);
          const modelBody = document.createElement('div'); modelBody.className = 'moduleBody'; const modelNote = document.createElement('p'); modelNote.className = 'usageNote'; modelNote.textContent = 'ⓘ 注：刷新列表只更新目录；选择模型会保存默认模型；验证发送一次真实短请求。';
          const refresh = document.createElement('button'); refresh.textContent = '刷新模型列表'; refresh.disabled = locked || !providerEnabled || !provider.hasKey; refresh.addEventListener('click', () => post({ type: 'refreshProviderModels', providerId: provider.id }));
          modelBody.append(modelNote, refresh, modelButton, verifyButton); modelPanel.appendChild(modelBody); item.appendChild(modelPanel);
          const diagnosis = document.createElement('details'); diagnosis.className = 'submodule'; diagnosis.dataset.fold = 'diagnostics:' + provider.id; diagnosis.open = Boolean(foldsByEnvironment[state.sessions?.environmentId]?.[diagnosis.dataset.fold]); const title = document.createElement('summary'); title.textContent = '供应商诊断'; diagnosis.appendChild(title);
          const body = document.createElement('div'); body.className = 'moduleBody'; const note = document.createElement('p'); note.className = 'usageNote'; note.textContent = 'ⓘ 注：连接检查读取模型目录和已启用的额度接口；生成测速执行三次短请求，不会应用此供应商。'; body.append(note, networkButton);
          for (const button of [...actions.children]) if (button.textContent === '测试生成与速度') body.appendChild(button);
          const result = meta.querySelector('.diagnosticResults'); if (result) body.appendChild(result); diagnosis.appendChild(body); item.appendChild(diagnosis);
        }
        item.appendChild(actions);
        for (const button of item.querySelectorAll('button')) button.dataset.disabledIdle = String(button.disabled);
        if (cached?.node.parentElement) { cached.node.before(item); cached.node.remove(); } else container.appendChild(item);
        providerNodes.set(key, { signature, node: item });
        if (!el.configEditor.hidden && configEditorProviderId === provider.id && tool === 'codex') container.appendChild(el.configEditor);
      }
      if (tool !== 'codex') for (let i = 0; i < providers.length; i++) { const node = providerNodes.get(tool + ':' + providers[i].id)?.node; if (node && [...container.children].filter(n => n.dataset.providerId)[i] !== node) container.appendChild(node); }
      for (const node of container.querySelectorAll('[data-provider-id]')) { node.draggable = tool === 'claude' && enabled && !busy; for (const button of node.querySelectorAll('button')) button.disabled = busy || button.dataset.disabledIdle === 'true'; }
      if (!el.configEditor.hidden && tool === 'codex') { const card = providerNodes.get(tool + ':' + configEditorProviderId)?.node; if (card) card.after(el.configEditor); }
    }

    function fetchModels() {
      const tool = el.tool.value;
      const baseUrl = el.baseUrl.value.trim();
      const key = el.apiKey.value;
      if (!baseUrl || !key) {
        showAddNotice('URL and key are required before fetching models.', true);
        return;
      }
      try { post({ type: 'previewModels', tool, baseUrl, key, proxy: getProxyConfig('add') }); }
      catch (error) { showAddNotice(error.message, true); }
    }

    function updateAddMode() {
      const formReadOnly = busy || activeTool === 'codex' && (!codexApiEditable() || !state.toolEnabled.codex);
      for (const control of el.form.querySelectorAll('input, select, textarea, button')) control.disabled = formReadOnly;
      el.tool.disabled = formReadOnly || activeTool === 'claude';
      updateProxyVisibility('add', el.tool.value);
      const disabledGroup = activeTool === 'codex' && (state.codexOrganization?.disabledGroups || []).includes(document.getElementById('codexProviderGroup').value);
      document.getElementById('codexLoadGroupDefaults').disabled = formReadOnly || disabledGroup;
      el.applyNow.disabled = formReadOnly || disabledGroup; if (disabledGroup) el.applyNow.checked = false;
      for (const option of el.tool.options) option.disabled = !state.toolEnabled[option.value];
      el.tool.value = activeTool;
      const textMode = el.addMode.value === 'text';
      el.configTextField.hidden = !textMode;
      el.baseUrlField.hidden = textMode;
      el.apiKeyField.hidden = textMode;
      el.modelField.hidden = textMode;
      el.fetchModelsButton.hidden = textMode;
      if (formReadOnly) for (const control of el.form.querySelectorAll('input, select, textarea, button')) control.disabled = true;
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
          showAddNotice('Name and complete configuration are required.', true);
          return;
        }
        showAddNotice('Saving provider...', false);
        post({ type: 'createProvider', payload: { groupId: activeTool === 'codex' ? document.getElementById('codexProviderGroup').value : undefined, tool: el.tool.value, name: el.providerName.value.trim(), key: '', baseUrl: '', model: '', applyNow: el.applyNow.checked, configMode: 'custom', configText: el.addConfigText.value, proxy: getProxyConfig('add') } });
        return;
      }
      const payload = {
        groupId: activeTool === 'codex' ? document.getElementById('codexProviderGroup').value : undefined,
        tool: el.tool.value,
        name: el.providerName.value.trim(),
        baseUrl: el.baseUrl.value.trim(),
        key: el.apiKey.value,
        model: el.modelSelect.value,
        applyNow: el.applyNow.checked,
        proxy: getProxyConfig('add')
      };
      if (!payload.name || !payload.baseUrl || !payload.key) {
        showAddNotice('Name, URL, and key are required.', true);
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
      el.refreshCodexModelsButton.disabled = busy || !state.toolEnabled.codex || !codexApiEditable();
      el.testClaudeNetworkButton.disabled = busy || !state.toolEnabled.claude;
      el.testCodexNetworkButton.disabled = busy || !state.toolEnabled.codex || !codexApiEditable();
      el.deleteClaudeBackupsButton.disabled = busy || !state.toolEnabled.claude;
      el.quickOfficialSpeedButton.disabled = !codexIdentityReady('official') || busy || !state.toolEnabled.codex || state.codexMode !== 'official';
      el.standardOfficialSpeedButton.disabled = el.quickOfficialSpeedButton.disabled;
    }

    function updateSaveState() {
      el.saveButton.disabled = busy || el.tool.value === 'codex' && !codexApiEditable() || !state.toolEnabled[el.tool.value] || (el.addMode.value === 'text' && !el.addConfigText.value.trim());
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
      if (!policy || policy.type === 'toolDefault') return '未指定模型';
      if (policy.type === 'providerAuto') return policy.preferred ? '自动选择：' + policy.preferred : '未指定模型';
      return policy.model || '未指定模型';
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
      if (result.cancelled) return '连接：已取消';
      const dns = formatDns(result);
      if (result.reachable === false) {
        const stage = result.failureStage === 'dns' ? 'DNS error' : 'Transport error';
        return '连接：不可达 | ' + stage + ' | ' + (result.error || 'Failed') + dns;
      }
      if (result.reachable === undefined && !result.ok) {
        return '连接：未测试 | ' + (result.error || 'Failed') + dns;
      }
      const parts = ['连接：可达'];
      if (result.modelsApi === 'available') {
        parts.push('模型目录：可用');
        if (result.modelCount !== undefined) parts.push(result.modelCount + ' models');
      } else if (result.modelsApi === 'httpError') {
        parts.push('模型目录：' + (result.modelsError || 'HTTP 错误'));
      } else if (result.modelsApi === 'unreachable') {
        parts.push('模型目录：不可用');
      }
      if (result.httpStatus !== undefined) parts.push('HTTP ' + result.httpStatus);
      if (result.latencyMs !== undefined) parts.push(result.latencyMs + ' ms');
      if (result.responseBytes !== undefined) parts.push(formatBytes(result.responseBytes) + ' 响应内容');
      if (result.endpoint) parts.push('接口：' + result.endpoint);
      return parts.join(' | ') + dns;
    }

    function formatDns(result) {
      if (result.dnsError) return ' | DNS: ' + result.dnsError;
      if (!result.resolvedAddresses || !result.resolvedAddresses.length) return '';
      const mode = result.dnsMode === 'vpnFakeIp'
        ? ' (VPN Fake-IP)'
        : result.dnsMode === 'loopback' ? '（当前环境回环地址）' : '';
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
        info.push(formatNetwork(network) + ' | 检查时间：' + time(network.checkedAt));
      }
      if (network || usage || usageEnabled) {
        const values = usage ? usage.ok ? ['剩余 ' + usage.remaining + (usage.unit ? ' ' + usage.unit : '')] : [usage.error === 'Cancelled' ? 'Cancelled' : 'Unavailable'] : [usageEnabled ? 'Not tested' : 'Not enabled'];
        if (usage && !usage.ok && usage.httpStatus !== undefined) values.push('HTTP ' + usage.httpStatus);
        row('Usage', values, usage && !usage.ok);
        if (usage) info.push(formatUsage(usage) + ' | 检查时间：' + time(usage.checkedAt));
      }
      if (report) {
        const summary = report.summary;
        const rate = (value, unit) => summary.comparable && summary.succeeded > 0 && Number.isFinite(value) ? value.toFixed(2) + unit : 'N/A';
        const values = ['输出 ' + rate(summary.generationMedianTps, ' tok/s'), 'TTFT ' + rate(summary.ttftMedianMs === null ? null : summary.ttftMedianMs / 1000, ' s'), '全程 ' + rate(summary.endToEndMedianTps, ' tok/s'), summary.succeeded + '/' + report.parameters.runs + ' passed', 'estimated'];
        const stale = Date.now() - Date.parse(report.finishedAt) > 15 * 60 * 1000;
        const buffered = report.rounds.some(round => round.metrics && round.metrics.timingSource === 'buffered-proxy');
        if (stale) values.push('Stale');
        if (summary.failed) values.push(summary.failed + ' failed');
        if (summary.cancelled) values.push(summary.cancelled + ' cancelled');
        if (!summary.comparable && summary.succeeded) values.push('Mixed conditions');
        if (buffered) values.push('Buffered stream');
        else if (summary.succeeded && summary.comparable && summary.generationMedianTps === null) values.push('Output timing unavailable');
        const first = report.rounds[0]?.metrics;
        if (first && summary.succeeded > 0) row('First round', ['TTFT ' + (first.ttftMs / 1000).toFixed(2) + ' s', '输出 ' + (first.timingSource !== 'buffered-proxy' && Number.isFinite(first.generationTps) ? first.generationTps.toFixed(2) : 'N/A') + ' tok/s'], false);
        row(report.parameters.runs > 1 ? 'Three-round summary' : 'Speed', values, stale || summary.failed || summary.cancelled || !summary.comparable);
        const models = Array.from(new Set(report.rounds.filter(round => round.metrics).map(round => round.metrics.actualModel))).join(', ');
        info.push('生成速度：' + time(report.finishedAt) + ' | 模型：' + (models || report.target.model));
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
      if (!result) return '额度：不支持查询';
      if (!result.ok) {
        const attempts = result.attempts && result.attempts.length ? ' | 已尝试 ' + result.attempts.length + ' 个接口' : '';
        return '额度：' + (result.error || '查询失败') + attempts;
      }
      const unit = result.unit || '';
      const parts = ['额度：' + result.remaining + ' ' + unit];
      if (result.used !== undefined) parts.push('已用 ' + result.used);
      if (result.total !== undefined) parts.push('总量 ' + result.total);
      if (result.strategy) parts.push(result.strategy);
      if (result.endpoint) parts.push('接口：' + result.endpoint);
      return parts.join(' | ');
    }

    function messageTarget(message) {
      const type = message.type;
      if (type === 'organizationAction') { const i = message.input; return i.action === 'createGroup' ? 'providers' : i.action === 'saveGroup' || i.action === 'saveTemplate' && i.groupId ? 'group-editor' : ['saveTemplate', 'deleteTemplate'].includes(i.action) ? 'templates' : i.providerId ? 'provider:' + i.providerId : i.groupId ? 'group:' + i.groupId : 'providers'; }
      if (type === 'createProvider' || type === 'previewModels') return 'add';
      if (type === 'saveProviderConfig' || type === 'testUsageQuery') return 'editor';
      if (type === 'sessionAction') {
        if (message.identityId) return 'account:' + message.identityId;
        if (['backup', 'restore', 'manageBackups', 'deleteHistoryBackups'].includes(message.action)) return 'backup';
        if (message.action === 'exportProviders') return 'configuration';
        if (message.action === 'add') return 'accounts';
        if (message.action === 'reload') return 'mode';
        return 'storage';
      }
      if (message.providerId) return 'provider:' + message.providerId;
      if (['applyNetworkProxy', 'restoreNetworkProxy', 'testNetworkProxy', 'networkClipboard', 'networkPreset'].includes(type)) return 'network';
      if (type === 'applyCodexMode') return 'mode';
      if (type === 'speedTest' || type === 'officialInfo') return 'accounts';
      if (['refreshModels', 'testToolNetwork'].includes(type)) return 'providers';
      if (['exportPublicConfig', 'importPublicConfig'].includes(type)) return 'configuration';
      if (['clearLog', 'logAction'].includes(type)) return 'logs';
      return 'overview';
    }
    function post(message) {
      if (busy) return;
      message.page = activeTool;
      message.target = activeTool + ':' + messageTarget(message);
      if (!message.automatic) { feedback.delete(message.target); renderFeedback(); }
      vscode.postMessage(message);
      setBusy(true);
    }
    function feedbackAnchor(target) {
      const key = target.slice(target.indexOf(':') + 1);
      if (key.startsWith('provider:')) return Array.from(el.codexProviders.querySelectorAll('[data-provider-id]')).find(node => node.dataset.providerId === key.slice(9)) || el.codexSection;
      if (key.startsWith('group:')) return clientPages.codex.groupNodes.get(key.slice(6))?.node || el.codexSection;
      if (key === 'templates') return document.getElementById('codexRequestTemplates');
      if (key === 'group-editor') return document.getElementById('codexGroupEditor');
      if (key.startsWith('account:')) return Array.from(sessionsEl.officialAccountsList.children).find(node => node.dataset.identityId === key.slice(8)) || sessionsEl.officialAccountsSection;
      return document.getElementById(({ overview: 'overviewSection', network: 'networkSection', mode: 'sessionPanel', accounts: 'officialAccountsSection', storage: 'codexDataSection', backup: 'codexBackupSection', configuration: 'codexConfigTransferSection', logs: 'codexLogSection', add: 'codexAddProviderDetails', editor: 'configEditor', providers: 'codexProvidersDetails' })[key]);
    }
    function renderFeedback() {
      if (activeTool === 'codex') el.notice.classList.remove('visible');
      for (const node of document.querySelectorAll('[data-operation-feedback]')) node.remove();
      for (const node of document.querySelectorAll('[data-feedback-marker]')) node.remove();
      for (const [key, result] of feedback) {
        if (result.page !== activeTool) continue;
        if (activeTool === 'claude') { el.notice.textContent = uiText(result.message); el.notice.className = 'notice visible' + (result.status === 'failed' ? ' error' : ''); continue; }
        el.notice.classList.remove('visible');
        const anchor = feedbackAnchor(key); if (!anchor) continue;
        const box = document.createElement('div'); box.dataset.operationFeedback = key;
        box.className = 'operationNotice ' + (result.status === 'failed' ? 'error' : result.status === 'succeeded' ? 'success' : result.status === 'cancelled' ? 'cancelled' : 'progress');
        box.setAttribute('role', result.status === 'failed' ? 'alert' : 'status');
        box.setAttribute('aria-live', 'polite');
        const message = document.createElement('span'); message.className = 'message'; message.textContent = (result.status === 'failed' ? '✕ ' : result.status === 'started' ? '◷ ' : '') + uiText(result.message);
        const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提示');
        close.addEventListener('click', () => { feedback.delete(key); renderFeedback(); });
        box.append(message, close); anchor.before(box); localizeUi(box);
        let ancestor = anchor.parentElement;
        while (ancestor) {
          if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
            const summary = ancestor.children[0];
            if (summary && summary.tagName === 'SUMMARY' && !Array.from(summary.children).some(node => node.dataset.feedbackMarker === result.status)) {
              const marker = document.createElement('span'); marker.dataset.feedbackMarker = result.status;
              marker.textContent = result.status === 'failed' ? ' · ✕ 操作失败' : result.status === 'succeeded' ? ' · ✓ 操作成功' : result.status === 'started' ? ' · ◷ 执行中' : ' · 已取消';
              summary.appendChild(marker);
            }
          }
          ancestor = ancestor.parentElement;
        }
      }
    }
    function setFeedback(key, result) {
      if (feedbackTimers.has(key)) window.clearTimeout(feedbackTimers.get(key));
      feedbackTimers.delete(key);
      if (!result) { feedback.delete(key); return; }
      feedback.set(key, result);
      if (result.status !== 'started') feedbackTimers.set(key, window.setTimeout(() => {
        if (feedback.get(key) === result) { feedback.delete(key); feedbackTimers.delete(key); renderFeedback(); }
      }, 10000));
    }
    function renderReloadState() {
      for (const node of document.querySelectorAll('[data-reload-notice]')) node.remove();
      for (const id of ['networkSection', 'sessionPanel', 'codexDataSection', 'codexSection', 'codexAccountsSection']) document.getElementById(id).classList.remove('reloadRequired', 'reloadAdvisory');
      for (const notice of state.reloadNotices || []) {
        if (notice.tool !== activeTool || !notice.required && Date.now() - notice.at >= 60000) continue;
        const key = notice.tool + ':' + notice.section + ':' + notice.at;
        if (dismissedReload.has(key)) continue;
        const anchor = document.getElementById(({ network: 'networkSection', mode: 'sessionPanel', storage: 'codexDataSection', providers: 'codexSection' })[notice.section]);
        anchor.classList.add(notice.required ? 'reloadRequired' : 'reloadAdvisory');
        if (notice.tool === 'codex' && ['mode', 'providers'].includes(notice.section)) { const parent = document.getElementById('codexAccountsSection'); if (notice.required) { parent.classList.remove('reloadAdvisory'); parent.classList.add('reloadRequired'); } else if (!parent.classList.contains('reloadRequired')) parent.classList.add('reloadAdvisory'); }
        const box = document.createElement('div'); box.dataset.reloadNotice = key; box.className = 'reloadNotice';
        const text = document.createElement('span'); text.textContent = '⚠ ' + notice.reason + (notice.required ? ' · 等待重新加载' : ' · 临时提醒'); box.appendChild(text);
        const button = document.createElement('button'); button.textContent = notice.required ? '重新加载窗口' : '关闭提醒';
        button.addEventListener('click', () => { if (notice.required) post({ type: 'sessionAction', action: 'reload' }); else { dismissedReload.add(key); vscode.setState({ ...(vscode.getState() || {}), dismissedReload: [...dismissedReload].slice(-50) }); renderReloadState(); } }); box.appendChild(button); anchor.before(box); localizeUi(box);
        if (!notice.required && !reloadTimers.has(key)) reloadTimers.set(key, window.setTimeout(() => { reloadTimers.delete(key); renderReloadState(); }, Math.max(0, notice.at + 60000 - Date.now())));
      }
    }
    function showLocalFeedback(scope, message, isError) {
      setFeedback(activeTool + ':' + scope, { page: activeTool, status: isError ? 'failed' : 'succeeded', message }); renderFeedback();
    }
    function showNotice(message, isError) { showLocalFeedback('overview', message, isError); }
    function showAddNotice(message, isError) { showLocalFeedback('add', message, isError); }
    function showAddWarning(message) { showLocalFeedback('add', message, true); }

    function restoreFoldState() {
      if (activeTool !== 'codex') return;
      const environment = state.sessions?.environmentId;
      if (!environment || foldEnvironment === environment) return;
      restoringFolds = true; foldEnvironment = environment;
      const saved = foldsByEnvironment[environment] || {};
      for (const details of document.querySelectorAll('[data-fold]')) {
        const key = details.dataset.fold;
        details.open = key in saved ? saved[key] : key === 'overview' || key === 'mode' || key === 'accounts' || key === 'providers' || key.startsWith('group:') || key === 'storage' && !state.sessions?.root;
      }
      restoringFolds = false;
    }
    document.addEventListener('toggle', event => {
      const details = event.target;
      if (activeTool !== 'codex' || restoringFolds || !foldEnvironment || !details.dataset?.fold) return;
      const saved = foldsByEnvironment[foldEnvironment] ||= {};
      saved[details.dataset.fold] = details.open;
      vscode.setState({ ...(vscode.getState() || {}), foldsByEnvironment });
    }, true);

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
      const tool = prefix === 'add' ? el.tool.value : prefix === 'edit' ? configEditorTool : 'codex';
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
      updateProxyVisibility(prefix, prefix === 'add' ? el.tool.value : prefix === 'edit' ? configEditorTool : 'codex');
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
          try { value = JSON.parse(field.value); } catch { throw new Error('兼容转发设置中的 JSON 格式有误：' + key); }
        } else value = field.value;
        if (JSON.stringify(value) !== JSON.stringify(defaults[key])) overrides[key] = value;
      }
      return { mode: proxyElement(prefix, 'Mode').value, preset, apiFormat, overrides };
    }
    for (const prefix of ['add', 'edit', 'group', 'template']) {
      proxyElement(prefix, 'Mode').addEventListener('change', () => updateProxyVisibility(prefix, prefix === 'add' ? el.tool.value : prefix === 'edit' ? configEditorTool : 'codex'));
      const reset = () => setProxyConfig(prefix, { mode: proxyElement(prefix, 'Mode').value, preset: proxyElement(prefix, 'Preset').value, apiFormat: proxyElement(prefix, 'ApiFormat').value, overrides: {} });
      proxyElement(prefix, 'ApiFormat').addEventListener('change', reset);
      proxyElement(prefix, 'Preset').addEventListener('change', reset);
      proxyElement(prefix, 'Reset').addEventListener('click', reset);
      setProxyConfig(prefix);
    }
    updateAddMode();
    resetModels();
    post({ type: 'ready', automatic: true });
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

function feedbackTarget(message: IncomingMessage, page: string): string {
  if (message.target && new RegExp('^' + page + ':(?:overview|network|mode|accounts|storage|backup|configuration|logs|add|editor|providers|templates|group-editor|group:[a-zA-Z0-9_-]+|provider:[a-zA-Z0-9_-]+|account:[a-zA-Z0-9_-]+)$').test(message.target)) return message.target;
  if (message.type === 'organizationAction') { const i = message.input; return page + ':' + (i.action === 'createGroup' ? 'providers' : i.action === 'saveGroup' || i.action === 'saveTemplate' && i.groupId ? 'group-editor' : ['saveTemplate', 'deleteTemplate'].includes(i.action) ? 'templates' : i.providerId ? 'provider:' + i.providerId : i.groupId ? 'group:' + i.groupId : 'providers'); }
  if ('providerId' in message && message.providerId) return page + ':provider:' + message.providerId;
  if (message.type === 'sessionAction') return page + ':' + (['add', 'rename', 'switch'].includes(message.action) ? 'accounts' : ['backup', 'restore', 'manageBackups', 'deleteHistoryBackups'].includes(message.action) ? 'backup' : message.action === 'exportProviders' ? 'configuration' : 'storage');
  if (message.type === 'applyCodexMode') return page + ':mode';
  if (['applyNetworkProxy', 'restoreNetworkProxy', 'testNetworkProxy', 'networkClipboard', 'networkPreset'].includes(message.type)) return page + ':network';
  if (['createProvider', 'previewModels'].includes(message.type)) return page + ':add';
  if (['clearLog', 'logAction'].includes(message.type)) return page + ':logs';
  if (['exportPublicConfig', 'importPublicConfig'].includes(message.type)) return page + ':configuration';
  return page + ':overview';
}
function operationLabel(message: IncomingMessage): string {
  if (message.type === 'sessionAction') return ({ configure: '连接数据目录', add: '添加账号', rename: '修改账号名称', switch: '切换账号', refresh: '刷新状态', backup: '备份历史', restore: '恢复历史', reload: '重载窗口', openFolder: '打开目录', exportProviders: '保存供应商配置', manageBackups: '浏览历史备份', deleteHistoryBackups: '删除历史备份', help: '打开目录说明' })[message.action];
  if (message.type === 'organizationAction') return ({ createGroup: '新建群组', renameGroup: '修改群组名称', toggleGroup: '更改群组状态', toggleProvider: '更改供应商状态', moveGroup: '调整群组顺序', moveProvider: '移动供应商', saveGroup: '保存群组模板', saveTemplate: '保存请求处理模板', deleteTemplate: '删除模板', providerTemplate: '载入群组模板', networkDraft: '载入本组网络草稿' })[message.input.action];
  if (message.type === 'clientAction') return '客户端操作';
  return ({ networkClipboard: '复制或粘贴网络设置', networkPreset: '管理网络预设', officialInfo: '读取模型与额度', refreshProviderModels: '刷新模型列表', ready: '刷新状态', previewModels: '获取模型列表', createProvider: '保存 Provider', setCurrentProvider: '应用 Provider', applyProvider: '应用 Provider', openProviderConfig: '打开配置', saveProviderConfig: '保存配置', controlProxy: '操作代理', applyCodexMode: '切换登录模式', deleteProvider: '删除 Provider', moveProvider: '调整排序', testProviderNetwork: '测试网络和用量', testToolNetwork: '测试当前连接', testUsageQuery: '查询用量', verifyProviderModel: '验证模型', speedTest: '测速', copySpeedQuery: '复制查询命令', deleteBackups: '删除备份', setToolEnabled: '修改启用状态', updateProviderModel: '选择模型', refreshModels: '刷新模型', openClaudeTerminal: '打开终端', openCodexTerminal: '打开终端', viewConfig: '打开配置文件', exportPublicConfig: '导出 Provider 配置', importPublicConfig: '导入 Provider 配置', clearLog: '删除日志', logAction: '查看或导出日志', applyNetworkProxy: '应用网络设置', restoreNetworkProxy: '恢复网络设置', testNetworkProxy: '测试代理连接' })[message.type];
}
export function diagnosticFailure(message: IncomingMessage, state: SidebarViewState): string | undefined {
  const provider = 'providerId' in message ? state.providers.find(p => p.id === message.providerId) : undefined;
  if (message.type === 'speedTest') {
    const report = provider?.speedResult ?? (!message.providerId ? state.officialSpeedResult : undefined);
    if (!report) return '测速未产生结果，请查看日志。';
    if (report.summary.cancelled) return '已取消：测速中断，已有结果保留。';
    if (report.summary.failed || !report.summary.succeeded) return '测速失败：' + (report.rounds.find(r => r.error)?.error || '没有成功样本') + '。已保存结果，可展开本卡片详情查看。';
  }
  if (message.type === 'verifyProviderModel' && provider?.compatibility && !provider.compatibility.ok) return '模型验证失败：' + (provider.compatibility.error || provider.compatibility.failureKind);
  if (message.type === 'testUsageQuery' && provider?.usageResult && !provider.usageResult.ok) return '用量查询失败：' + provider.usageResult.error;
  if (message.type === 'testProviderNetwork' || message.type === 'testToolNetwork') {
    const tested = message.type === 'testToolNetwork' ? state.providers.filter(p => p.tool === message.tool && p.codexMode !== 'official' && (!state.lastBatch || state.lastBatch.tool !== message.tool || state.lastBatch.providerIds.includes(p.id))) : provider ? [provider] : [];
    for (const p of tested) {
      if (p.networkTest?.cancelled) return '已取消：网络测试。';
      if (p.networkTest && (!p.networkTest.ok || p.networkTest.modelsApi === 'httpError' || p.networkTest.modelsApi === 'unreachable')) return p.name + ' 网络或模型列表测试失败：' + (p.networkTest.error || p.networkTest.modelsError || '模型接口不可用');
      if (p.usageResult && !p.usageResult.ok && p.usageEnabled && ![404, 405].includes(p.usageResult.httpStatus ?? 0) && !p.usageResult.error?.startsWith('No supported usage endpoint')) return p.name + ' 网络测试完成，但用量查询失败：' + p.usageResult.error;
    }
  }
  if (message.type === 'officialInfo' && state.officialInfo && !state.officialInfo.models.length && !state.officialInfo.windows.length) return '当前客户端没有返回模型或额度信息，请检查登录状态。';
  if (message.type === 'testNetworkProxy') {
    const test = state.networkProxy?.tools?.[message.tool ?? 'codex']?.test;
    const failures = test?.results.filter(r => !r.reachable);
    if (failures?.length) return '代理连接测试失败：' + failures.map(r => r.target + '：' + (r.error || '不可达')).join('；');
  }
}
function operationSuccess(message: IncomingMessage, state: SidebarViewState): string {
  if (message.type === 'sessionAction' || message.type === 'applyCodexMode') {
    if (state.sessions?.restartRequired) return '✓ 操作成功。目录或账号绑定已改变，请在登录模式中重载窗口后继续。';
  }
  if (message.type === 'organizationAction' && message.input.action === 'providerTemplate') return '✓ 群组模板已填入供应商编辑器，请检查后保存；没有改写运行配置。';
  if (message.type === 'organizationAction' && message.input.action === 'networkDraft') return '✓ 已填入 Codex 网络草稿，请到网络设置核对并明确应用。';
  if (message.type === 'saveProviderConfig') return '✓ 配置已保存，点击“应用”后写入到当前环境。';
  if (message.type === 'applyProvider' || message.type === 'setCurrentProvider') { const pending = state.reloadNotices?.find(n => n.tool === 'codex' && (n.section === 'mode' || n.section === 'providers')); return '✓ 配置已写入。' + (pending?.reason || '已有客户端可能需要重新打开。'); }
  if (message.type === 'applyNetworkProxy' || message.type === 'restoreNetworkProxy') return '✓ 网络配置已保存，请按模块中的提示重新加载客户端。';
  if (message.type === 'officialInfo' && state.officialInfo?.unavailable.length) return '查询已完成，部分信息暂不可用，请查看当前账号诊断。';
  if (message.type === 'clearLog') return '✓ 日志已删除；本次删除结果会作为新日志保留。';
  return '✓ ' + operationLabel(message) + '成功。';
}

function escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
