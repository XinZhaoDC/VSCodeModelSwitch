import { promises as dns } from 'dns';
import * as vscode from 'vscode';
import { ModelInfo, NetworkTestResult, ToolId } from '../types';

type ModelsResponse = {
  data?: Array<{
    id?: unknown;
    display_name?: unknown;
    object?: unknown;
  }>;
};

export class ModelFetchError extends Error {
  constructor(message: string, readonly causeText?: string) {
    super(message);
  }
}

export async function fetchModels(tool: ToolId, baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const candidates = buildModelUrls(baseUrl);
  const errors: string[] = [];
  const dnsResult = await resolveEndpointDns(baseUrl);
  if (dnsResult.dnsError) errors.push(`DNS: ${dnsResult.dnsError}`);
  if (dnsResult.resolvedAddresses?.length) {
    const mode = dnsResult.dnsMode === 'vpnFakeIp' ? ' (VPN Fake-IP)' : dnsResult.dnsMode === 'loopback' ? ' (container loopback)' : '';
    errors.push(`DNS: ${dnsResult.resolvedAddresses.join(', ')}${mode}`);
  }
  if (dnsResult.dnsMode === 'loopback') {
    throw new ModelFetchError('Unable to fetch model list', errors.join('; '));
  }

  for (const url of candidates) {
    if (signal?.aborted) throw new ModelFetchError('Model fetch cancelled', errors.join('; '));
    for (const headers of buildAuthHeaderCandidates(tool, apiKey)) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!response.ok) {
          errors.push(`${url}: HTTP ${response.status}`);
          if (!isAuthenticationStatus(response.status)) break;
          continue;
        }

        const json = (await response.json()) as ModelsResponse;
        const models = normalizeModels(tool, json);
        if (models.length > 0) return sortModels(tool, models);
        errors.push(`${url}: empty model list`);
        break;
      } catch (error) {
        if (signal?.aborted) throw new ModelFetchError('Model fetch cancelled', errors.join('; '));
        errors.push(`${url}: ${formatFetchError(error)}`);
        break;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    }
  }

  throw new ModelFetchError('Unable to fetch model list', errors.join('; '));
}

export async function testModelsEndpoint(tool: ToolId, baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<NetworkTestResult> {
  const checkedAt = new Date().toISOString();
  const errors: string[] = [];
  const dnsResult = await resolveEndpointDns(baseUrl);

  if (dnsResult.dnsMode === 'loopback') {
    return {
      ok: false,
      reachable: false,
      modelsApi: 'unreachable',
      failureStage: 'dns',
      checkedAt,
      ...dnsResult,
      error: 'Remote domain resolved to the container loopback address'
    };
  }

  for (const endpoint of buildModelUrls(baseUrl)) {
    for (const headers of buildAuthHeaderCandidates(tool, apiKey)) {
      const attempt = await requestText(endpoint, headers, signal, 6_000);
      if (attempt.cancelled) return cancelledNetworkResult(checkedAt, dnsResult);
      if (!attempt.response) {
        errors.push(`${endpoint}: ${attempt.error}`);
        break;
      }

      const { response, text, latencyMs } = attempt;
      const responseBytes = Number(response.headers.get('content-length')) || Buffer.byteLength(text, 'utf8');
      if (response.ok) {
        let modelCount: number | undefined;
        try {
          modelCount = normalizeModels(tool, JSON.parse(text) as ModelsResponse).length;
        } catch {
          modelCount = undefined;
        }
        return {
          ok: true,
          reachable: true,
          modelsApi: 'available',
          ...dnsResult,
          endpoint,
          httpStatus: response.status,
          latencyMs,
          responseBytes,
          modelCount,
          checkedAt
        };
      }

      errors.push(`${endpoint}: HTTP ${response.status}`);
      if (isAuthenticationStatus(response.status) && tool === 'claude' && headers.Authorization) continue;
      if (response.status !== 404 && response.status !== 405) {
        return {
          ok: true,
          reachable: true,
          modelsApi: 'httpError',
          modelsError: `HTTP ${response.status}`,
          ...dnsResult,
          endpoint,
          httpStatus: response.status,
          latencyMs,
          responseBytes,
          checkedAt
        };
      }
      break;
    }
  }

  const reachabilityEndpoint = buildReachabilityUrl(baseUrl);
  for (const headers of buildAuthHeaderCandidates(tool, apiKey)) {
    const attempt = await requestText(reachabilityEndpoint, headers, signal, 6_000);
    if (attempt.cancelled) return cancelledNetworkResult(checkedAt, dnsResult);
    if (!attempt.response) {
      errors.push(`${reachabilityEndpoint}: ${attempt.error}`);
      break;
    }

    const { response, text, latencyMs } = attempt;
    if (isAuthenticationStatus(response.status) && tool === 'claude' && headers.Authorization) continue;
    return {
      ok: true,
      reachable: true,
      modelsApi: 'unreachable',
      modelsError: errors.join('; '),
      ...dnsResult,
      endpoint: reachabilityEndpoint,
      httpStatus: response.status,
      latencyMs,
      responseBytes: Number(response.headers.get('content-length')) || Buffer.byteLength(text, 'utf8'),
      checkedAt
    };
  }

  return {
    ok: false,
    reachable: false,
    modelsApi: 'unreachable',
    modelsError: errors.join('; '),
    failureStage: dnsResult.dnsError ? 'dns' : 'transport',
    ...dnsResult,
    endpoint: reachabilityEndpoint,
    checkedAt,
    error: errors.join('; ') || 'No reachable endpoint'
  };
}

export function buildCompatibilityUrl(tool: ToolId, baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/g, '');
  const versioned = root.endsWith('/v1') ? root : `${root}/v1`;
  return tool === 'claude' ? `${versioned}/messages` : `${versioned}/responses`;
}

