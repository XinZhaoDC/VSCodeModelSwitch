export type ToolId = 'claude' | 'codex';

export type ModelPolicy =
  | { type: 'toolDefault' }
  | { type: 'providerAuto'; preferred?: string }
  | { type: 'fixed'; model: string }
  | { type: 'custom'; model: string };

export interface ToolEndpointConfig {
  baseUrl: string;
  modelPolicy: ModelPolicy;
  secretRef: string;
}

export interface CodexEndpointConfig {
  providerId: string;
  wireApi: 'responses' | 'chat';
}

export interface ProviderProfile {
  id: string;
  name: string;
  tool: ToolId;
  baseUrl: string;
  modelPolicy: ModelPolicy;
  secretRef: string;
  configText?: string;
  configMode?: 'generated' | 'custom';
  usageQuery?: UsageQueryConfig;
  codex?: CodexEndpointConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  source: ToolId;
}

export interface NetworkTestResult {
  ok: boolean;
  reachable?: boolean;
  cancelled?: boolean;
  endpoint?: string;
  httpStatus?: number;
  latencyMs?: number;
  responseBytes?: number;
  modelCount?: number;
  modelsApi?: 'available' | 'httpError' | 'unreachable' | 'notTested';
  modelsError?: string;
  resolvedAddresses?: string[];
  dnsMode?: 'standard' | 'vpnFakeIp' | 'loopback';
  dnsError?: string;
  failureStage?: 'dns' | 'transport';
  checkedAt: string;
  error?: string;
}

export interface UsageQueryConfig {
  enabled: boolean;
  preset?: 'auto' | 'generic' | 'deepseek' | 'siliconflow' | 'openrouter' | 'newapi' | 'custom';
  url: string;
  remainingPath: string;
  usedPath?: string;
  totalPath?: string;
  unit: string;
  divisor?: number;
  userId?: string;
}

export interface UsageQueryResult {
  ok: boolean;
  endpoint?: string;
  httpStatus?: number;
  remaining?: number;
  used?: number;
  total?: number;
  unit?: string;
  strategy?: string;
  responseShape?: string;
  attempts?: Array<{
    endpoint: string;
    httpStatus?: number;
    responseShape?: string;
    error?: string;
  }>;
  checkedAt: string;
  error?: string;
}

export interface CompatibilityResult {
  ok: boolean;
  cancelled?: boolean;
  failureKind?: 'network' | 'authentication' | 'unsupported' | 'request';
  endpoint: string;
  httpStatus?: number;
  latencyMs?: number;
  checkedAt: string;
  error?: string;
}

export interface ModelCacheEntry {
  tool: ToolId;
  baseUrl: string;
  keyFingerprint: string;
  fetchedAt: string;
  ttlMs: number;
  models: ModelInfo[];
  error?: string;
}

export interface PublicConfigFile {
  version: 1;
  currentProviderIds?: Partial<Record<ToolId, string>>;
  providers: ProviderProfile[];
}

export interface ResolvedProvider {
  claude?: {
    providerId: string;
    providerName: string;
    baseUrl: string;
    key: string;
    model?: string;
    configText: string;
  };
  codex?: {
    providerId: string;
    providerName: string;
    baseUrl: string;
    key: string;
    model?: string;
    codexProviderId: string;
    wireApi: 'responses' | 'chat';
    configText: string;
  };
  missingSecrets: ToolId[];
  degraded: string[];
}

export type StatusKind = 'off' | 'ready' | 'missingKey' | 'modelsStale' | 'degraded';

export interface StatusState {
  kind: StatusKind;
  detail?: string;
}

export type ApiStatusKind = 'off' | 'unactivated' | 'ready' | 'missingKey' | 'modelsStale' | 'degraded' | 'networkError';

export interface ApiStatusRow {
  tool: ToolId;
  providerName?: string;
  model?: string;
  status: ApiStatusKind;
}

export interface ToolRuntimeState {
  tool: ToolId;
  providerName?: string;
  baseUrl?: string;
  model?: string;
  matchedProviderId?: string;
  status?: ApiStatusKind;
  configPath: string;
}
