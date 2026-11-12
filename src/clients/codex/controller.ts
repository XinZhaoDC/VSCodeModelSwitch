import { ProviderClientController, ProviderClientHost } from '../../shared/clients/providerController';
import type { IncomingMessage, SidebarController } from '../../ui/sidebarView';
import { codexPageScript, codexProvidersHtml } from './view';
type CodexHost = ProviderClientHost & Pick<SidebarController, 'sessionActionFromSidebar' | 'applyCodexModeFromSidebar' | 'officialInfoFromSidebar' | 'openCodexTerminalFromSidebar' | 'organizationActionFromSidebar'>;
export class CodexClientController extends ProviderClientController<CodexHost> {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly browser = { controller: 'CodexPage', script: codexPageScript(), markup: codexProvidersHtml(), sharedFrame: true };
  readonly capabilities = ['providers', 'network', 'accounts', 'sharedHistory', 'groups', 'requestTemplates'] as const;
  protected async dispatch(message: IncomingMessage): Promise<void> {
    switch (message.type) {
        case 'sessionAction': await this.host.sessionActionFromSidebar(message.action, message.identityId, message.file); break;
        case 'applyCodexMode': await this.host.applyCodexModeFromSidebar(message.mode); break;
        case 'officialInfo': await this.host.officialInfoFromSidebar(); break;
        case 'openCodexTerminal': await this.host.openCodexTerminalFromSidebar(); break;
        case 'organizationAction': {
          const result = await this.host.organizationActionFromSidebar(message.input);
          if (result.editor) await this.reply({ type: 'configEditor', ...result.editor as object });
          if (result.networkDraft) await this.reply({ type: 'networkDraft', tool: this.id, config: result.networkDraft });
          await this.reply({ type: 'organizationResult', inputAction: message.input.action, sourceGroupId: message.input.groupId, ...result }); break;
        }
      default: await super.dispatch(message);
    }
  }
}