function buildReachabilityUrl(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/`;
  } catch {
    return baseUrl.trim().replace(/\/+$/g, '') || baseUrl;
  }
}

export function buildAuthHeaderCandidates(tool: ToolId, apiKey: string): Record<string, string>[] {
  if (tool === 'claude') {
    const anthropicVersion = vscode.workspace
      .getConfiguration('vscodemodelswitch')
      .get<string>('anthropicVersion', '2023-06-01');
    return [
      { Authorization: `Bearer ${apiKey}`, 'anthropic-version': anthropicVersion },
      { 'x-api-key': apiKey, 'anthropic-version': anthropicVersion }
    ];
  }
  return [{ Authorization: `Bearer ${apiKey}` }];
}

async function requestText(
  endpoint: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ response?: Response; text: string; latencyMs: number; error?: string; cancelled?: boolean }> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(endpoint, { method: 'GET', headers, signal: controller.signal });
    const text = await response.text();
    return { response, text, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      text: '',
      latencyMs: Math.round(performance.now() - startedAt),
      error: formatFetchError(error),
      cancelled: signal?.aborted === true
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

type DnsResult = Pick<NetworkTestResult, 'resolvedAddresses' | 'dnsMode' | 'dnsError'>;

async function resolveEndpointDns(baseUrl: string): Promise<DnsResult> {
  try {
    const url = new URL(baseUrl);
    const addresses = [...new Set((await dns.lookup(url.hostname, { all: true })).map((item) => item.address))];
    const remoteHostname = url.hostname !== 'localhost' && !isIpAddress(url.hostname);
    const loopback = remoteHostname && addresses.length > 0 && addresses.every(isLoopbackAddress);
    const fakeIp = addresses.some(isVpnFakeIp);
    return {
      resolvedAddresses: addresses,
      dnsMode: loopback ? 'loopback' : fakeIp ? 'vpnFakeIp' : 'standard'
    };
  } catch (error) {
    return { dnsError: formatFetchError(error) };
  }
}

function cancelledNetworkResult(
  checkedAt: string,
  dnsResult: DnsResult
): NetworkTestResult {
  return { ok: false, cancelled: true, modelsApi: 'notTested', checkedAt, ...dnsResult, error: 'Cancelled' };
}

function isAuthenticationStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function isLoopbackAddress(value: string): boolean {
  return value === '::1' || value.startsWith('127.');
}

function isVpnFakeIp(value: string): boolean {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  return Number(match[1]) === 198 && (Number(match[2]) === 18 || Number(match[2]) === 19);
}

function isIpAddress(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Request timed out or was cancelled';
  if (error instanceof Error && error.cause instanceof Error) return `${error.message}: ${error.cause.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function buildModelUrls(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/g, '');
  if (!normalized) {
    return [];
  }
  if (normalized.endsWith('/v1')) {
    return [`${normalized}/models`, `${normalized.slice(0, -3)}/models`];
  }
  return [`${normalized}/v1/models`, `${normalized}/models`];
}

function normalizeModels(tool: ToolId, json: ModelsResponse): ModelInfo[] {
  if (!Array.isArray(json.data)) {
    return [];
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const item of json.data) {
    if (typeof item.id !== 'string' || !item.id.trim()) {
      continue;
    }
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    models.push({
      id: item.id,
      displayName: typeof item.display_name === 'string' ? item.display_name : undefined,
      source: tool
    });
  }
  return models;
}

export function sortModels(tool: ToolId, models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const scoreDiff = scoreModel(tool, b.id) - scoreModel(tool, a.id);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return b.id.localeCompare(a.id);
  });
}

function scoreModel(tool: ToolId, model: string): number {
  const id = model.toLowerCase();
  if (tool === 'claude') {
    if (id.includes('sonnet')) {
      return 100;
    }
    if (id.includes('opus')) {
      return 90;
    }
    if (id.includes('haiku')) {
      return 70;
    }
    if (id.includes('claude')) {
      return 60;
    }
    return 10;
  }

  if (id.includes('codex')) {
    return 110;
  }
  if (id.includes('gpt-5')) {
    return 100;
  }
  if (id.includes('gpt-4')) {
    return 80;
  }
  if (id.includes('reason') || id.includes('thinking') || id.includes('r1')) {
    return 70;
  }
  return 10;
}
