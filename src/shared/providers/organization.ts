import { randomUUID } from 'crypto';
import { ProviderProfile, ProxyConfig, ToolId } from '../../types';
import { normalizeProxyConfig } from '../../proxy/config';

export const INDEPENDENT_GROUP = 'independent';
export const organizationKey = (tool: ToolId) => `vscodemodelswitch.organization.${tool}`;
export interface GroupDefaults { baseUrl?: string; proxy?: ProxyConfig; templateName?: string }
export interface ProviderGroup { id: string; name: string; defaults?: GroupDefaults }
export interface RequestTemplate { id: string; name: string; proxy: ProxyConfig }
export interface ProviderOrganization {
  version: 1; groups: ProviderGroup[]; templates: RequestTemplate[];
  memberships: Record<string, string>; providerOrder: string[];
}
export interface OrganizationLocalState {
  disabledGroups: string[]; disabledProviders: string[]; groupNetworkPresets: Record<string, string>;
}
export interface OrganizationView extends ProviderOrganization, OrganizationLocalState {}
interface Storage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}
export const normalizedName = (name: string) => name.trim().normalize('NFKC').toLowerCase();
export const emptyOrganization = (): ProviderOrganization => ({ version: 1, groups: [{ id: INDEPENDENT_GROUP, name: '独立供应商' }], templates: [], memberships: {}, providerOrder: [] });
const emptyLocal = (): OrganizationLocalState => ({ disabledGroups: [], disabledProviders: [], groupNetworkPresets: {} });

