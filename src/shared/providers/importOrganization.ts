import { ProviderOrganization, emptyOrganization, validateOrganization, canonicalOrganization } from './organization';
import { ToolId } from '../../types';

/** Plan completely before writing either Memento record; no runtime selection is imported. */
export function importOrganization(current: ProviderOrganization, incoming: ProviderOrganization | undefined, mode: 'merge' | 'replace', importedIds: string[], finalIds: string[], tool: ToolId): ProviderOrganization {
  if (incoming) validateOrganization(incoming, tool);
  const value = incoming && mode === 'replace' ? structuredClone(incoming) : structuredClone(current ?? emptyOrganization());
  if (incoming && mode === 'merge') {
    for (const key of ['groups', 'templates'] as const) {
      const target = value[key] as Array<{ id: string; name: string }>;
      for (const item of incoming[key]) {
        const index = target.findIndex(x => x.id === item.id);
        if (index < 0) target.push(structuredClone(item)); else target[index] = structuredClone(item);
      }
    }
    for (const id of importedIds) if (incoming.memberships[id]) value.memberships[id] = incoming.memberships[id];
    value.providerOrder = [...new Set([...value.providerOrder, ...incoming.providerOrder])];
  }
  for (const id of Object.keys(value.memberships)) if (!finalIds.includes(id)) delete value.memberships[id];
  value.providerOrder = [...new Set([...value.providerOrder.filter(id => finalIds.includes(id)), ...finalIds])];
  return canonicalOrganization(value, tool);
}
