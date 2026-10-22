import { ProxyEndpoint } from './server';
import { ToolId } from '../types';
import { setSectionValue } from '../config/tomlEdit';

/** Provider templates describe the upstream. Only this disposable copy targets localhost. */
export function proxyClientConfig(upstreamText: string, endpoint: ProxyEndpoint, tool: ToolId = 'claude'): string {
  if (tool === 'codex') {
    const local = setSectionValue(upstreamText, 'model_providers.OpenAI', 'base_url', endpoint.baseUrl);
    return setSectionValue(local, 'model_providers.OpenAI', 'experimental_bearer_token', endpoint.key);
  }
  const config = JSON.parse(upstreamText);
  config.env = { ...config.env, ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_AUTH_TOKEN: endpoint.key, ANTHROPIC_API_KEY: endpoint.key, ENABLE_TOOL_SEARCH: 'false' };
  return JSON.stringify(config, null, 2) + '\n';
}

export function managedProxyId(baseUrl: string | undefined, key: string | undefined): string | undefined {
  if (!baseUrl || key !== 'vscodemodelswitch-local') return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return undefined;
    const match = /^\/providers\/([^/]+)(?:\/v1)?\/?$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch { return undefined; }
}
