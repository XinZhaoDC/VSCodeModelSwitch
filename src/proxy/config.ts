import { ProxyConfig, ProxyOptions, ToolId } from '../types';

export function proxyDefaults(preset: ProxyConfig['preset'], apiFormat: ProxyConfig['apiFormat'] = 'anthropic'): ProxyOptions {
  const jdw = preset === 'justdowork';
  const responses = apiFormat === 'responses';
  return {
    messagesPath: responses ? '/v1/responses' : '/v1/messages', authMode: responses ? 'bearer' : jdw ? 'both' : 'x-api-key', authHeader: 'x-api-key',
    headers: {}, parameters: {}, rebuildStream: true, toolInjection: jdw && !responses,
    repairToolJson: true, nativeToolMap: jdw && !responses ? { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash' } : {},
    toolDescriptionChars: 220, maxHistoryChars: 220000, maxToolResultChars: 32000,
    maxOutputTokens: 16000, timeoutMs: 300000, keepAliveMs: 3000, maxAttempts: jdw ? 3 : 1,
    extraThinkingBudget: 0, maxThinkingBudget: responses ? 0 : 8000, cacheSystemPrefix: jdw,
    webTools: jdw, webSearchResults: 6, webFetchMaxChars: 20000, maxWebIterations: 3
  };
}

export function resolveProxyOptions(config?: ProxyConfig): ProxyOptions {
  const defaults = proxyDefaults(config?.preset ?? 'justdowork', config?.apiFormat);
  return { ...defaults, ...config?.overrides };
}

/** Overrides are portable provider metadata; authentication stays in SecretStorage. */
export function normalizeProxyConfig(value: unknown, tool: ToolId): ProxyConfig {
  if (!value || typeof value !== 'object') return { mode: 'direct', preset: 'justdowork', ...(tool === 'codex' ? { apiFormat: 'responses' as const } : {}) };
  const input = value as ProxyConfig;
  if (input.mode !== 'direct' && input.mode !== 'proxy') throw new Error('Invalid proxy connection mode');
  if (input.preset !== 'justdowork' && input.preset !== 'custom') throw new Error('Invalid proxy preset');
  const apiFormat = input.apiFormat ?? (tool === 'codex' ? 'responses' : 'anthropic');
  if (!['anthropic', 'responses'].includes(apiFormat)) throw new Error('Invalid upstream API format');
  if (tool === 'claude' && apiFormat !== 'anthropic') throw new Error('Claude Code requires an Anthropic upstream');
  if (input.overrides && (typeof input.overrides !== 'object' || Array.isArray(input.overrides))) throw new Error('Proxy overrides must be a JSON object');
  const defaults = proxyDefaults(input.preset, apiFormat);
  const overrides: Partial<ProxyOptions> = {};
  for (const [key, value] of Object.entries(input.overrides ?? {})) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown proxy setting: ${key}`);
    if (JSON.stringify(value) !== JSON.stringify(defaults[key as keyof ProxyOptions])) {
      Object.assign(overrides, { [key]: value });
    }
  }
  const options = resolveProxyOptions({ ...input, apiFormat, overrides });
  if (typeof options.messagesPath !== 'string' || !/^\/(?!\/)[^?#]*$/.test(options.messagesPath)) throw new Error('Messages path must be an absolute API path');
  if (!['bearer', 'x-api-key', 'both', 'custom'].includes(options.authMode)) throw new Error('Invalid proxy authentication mode');
  if (!/^[\w-]+$/.test(options.authHeader)) throw new Error('Invalid authentication header name');
  for (const key of ['rebuildStream', 'toolInjection', 'repairToolJson', 'cacheSystemPrefix', 'webTools'] as const) {
    if (typeof options[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  for (const key of ['toolDescriptionChars', 'maxHistoryChars', 'maxToolResultChars', 'maxOutputTokens', 'extraThinkingBudget', 'maxThinkingBudget', 'webFetchMaxChars'] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 0) throw new Error(`${key} must be a nonnegative integer (0 disables the limit)`);
  }
  for (const [key, min, max] of [['timeoutMs', 1000, 900000], ['keepAliveMs', 100, 60000], ['maxAttempts', 1, 5], ['webSearchResults', 1, 10], ['maxWebIterations', 1, 5]] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`${key} must be between ${min} and ${max}`);
  }
  for (const key of ['headers', 'nativeToolMap', 'parameters'] as const) {
    if (!options[key] || typeof options[key] !== 'object' || Array.isArray(options[key])) throw new Error(`${key} must be a JSON object`);
  }
  for (const [name, value] of Object.entries(options.headers)) {
    if (!/^[\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid additional request header');
    if (/authorization|api.?key|cookie|token|secret/i.test(name)) throw new Error('Configure authentication with Auth mode/Header; do not put credentials in additional headers');
  }
  const targets = new Set<string>();
  for (const [name, mapped] of Object.entries(options.nativeToolMap)) {
    if (!name || typeof mapped !== 'string' || !mapped || targets.has(mapped)) throw new Error('Tool map values must be unique nonempty names');
    targets.add(mapped);
  }
  for (const name of Object.keys(options.parameters)) {
    if (['messages', 'tools', 'system', 'stream', 'model', 'input', 'instructions', 'previous_response_id'].includes(name)) throw new Error(`Proxy owns ${name}; do not override it with additional parameters`);
  }
  rejectCredentialFields(options.parameters);
  if (!options.rebuildStream && (options.toolInjection || options.webTools || Object.keys(options.nativeToolMap).length)) throw new Error('Tool mapping, text tool protocol and web tools require stream rebuilding');
  if (tool === 'codex' && apiFormat === 'anthropic' && !options.rebuildStream) throw new Error('Codex to Anthropic translation requires stream rebuilding');
  if (apiFormat === 'responses' && (options.extraThinkingBudget || options.maxThinkingBudget)) throw new Error('Responses uses reasoning.effort in additional parameters; numeric thinking budgets require an Anthropic upstream');
  return { mode: input.mode, preset: input.preset, ...(input.apiFormat || tool === 'codex' ? { apiFormat } : {}), overrides };
}

export function proxyAuthHeaders(key: string, config: ProxyConfig, tool: ToolId = 'claude'): Record<string, string> {
  config = { ...config, apiFormat: config.apiFormat ?? (tool === 'codex' ? 'responses' : 'anthropic') };
  const options = resolveProxyOptions(config);
  const headers: Record<string, string> = { ...(config.apiFormat !== 'responses' ? { 'anthropic-version': '2023-06-01' } : {}),
    'user-agent': config.preset === 'justdowork' ? 'python-requests/2.32.4' : 'VSCodeModelSwitch/0.2.0', ...options.headers };
  if (['bearer', 'both'].includes(options.authMode)) headers.Authorization = `Bearer ${key}`;
  if (['x-api-key', 'both'].includes(options.authMode)) headers['x-api-key'] = key;
  if (options.authMode === 'custom') headers[options.authHeader] = key;
  return headers;
}

function rejectCredentialFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    if (/^(api.?key|authorization|password|secret|access.?token|auth.?token|cookie)$/i.test(name)) throw new Error('Credentials cannot be stored in proxy parameters');
    rejectCredentialFields(child);
  }
}
