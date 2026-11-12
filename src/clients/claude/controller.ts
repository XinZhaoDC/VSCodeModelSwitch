import { ProviderClientController, ProviderClientHost } from '../../shared/clients/providerController';
import type { IncomingMessage, SidebarController } from '../../ui/sidebarView';
import { claudePageScript, claudeProvidersHtml } from './view';
type ClaudeHost = ProviderClientHost & Pick<SidebarController, 'deleteBackupsFromSidebar' | 'openClaudeTerminalFromSidebar'>;
export class ClaudeClientController extends ProviderClientController<ClaudeHost> {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  readonly browser = { controller: 'ClaudePage', script: claudePageScript(), markup: claudeProvidersHtml(), sharedFrame: true };
  readonly capabilities = ['providers', 'network'] as const;
  protected async dispatch(message: IncomingMessage): Promise<void> {
    switch (message.type) {
        case 'deleteBackups': await this.host.deleteBackupsFromSidebar(message.tool); break;
        case 'openClaudeTerminal': await this.host.openClaudeTerminalFromSidebar(); break;
      default: await super.dispatch(message);
    }
  }
}
