import type { Agent, ProxyAgent } from 'undici';
import { AsyncLocalStorage } from 'async_hooks';
import { ToolId } from '../types';

export interface NetworkProxyConfig {
  url: string;
  note?: string;
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

const scope = new AsyncLocalStorage<ToolId>();
const configs: Partial<Record<ToolId, NetworkProxyConfig>> = {};
let active: NetworkProxyConfig | undefined;
const agents = new Map<string, ProxyAgent>();
let directAgent: Agent | undefined;

/** Carry a tool identity across nested model, usage and relay requests. */
export function withNetworkTool<T>(tool: ToolId, action: () => T): T { return scope.run(tool, action); }
function selected(tool?: ToolId): NetworkProxyConfig | undefined {
  const identity = tool ?? scope.getStore();
  return identity ? configs[identity] : active;
}

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
  return { ...(value.note?.trim() ? { note: value.note.trim().slice(0, 200) } : {}), url: url.origin, noProxy: [...new Set([...DEFAULT_PROXY.noProxy.split(','), ...extra])].join(','), claude: value.claude, codex: value.codex };
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

export function isNetworkProxied(url: string | URL, tool?: ToolId): boolean {
  const config = selected(tool);
  return Boolean(config && !bypassNetworkProxy(url, config));
}

/** Existing shared selections migrate to two independent tool settings. */
export function setNetworkProxy(config?: NetworkProxyConfig, tool?: ToolId): void {
  if (tool) { configs[tool] = config; return; }
  active = config;
  configs.claude = config?.claude ? config : undefined;
  configs.codex = config?.codex ? config : undefined;
}

export async function networkFetch(url: string | URL, init?: RequestInit, tool?: ToolId): Promise<Response> {
  const identity = tool ?? scope.getStore(), config = selected(identity);
  // Unscoped legacy callers retain VS Code fetch. Scoped direct requests must
  // bypass its global proxy so another tool cannot change their route.
  if (!config && !identity) return fetch(url, init);
  const undici: typeof import('undici') = require('undici');
  if (!directAgent) directAgent = new undici.Agent({ connect: { rejectUnauthorized: true } });
  if (config && !agents.has(config.url)) agents.set(config.url, new undici.ProxyAgent({ uri: config.url, requestTls: { rejectUnauthorized: true } }));
  let target = new URL(url), options = { ...init };
  const follow = !init?.redirect || init.redirect === 'follow';
  for (let redirects = 0; ; redirects++) {
    const dispatcher = config && !bypassNetworkProxy(target, config) ? agents.get(config.url)! : directAgent;
    const response = await undici.fetch(target, { ...options, ...(follow ? { redirect: 'manual' } : {}), dispatcher } as Parameters<typeof undici.fetch>[1]) as unknown as Response;
    const location = response.headers.get('location');
    if (!follow || !location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects >= 20) throw new Error('Network proxy request exceeded the redirect limit');
    const next = new URL(location, target), headers = new Headers(options.headers);
    if (next.origin !== target.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) headers.delete(name);
    const method = (options.method ?? 'GET').toUpperCase();
    if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') {
      options = { ...options, method: 'GET', body: undefined }; headers.delete('content-length'); headers.delete('content-type');
    }
    options.headers = headers; target = next;
  }
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
  active = undefined; delete configs.claude; delete configs.codex;
  for (const agent of agents.values()) void agent.destroy(); agents.clear();
  void directAgent?.destroy(); directAgent = undefined;
}
