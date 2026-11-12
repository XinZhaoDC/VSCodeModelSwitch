import * as vscode from 'vscode';
import { GroupDefaults, ProviderOrganizationStore } from '../../shared/providers/organization';
import { ProxyConfig } from '../../types';

export interface OrganizationAction {
  action: 'createGroup' | 'renameGroup' | 'toggleGroup' | 'toggleProvider' | 'moveGroup' | 'moveProvider' | 'saveGroup' | 'saveTemplate' | 'deleteTemplate' | 'providerTemplate' | 'networkDraft';
  groupId?: string; beforeGroupId?: string; providerId?: string; beforeProviderId?: string;
  enabled?: boolean; name?: string; defaults?: GroupDefaults; proxy?: ProxyConfig; templateId?: string; networkPresetName?: string;
}
export class CodexOrganizationController {
  constructor(readonly store: ProviderOrganizationStore, private readonly currentProvider: () => string | undefined) {}
  async execute(input: OrganizationAction): Promise<{ createdGroupId?: string; savedTemplateId?: string }> {
    const id = input.groupId;
    switch (input.action) {
      case 'createGroup': {
        const name = input.name ?? await vscode.window.showInputBox({ title: '新建 Codex API 供应商群组', prompt: '允许空群组；名称在 Codex 内唯一。', ignoreFocusOut: true });
        if (!name) throw new Error('已取消：未创建群组。'); return { createdGroupId: await this.store.createGroup(name) };
      }
      case 'renameGroup': {
        const group = this.enabledGroup(id);
        const name = input.name ?? await vscode.window.showInputBox({ title: '修改群组名称', value: group.name, ignoreFocusOut: true });
        if (!name) throw new Error('已取消：名称未更改。'); await this.store.renameGroup(group.id, name); break;
      }
      case 'toggleGroup': {
        const group = this.store.requireGroup(id!);
        if (!input.enabled && this.currentProvider() && this.store.groupOf(this.currentProvider()!) === group.id) {
          const result = await vscode.window.showWarningMessage('该群组包含当前正在使用的供应商。禁用后本群组的配置、测试和应用操作将不可用；当前 Codex 仍使用已应用配置，不会自动切换或停止任务。是否继续？', { modal: true }, { title: '确认禁用群组' }, { title: '取消', isCloseAffordance: true });
          if (result?.title !== '确认禁用群组') throw new Error('已取消：群组未禁用。');
        }
        await this.store.setGroupEnabled(group.id, input.enabled === true); break;
      }
      case 'toggleProvider':
        if (!input.enabled && input.providerId === this.currentProvider()) throw new Error('当前正在使用此供应商，不能禁用。请先切换到其他供应商或官方账号。');
        await this.store.setProviderEnabled(input.providerId!, input.enabled === true); break;
      case 'moveGroup': await this.store.moveGroup(id!, input.beforeGroupId); break;
      case 'moveProvider': {
        const provider = this.store.requireProvider(input.providerId!);
        let target = id;
        if (!target) {
          this.store.assertEnabled(provider.id);
          const local = this.store.localState();
          target = (await vscode.window.showQuickPick(this.store.read().groups.map(g => ({ label: g.name, description: local.disabledGroups.includes(g.id) ? '已禁用 · 可以接收供应商' : '已启用', id: g.id })), { title: '移动到群组（保留供应商现有配置）' }))?.id;
          if (!target) throw new Error('已取消：供应商未移动。');
        }
        if (provider.id === this.currentProvider() && this.store.localState().disabledGroups.includes(target) && this.store.groupOf(provider.id) !== target) {
          const answer = await vscode.window.showWarningMessage('目标群组已禁用。移动后将不能操作此供应商，但当前 Codex 仍使用已应用配置。是否继续？', { modal: true }, { title: '确认移动' }, { title: '取消', isCloseAffordance: true });
          if (answer?.title !== '确认移动') throw new Error('已取消：供应商未移动。');
        }
        await this.store.moveProvider(provider.id, target, input.beforeProviderId); break;
      }
      case 'saveGroup': this.enabledGroup(id); await this.store.saveGroupDefaults(id!, input.defaults ?? {}, input.networkPresetName); break;
      case 'saveTemplate':
        if (input.groupId) this.enabledGroup(input.groupId);
        return { savedTemplateId: await this.store.saveTemplate(input.name!, input.proxy!, input.templateId) };
      case 'deleteTemplate': {
        const answer = await vscode.window.showWarningMessage('删除所选请求处理模板？群组已载入的设置保留。', { modal: true }, { title: '删除模板' }, { title: '取消', isCloseAffordance: true });
        if (answer?.title !== '删除模板') throw new Error('已取消：模板未删除。'); await this.store.deleteTemplate(input.templateId!); break;
      }
      default: throw new Error('不支持的群组操作。');
    }
    return {};
  }
  private enabledGroup(id?: string) {
    const group = this.store.requireGroup(id!);
    if (this.store.localState().disabledGroups.includes(group.id)) throw new Error('群组已禁用，请先恢复后操作。');
    return group;
  }
}
