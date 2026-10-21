import { ProxyEndpoint } from './server';

/** Provider templates describe the upstream. Only this disposable copy targets localhost. */
export function proxyClientConfig(upstreamText: string, endpoint: ProxyEndpoint): string {
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
    const match = /^\/providers\/([^/]+)\/?$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch { return undefined; }
}
