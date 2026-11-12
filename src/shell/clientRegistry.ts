import type { IncomingMessage } from '../ui/sidebarView';
export interface ClientModule {
  readonly id: string; readonly label: string; readonly capabilities: readonly string[];
  readonly browser?: { controller: string; script: string; markup: string; sharedFrame?: boolean };
  handle(message: IncomingMessage): Promise<void>;
}
/** Composition root: adding another client adds a module, not another shell branch. */
export class ClientRegistry {
  private readonly modules = new Map<string, ClientModule>();
  constructor(clients: ClientModule[] = []) { for (const client of clients) this.register(client); }
  register(client: ClientModule): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(client.id) || this.modules.has(client.id)) throw new Error('客户端 ID 无效或重复。');
    if (client.browser) {
      if (!/^[A-Za-z_$][\w$]*$/.test(client.browser.controller) || this.list().some(c => c.browser?.controller === client.browser!.controller)) throw new Error('客户端页面控制器名称无效或重复。');
      // Custom pages own their controls; they must not shadow the shared shell's IDs.
      if (!client.browser.sharedFrame) for (const match of client.browser.markup.matchAll(/\bid=["']([^"']+)["']/g)) {
        if (!match[1].startsWith(client.id + '-')) throw new Error('新增客户端的控件 ID 必须使用客户端前缀。');
      }
    }
    this.modules.set(client.id, client);
  }
  get(id: string): ClientModule { const client = this.modules.get(id); if (!client) throw new Error('未注册的客户端。'); return client; }
  list(): ClientModule[] { return [...this.modules.values()]; }
}
