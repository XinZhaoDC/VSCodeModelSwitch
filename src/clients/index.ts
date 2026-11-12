import type { SidebarController } from '../ui/sidebarView';
import type { ClientReply } from '../shared/clients/providerController';
import { ClientRegistry, ClientModule } from '../shell/clientRegistry';
import { CodexClientController } from './codex/controller';
import { ClaudeClientController } from './claude/controller';

/** The single built-in registration point; new clients supply their own controller and view. */
export function createClientRegistry(host: SidebarController, reply: ClientReply, additional: ClientModule[] = []): ClientRegistry {
  return new ClientRegistry([new CodexClientController(host, reply), new ClaudeClientController(host, reply), ...additional]);
}
