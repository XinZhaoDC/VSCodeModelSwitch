import type { IncomingMessage, SidebarController } from '../../ui/sidebarView';
import type { ToolId } from '../../types';
export type ProviderClientHost = Pick<SidebarController, 'recordOperation' | 'getSidebarState' | 'networkClipboardFromSidebar' | 'networkPresetFromSidebar' | 'reloadStateFromSidebar' | 'previewModelsFromSidebar' | 'createProviderFromSidebar' | 'setCurrentProviderFromSidebar' | 'getProviderConfigFromSidebar' | 'saveProviderConfigFromSidebar' | 'controlProxyFromSidebar' | 'applyProviderFromSidebar' | 'deleteProviderFromSidebar' | 'moveProviderFromSidebar' | 'testProviderNetworkFromSidebar' | 'testToolNetworkFromSidebar' | 'testUsageQueryFromSidebar' | 'verifyProviderModelFromSidebar' | 'refreshProviderModelsFromSidebar' | 'speedTestFromSidebar' | 'copySpeedQuery' | 'setToolEnabledFromSidebar' | 'updateProviderModelFromSidebar' | 'refreshModelsFromSidebar' | 'viewConfigFromSidebar' | 'exportPublicConfigFromSidebar' | 'importPublicConfigFromSidebar' | 'clearLogFromSidebar' | 'logActionFromSidebar' | 'applyNetworkProxyFromSidebar' | 'restoreNetworkProxyFromSidebar' | 'testNetworkProxyFromSidebar'>;
export type ClientReply = (message: unknown) => PromiseLike<unknown> | undefined;
/** Reusable API/provider operations. Client-specific operations belong to the client controller. */
export abstract class ProviderClientController<H extends ProviderClientHost = ProviderClientHost> {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  abstract readonly capabilities: readonly string[];
  constructor(protected readonly host: H, protected readonly reply: ClientReply) {}
  async handle(message: IncomingMessage): Promise<void> {
    if ('tool' in message && message.tool && message.tool !== this.id || message.type === 'createProvider' && message.payload.tool !== this.id) throw new Error('操作与当前客户端不匹配。');
    if ('providerId' in message && message.providerId) {
      const provider = (await this.host.getSidebarState()).providers.find(p => p.id === message.providerId);
      if (!provider || provider.tool !== this.id) throw new Error('供应商不属于当前客户端。');
    }
    await this.dispatch(message);
  }
  protected async dispatch(message: IncomingMessage): Promise<void> {
    switch (message.type) {
        case 'networkClipboard': { const config = await this.host.networkClipboardFromSidebar(message.tool, message.action, message.config); if (config) await this.reply({ type: 'networkDraft', config, tool: message.tool }); break; }
        case 'networkPreset': await this.host.networkPresetFromSidebar(message.tool, message.action, message.config, message.name); break;
        case 'ready': await this.host.reloadStateFromSidebar(); break;
        case 'previewModels': {
          const models = await this.host.previewModelsFromSidebar(message.tool, message.baseUrl, message.key, message.proxy);
          await this.reply({ type: 'models', models }); break;
        }
        case 'createProvider':
          await this.host.createProviderFromSidebar(message.payload);
          await this.reply({ type: 'providerCreated' }); break;
        case 'setCurrentProvider': await this.host.setCurrentProviderFromSidebar(message.providerId); break;
        case 'openProviderConfig': {
          const config = await this.host.getProviderConfigFromSidebar(message.providerId);
          await this.reply({ type: 'configEditor', ...config }); break;
        }
        case 'saveProviderConfig': {
          await this.host.saveProviderConfigFromSidebar(message.providerId, message.text, message.key, message.usageQuery, message.usageAccessToken, message.proxy, message.codexMode);
          const saved = await this.host.getProviderConfigFromSidebar(message.providerId);
          await this.reply({ type: 'configSaved', text: saved.text, usageQuery: saved.usageQuery, proxy: saved.proxy, codexMode: saved.codexMode }); break;
        }
        case 'controlProxy': await this.host.controlProxyFromSidebar(message.providerId, message.action); break;
        case 'applyProvider': await this.host.applyProviderFromSidebar(message.providerId); break;
        case 'deleteProvider': await this.host.deleteProviderFromSidebar(message.providerId); break;
        case 'moveProvider': await this.host.moveProviderFromSidebar(message.providerId, message.beforeProviderId); break;
        case 'testProviderNetwork': await this.host.testProviderNetworkFromSidebar(message.providerId); break;
        case 'testToolNetwork': await this.host.testToolNetworkFromSidebar(message.tool); break;
        case 'testUsageQuery': await this.host.testUsageQueryFromSidebar(message.providerId, message.usageQuery, message.usageAccessToken); break;
        case 'verifyProviderModel': await this.host.verifyProviderModelFromSidebar(message.providerId); break;
        case 'refreshProviderModels': await this.host.refreshProviderModelsFromSidebar(message.providerId); break;
        case 'speedTest': await this.host.speedTestFromSidebar(message.providerId, message.runs); break;
        case 'copySpeedQuery': await this.host.copySpeedQuery(); break;
        case 'setToolEnabled': await this.host.setToolEnabledFromSidebar(message.tool, message.enabled); break;
        case 'updateProviderModel': await this.host.updateProviderModelFromSidebar(message.providerId); break;
        case 'refreshModels': await this.host.refreshModelsFromSidebar(message.tool); break;
        case 'viewConfig': await this.host.viewConfigFromSidebar(message.tool); break;
        case 'exportPublicConfig': await this.host.exportPublicConfigFromSidebar(this.id); break;
        case 'importPublicConfig': await this.host.importPublicConfigFromSidebar(this.id); break;
        case 'clearLog': if (!await this.host.clearLogFromSidebar()) throw new Error('已取消：日志未删除。'); break;
        case 'logAction': await this.host.logActionFromSidebar(message.action); break;
        case 'applyNetworkProxy': await this.host.applyNetworkProxyFromSidebar(message.config, message.tool); break;
        case 'restoreNetworkProxy': await this.host.restoreNetworkProxyFromSidebar(message.tool); break;
        case 'testNetworkProxy': await this.host.testNetworkProxyFromSidebar(message.config, message.tool); break;
      default: throw new Error('当前客户端不支持此操作。');
    }
  }
}
