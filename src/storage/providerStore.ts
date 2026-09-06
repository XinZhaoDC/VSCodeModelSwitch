import * as vscode from 'vscode';
import { ModelCacheEntry, ProviderProfile, ToolId } from '../types';

const PROVIDERS_KEY = 'vscodemodelswitch.providers';
const CURRENT_PROVIDER_IDS_KEY = 'vscodemodelswitch.currentProviderIds';
const LEGACY_CURRENT_PROVIDER_ID_KEY = 'vscodemodelswitch.currentProviderId';
const MODEL_CACHE_KEY = 'vscodemodelswitch.modelCache';
const TOOL_ENABLED_KEY = 'vscodemodelswitch.toolEnabled';

export class ProviderStore {
  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.globalState.setKeysForSync([
      PROVIDERS_KEY,
      CURRENT_PROVIDER_IDS_KEY,
      TOOL_ENABLED_KEY
    ]);
  }

  getProviders(): ProviderProfile[] {
    const value = this.context.globalState.get<unknown[]>(PROVIDERS_KEY, []);
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((item) => normalizeProvider(item));
  }

  async saveProviders(providers: ProviderProfile[]): Promise<void> {
    await this.context.globalState.update(PROVIDERS_KEY, providers);
  }

  getProvider(id: string): ProviderProfile | undefined {
    return this.getProviders().find((provider) => provider.id === id);
  }

  async upsertProvider(provider: ProviderProfile): Promise<void> {
    const providers = this.getProviders();
    const index = providers.findIndex((item) => item.id === provider.id);
    if (index >= 0) {
      providers[index] = provider;
    } else {
      providers.push(provider);
    }
    await this.saveProviders(providers);
  }

  async updateProvider(id: string, updater: (provider: ProviderProfile) => ProviderProfile): Promise<ProviderProfile | undefined> {
    const providers = this.getProviders();
    const index = providers.findIndex((item) => item.id === id);
    if (index < 0) {
      return undefined;
    }
    const updated = updater(providers[index]);
    providers[index] = updated;
    await this.saveProviders(providers);
    return updated;
  }

  async deleteProvider(id: string): Promise<ProviderProfile | undefined> {
    const providers = this.getProviders();
    const index = providers.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [deleted] = providers.splice(index, 1);
    await this.saveProviders(providers);
    for (const tool of ['claude', 'codex'] as ToolId[]) {
      if (this.getCurrentProviderId(tool) === id) await this.setCurrentProviderId(tool, undefined);
    }
    return deleted;
  }

  async moveProvider(providerId: string, beforeProviderId: string): Promise<void> {
    const providers = this.getProviders();
    const sourceIndex = providers.findIndex((provider) => provider.id === providerId);
    const targetIndex = providers.findIndex((provider) => provider.id === beforeProviderId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const [provider] = providers.splice(sourceIndex, 1);
    const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    providers.splice(insertionIndex, 0, provider);
    await this.saveProviders(providers);
  }

  getProvidersByTool(tool: ToolId): ProviderProfile[] {
    return this.getProviders().filter((provider) => provider.tool === tool);
  }

  getCurrentProviderIds(): Partial<Record<ToolId, string>> {
    const current = this.context.globalState.get<Partial<Record<ToolId, string>>>(CURRENT_PROVIDER_IDS_KEY, {});
    const legacy = this.context.globalState.get<string>(LEGACY_CURRENT_PROVIDER_ID_KEY);
    if (legacy && Object.keys(current).length === 0) {
      const provider = this.getProvider(legacy);
      if (provider) {
        return { [provider.tool]: legacy };
      }
    }
    return current && typeof current === 'object' ? current : {};
  }

  getCurrentProviderId(tool: ToolId): string | undefined {
    return this.getCurrentProviderIds()[tool];
  }

  getCurrentProvider(tool: ToolId): ProviderProfile | undefined {
    const id = this.getCurrentProviderId(tool);
    const provider = id ? this.getProvider(id) : undefined;
    return provider?.tool === tool ? provider : undefined;
  }

  getCurrentProviders(): Partial<Record<ToolId, ProviderProfile>> {
    return {
      claude: this.getCurrentProvider('claude'),
      codex: this.getCurrentProvider('codex')
    };
  }

  async setCurrentProviderId(tool: ToolId, id: string | undefined): Promise<void> {
    const current = this.getCurrentProviderIds();
    if (id) {
      current[tool] = id;
    } else {
      delete current[tool];
    }
    await this.context.globalState.update(CURRENT_PROVIDER_IDS_KEY, current);
  }

  getToolEnabled(tool: ToolId): boolean {
    const value = this.context.globalState.get<Partial<Record<ToolId, boolean>>>(TOOL_ENABLED_KEY, {});
    return value[tool] !== false;
  }

  async setToolEnabled(tool: ToolId, enabled: boolean): Promise<void> {
    const value = this.context.globalState.get<Partial<Record<ToolId, boolean>>>(TOOL_ENABLED_KEY, {});
    value[tool] = enabled;
    await this.context.globalState.update(TOOL_ENABLED_KEY, value);
  }

  getModelCache(): ModelCacheEntry[] {
    const value = this.context.globalState.get<ModelCacheEntry[]>(MODEL_CACHE_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  findModelCache(tool: string, baseUrl: string, keyFingerprint: string): ModelCacheEntry | undefined {
    const now = Date.now();
    return this.getModelCache().find((entry) => {
      if (entry.tool !== tool || entry.baseUrl !== baseUrl || entry.keyFingerprint !== keyFingerprint) {
        return false;
      }
      const fetchedAt = new Date(entry.fetchedAt).getTime();
      return Number.isFinite(fetchedAt) && now - fetchedAt < entry.ttlMs;
    });
  }

  async saveModelCache(entry: ModelCacheEntry): Promise<void> {
    const entries = this.getModelCache().filter((item) => {
      return !(
        item.tool === entry.tool &&
        item.baseUrl === entry.baseUrl &&
        item.keyFingerprint === entry.keyFingerprint
      );
    });
    entries.push(entry);
    await this.context.globalState.update(MODEL_CACHE_KEY, entries.slice(-50));
  }
}

function normalizeProvider(value: unknown): ProviderProfile[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const item = value as Record<string, unknown>;
  if (item.tool === 'claude' || item.tool === 'codex') {
    if (
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.baseUrl === 'string' &&
      typeof item.secretRef === 'string' &&
      item.modelPolicy &&
      typeof item.modelPolicy === 'object'
    ) {
      return [item as unknown as ProviderProfile];
    }
    return [];
  }

  const migrated: ProviderProfile[] = [];
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
  const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
  const id = typeof item.id === 'string' ? item.id : '';
  const name = typeof item.name === 'string' ? item.name : 'Imported Provider';

  const claude = normalizeLegacyEndpoint(item.claude);
  if (id && claude) {
    migrated.push({
      id: `${id}-claude`,
      name,
      tool: 'claude',
      baseUrl: claude.baseUrl,
      modelPolicy: claude.modelPolicy,
      secretRef: claude.secretRef,
      createdAt,
      updatedAt
    });
  }

  const codex = normalizeLegacyEndpoint(item.codex);
  const codexObject = item.codex && typeof item.codex === 'object' ? (item.codex as Record<string, unknown>) : undefined;
  if (id && codex) {
    migrated.push({
      id: `${id}-codex`,
      name,
      tool: 'codex',
      baseUrl: codex.baseUrl,
      modelPolicy: codex.modelPolicy,
      secretRef: codex.secretRef,
      codex: {
        providerId: typeof codexObject?.providerId === 'string' ? codexObject.providerId : name.toLowerCase(),
        wireApi: codexObject?.wireApi === 'chat' ? 'chat' : 'responses'
      },
      createdAt,
      updatedAt
    });
  }

  return migrated;
}

function normalizeLegacyEndpoint(value: unknown): Pick<ProviderProfile, 'baseUrl' | 'modelPolicy' | 'secretRef'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.baseUrl === 'string' &&
    typeof item.secretRef === 'string' &&
    item.modelPolicy &&
    typeof item.modelPolicy === 'object'
  ) {
    return {
      baseUrl: item.baseUrl,
      modelPolicy: item.modelPolicy as ProviderProfile['modelPolicy'],
      secretRef: item.secretRef
    };
  }
  return undefined;
}
