import type { Agent, ProxyAgent } from 'undici';

export interface NetworkProxyConfig {
  url: string;
  noProxy: string;
  claude: boolean;
  codex: boolean;
}

export interface NetworkProxyTest {
  checkedAt: string;
  proxyUrl: string;
  results: Array<{ target: string; reachable: boolean; status?: number; error?: string }>;
}

export const DEFAULT_PROXY: NetworkProxyConfig = {
  url: 'http://127.0.0.1:12000', noProxy: 'localhost,127.0.0.1,::1', claude: true, codex: true
};

let active: NetworkProxyConfig | undefined;
let proxyAgent: ProxyAgent | undefined;
let directAgent: Agent | undefined;

export function normalizeNetworkProxy(value: NetworkProxyConfig): NetworkProxyConfig {
  let url: URL;
  try { url = new URL(value.url.trim()); } catch { throw new Error('Enter an HTTP proxy URL, such as http://127.0.0.1:12000'); }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTP proxy URL without credentials, path, query or fragment');
  }
  if (typeof value.claude !== 'boolean' || typeof value.codex !== 'boolean' || !value.claude && !value.codex) {
    throw new Error('Select Claude Code, Codex, or both');
  }
  const extra = String(value.noProxy ?? '').split(/[\s,]+/).filter(Boolean);
  if (extra.some(host => /[\/@?#]/.test(host))) throw new Error('Bypass entries must be host names or IP addresses, not URLs or CIDR ranges');
  return { url: url.origin, noProxy: [...new Set([...DEFAULT_PROXY.noProxy.split(','), ...extra])].join(','), claude: value.claude, codex: value.codex };
}

export function bypassNetworkProxy(input: string | URL, config: NetworkProxyConfig): boolean {
  const url = new URL(input), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)) return true;
  return config.noProxy.split(',').some(entry => {
    const name = entry.trim().toLowerCase();
    if (name === '*') return true;
    if (name.startsWith('*.') || name.startsWith('.')) {
      const suffix = name.replace(/^\*?\./, '');
      return host === suffix || host.endsWith('.' + suffix);
    }
    return name === host || name === url.host.toLowerCase();
  });
}

export function isNetworkProxied(url: string | URL): boolean {
  return Boolean(active && !bypassNetworkProxy(url, active));
}

/** Only future requests change route. In-flight streams drain on their original agent. */
export function setNetworkProxy(config?: NetworkProxyConfig): void {
  if (active?.url !== config?.url && proxyAgent) {
    const previous = proxyAgent;
    proxyAgent = undefined;
    void previous.close().catch(() => {});
  }
  active = config ? { ...config } : undefined;
}

/** Preserve VS Code's previous transport when off; explicitly bypass its proxy for localhost when on. */
export async function networkFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (!active) return fetch(url, init);
  let target = new URL(url), options = { ...init };
  const follow = !init?.redirect || init.redirect === 'follow';
  for (let redirects = 0; ; redirects++) {
    const response = await dispatchFetch(target, follow ? { ...options, redirect: 'manual' } : options);
    const location = response.headers.get('location');
    if (!follow || !location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects >= 20) throw new Error('Network proxy request exceeded the redirect limit');
    const next = new URL(location, target), headers = new Headers(options.headers);
    if (next.origin !== target.origin) {
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) headers.delete(name);
    }
    const method = (options.method ?? 'GET').toUpperCase();
    if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') {
      options = { ...options, method: 'GET', body: undefined };
      headers.delete('content-length'); headers.delete('content-type');
    }
    options.headers = headers;
    target = next;
  }
}

async function dispatchFetch(url: URL, init: RequestInit): Promise<Response> {
  if (!active) return fetch(url, init);
  const undici: typeof import('undici') = require('undici');
  const config = active;
  if (!directAgent) directAgent = new undici.Agent({ connect: { rejectUnauthorized: true } });
  if (!bypassNetworkProxy(url, config) && !proxyAgent) {
    proxyAgent = new undici.ProxyAgent({ uri: config.url, requestTls: { rejectUnauthorized: true } });
  }
  const dispatcher = bypassNetworkProxy(url, config) ? directAgent : proxyAgent!;
  // Both fetch implementations expose standard streaming Response objects.
  return undici.fetch(url, { ...init, dispatcher } as Parameters<typeof undici.fetch>[1]) as unknown as Promise<Response>;
}

export function proxyEnvironment(config?: NetworkProxyConfig): Record<string, string> {
  if (!config) return {};
  return { HTTP_PROXY: config.url, HTTPS_PROXY: config.url, http_proxy: config.url, https_proxy: config.url,
    NO_PROXY: config.noProxy, no_proxy: config.noProxy };
}

/** No account tokens or model calls: an HTTP response proves transport reachability only. */
export async function testNetworkProxy(input: NetworkProxyConfig): Promise<NetworkProxyTest> {
  const config = normalizeNetworkProxy(input);
  const { ProxyAgent, fetch: probeFetch }: typeof import('undici') = require('undici');
  const agent = new ProxyAgent({ uri: config.url, requestTls: { rejectUnauthorized: true } });
  try {
    const targets = [ ...(config.claude ? ['https://api.anthropic.com/'] : []), ...(config.codex ? ['https://chatgpt.com/'] : []) ];
    const results = await Promise.all(targets.map(async target => {
      try {
        const response = await probeFetch(target, { dispatcher: agent, signal: AbortSignal.timeout(8000), redirect: 'manual' });
        await response.body?.cancel();
        return { target, reachable: true, status: response.status };
      } catch { return { target, reachable: false, error: 'Proxy connection, TLS handshake or request timed out/failed' }; }
    }));
    return { checkedAt: new Date().toISOString(), proxyUrl: config.url, results };
  } finally { await agent.destroy(); }
}

export function disposeNetworkTransport(): void {
  active = undefined;
  void proxyAgent?.destroy(); void directAgent?.destroy();
  proxyAgent = undefined; directAgent = undefined;
}