/** Shared definitions, environment-local availability. No client files or keys. */
export class ProviderOrganizationStore {
  constructor(readonly tool: ToolId, private readonly shared: Storage, private readonly local: Storage, private readonly providers: () => ProviderProfile[]) {}
  read(): ProviderOrganization { return structuredClone(this.shared.get(organizationKey(this.tool), emptyOrganization())); }
  localState(): OrganizationLocalState { return structuredClone(this.local.get(organizationKey(this.tool) + '.local', emptyLocal())); }
  view(): OrganizationView { return { ...this.read(), ...this.localState() }; }
  async save(value: ProviderOrganization): Promise<void> {
    await this.shared.update(organizationKey(this.tool), canonicalOrganization(value, this.tool));
  }
  async saveLocal(value: OrganizationLocalState): Promise<void> { await this.local.update(organizationKey(this.tool) + '.local', value); }
  groupOf(id: string, value = this.read()): string { return value.memberships[id] ?? INDEPENDENT_GROUP; }
  isEnabled(id: string): boolean {
    const local = this.localState(); return !local.disabledProviders.includes(id) && !local.disabledGroups.includes(this.groupOf(id));
  }
  assertEnabled(id: string): void { if (!this.isEnabled(id)) throw new Error('该供应商或所在群组已禁用，请先恢复后操作。'); }
  async createGroup(name: string): Promise<string> {
    const value = this.read(); name = checkedName(name, value.groups);
    const id = randomUUID(); value.groups.push({ id, name }); await this.save(value); return id;
  }
  async renameGroup(id: string, name: string): Promise<void> {
    const value = this.read(), group = this.requireGroup(id, value);
    if (id === INDEPENDENT_GROUP) throw new Error('默认群组名称保留为“独立供应商”。');
    group.name = checkedName(name, value.groups, id); await this.save(value);
  }
  requireGroup(id: string, value = this.read()): ProviderGroup {
    const group = value.groups.find(g => g.id === id); if (!group) throw new Error('群组不存在，请刷新状态。'); return group;
  }
  async setGroupEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireGroup(id); const local = this.localState();
    local.disabledGroups = local.disabledGroups.filter(x => x !== id); if (!enabled) local.disabledGroups.push(id); await this.saveLocal(local);
  }
  async setProviderEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireProvider(id); const local = this.localState();
    if (local.disabledGroups.includes(this.groupOf(id))) throw new Error('请先恢复所在群组，再更改单个供应商状态。');
    local.disabledProviders = local.disabledProviders.filter(x => x !== id); if (!enabled) local.disabledProviders.push(id); await this.saveLocal(local);
  }
  async moveGroup(id: string, beforeId?: string): Promise<void> {
    const value = this.read(); this.requireGroup(id, value); if (beforeId) this.requireGroup(beforeId, value);
    if (id === beforeId) return;
    const local = this.localState();
    if (beforeId && local.disabledGroups.includes(id) !== local.disabledGroups.includes(beforeId)) throw new Error('启用群组和禁用群组分别排序。');
    const moving = value.groups.find(g => g.id === id)!; value.groups = value.groups.filter(g => g.id !== id);
    const index = beforeId ? value.groups.findIndex(g => g.id === beforeId) : value.groups.length;
    value.groups.splice(index, 0, moving); await this.save(value);
  }
  requireProvider(id: string): ProviderProfile {
    const p = this.providers().find(p => p.id === id && p.tool === this.tool && p.codexMode !== 'official');
    if (!p) throw new Error('供应商不存在或不属于当前客户端。'); return p;
  }
  async moveProvider(id: string, groupId: string, beforeId?: string): Promise<void> {
    this.requireProvider(id); const value = this.read(); this.requireGroup(groupId, value);
    const currentGroup = this.groupOf(id, value), local = this.localState();
    if (id === beforeId && currentGroup === groupId) return;
    // Disabled entries can be ordered in place; enabled entries can enter disabled groups.
    if (!this.isEnabled(id) && currentGroup !== groupId) throw new Error('已禁用的供应商只能在当前群组内排序，请先恢复后移动。');
    if (beforeId) {
      this.requireProvider(beforeId);
      if (this.groupOf(beforeId, value) !== groupId) throw new Error('排序目标不属于该群组。');
      const sourceDisabled = local.disabledProviders.includes(id) || local.disabledGroups.includes(groupId);
      if (sourceDisabled !== !this.isEnabled(beforeId)) throw new Error('启用和禁用供应商分别排序。');
    }
    value.memberships[id] = groupId;
    const order = [...new Set([...value.providerOrder, ...this.providers().filter(p => p.tool === this.tool).map(p => p.id)])].filter(x => x !== id);
    order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, id); value.providerOrder = order; await this.save(value);
  }
  async assignNewProvider(id: string, groupId = INDEPENDENT_GROUP): Promise<void> {
    this.requireProvider(id); const value = this.read(); this.requireGroup(groupId, value); value.memberships[id] = groupId;
    if (!value.providerOrder.includes(id)) value.providerOrder.push(id); await this.save(value);
  }
  async saveGroupDefaults(id: string, defaults: GroupDefaults, networkPresetName?: string): Promise<void> {
    const value = this.read(), group = this.requireGroup(id, value);
    if (this.localState().disabledGroups.includes(id)) throw new Error('群组已禁用，请先恢复后修改模板。');
    const baseUrl = defaults.baseUrl?.trim().replace(/\/+$/, '');
    if (baseUrl) { const url = new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('群组 API 地址应为不含凭据或查询参数的 HTTP(S) 地址。'); }
    group.defaults = { baseUrl, proxy: normalizeProxyConfig(defaults.proxy, this.tool), templateName: defaults.templateName?.trim() };
    const previous = this.read(); await this.save(value);
    try { const local = this.localState(); if (networkPresetName) local.groupNetworkPresets[id] = networkPresetName; else delete local.groupNetworkPresets[id]; await this.saveLocal(local); }
    catch (e) { await this.save(previous); throw e; }
  }
  async saveTemplate(name: string, proxy: ProxyConfig, id?: string): Promise<string> {
    const value = this.read(); name = checkedName(name, value.templates, id); proxy = normalizeProxyConfig(proxy, this.tool);
    const existing = id ? value.templates.find(t => t.id === id) : undefined;
    if (id && !existing) throw new Error('模板不存在，请刷新后重试。');
    const template = { id: id ?? randomUUID(), name, proxy };
    if (existing) value.templates[value.templates.indexOf(existing)] = template; else value.templates.push(template);
    await this.save(value); return template.id;
  }
  async deleteTemplate(id: string): Promise<void> {
    const value = this.read(); if (!value.templates.some(t => t.id === id)) throw new Error('模板不存在。');
    value.templates = value.templates.filter(t => t.id !== id); await this.save(value);
  }
}
function checkedName(name: string, entries: Array<{ id: string; name: string }>, excluded?: string): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('名称须为1至100个字符。');
  if (entries.some(x => x.id !== excluded && normalizedName(x.name) === normalizedName(name))) throw new Error('已存在同名项目，请使用其他名称。');
  return name.trim();
}
export function validateOrganization(value: ProviderOrganization, tool: ToolId): void {
  if (!value || value.version !== 1 || !Array.isArray(value.groups) || !Array.isArray(value.templates) || !value.memberships || typeof value.memberships !== 'object' || Array.isArray(value.memberships) || !Array.isArray(value.providerOrder)) throw new Error('群组配置格式无效。');
  for (const entries of [value.groups, value.templates]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9_-]+$/.test(entry.id) || ids.has(entry.id)) throw new Error('群组或模板 ID 重复或无效。');
      ids.add(entry.id); checkedName(entry.name, entries, entry.id);
    }
  }
  if (!value.groups.some(g => g.id === INDEPENDENT_GROUP && g.name === '独立供应商')) throw new Error('缺少默认“独立供应商”群组。');
  for (const group of value.groups) if (group.defaults?.proxy) normalizeProxyConfig(group.defaults.proxy, tool);
  for (const group of value.groups) if (group.defaults?.baseUrl) {
    const url = new URL(group.defaults.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('群组 API 地址不能包含凭据或查询参数。');
  }
  for (const template of value.templates) normalizeProxyConfig(template.proxy, tool);
  for (const group of Object.values(value.memberships)) if (!value.groups.some(g => g.id === group)) throw new Error('供应商引用了不存在的群组。');
  if (value.providerOrder.some(id => typeof id !== 'string') || new Set(value.providerOrder).size !== value.providerOrder.length) throw new Error('供应商排序无效。');
}
/** Public templates have a small explicit shape; unknown imported secret fields are never retained. */
export function canonicalOrganization(value: ProviderOrganization, tool: ToolId): ProviderOrganization {
  validateOrganization(value, tool);
  return { version: 1,
    groups: value.groups.map(g => ({ id: g.id, name: g.name.trim(), ...(g.defaults ? { defaults: {
      baseUrl: g.defaults.baseUrl?.trim(), templateName: g.defaults.templateName,
      proxy: normalizeProxyConfig(g.defaults.proxy, tool)
    } } : {}) })),
    templates: value.templates.map(t => ({ id: t.id, name: t.name.trim(), proxy: normalizeProxyConfig(t.proxy, tool) })),
    memberships: { ...value.memberships }, providerOrder: [...value.providerOrder] };
}
