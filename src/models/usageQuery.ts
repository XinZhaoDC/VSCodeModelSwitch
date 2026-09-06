import { UsageQueryConfig, UsageQueryResult } from '../types';

export function defaultUsageQuery(baseUrl: string): UsageQueryConfig {
  return {
    enabled: false,
    preset: 'auto',
    url: '',
    remainingPath: '',
    usedPath: '',
    totalPath: '',
    unit: 'USD'
  };
}

export function usagePreset(
  preset: NonNullable<UsageQueryConfig['preset']>,
  baseUrl: string,
  current?: UsageQueryConfig
): UsageQueryConfig {
  const root = baseUrl.replace(/\/+$/g, '');
  const enabled = current?.enabled ?? false;
  switch (preset) {
    case 'auto':
      return { enabled, preset, url: '', remainingPath: '', usedPath: '', totalPath: '', unit: 'USD' };
    case 'deepseek':
      return { enabled, preset, url: `${root}/user/balance`, remainingPath: 'balance_infos.0.total_balance', usedPath: '', totalPath: '', unit: 'USD' };
    case 'siliconflow':
      return { enabled, preset, url: `${root}/user/info`, remainingPath: 'data.balance', usedPath: '', totalPath: 'data.totalBalance', unit: 'CNY' };
    case 'openrouter':
      return { enabled, preset, url: `${root}/key`, remainingPath: 'data.limit_remaining', usedPath: 'data.usage', totalPath: 'data.limit', unit: 'USD' };
    case 'newapi':
      return { enabled, preset, url: `${root.replace(/\/v1$/i, '')}/api/user/self`, remainingPath: 'data.quota', usedPath: 'data.used_quota', totalPath: '', unit: 'USD', divisor: 500000, userId: current?.userId ?? '' };
    case 'custom':
      return { ...(current ?? defaultUsageQuery(baseUrl)), enabled, preset };
    case 'generic':
    default:
      return { enabled, preset: 'generic', url: `${root}/user/balance`, remainingPath: 'balance', usedPath: '', totalPath: '', unit: 'USD' };
  }
}

export async function queryUsage(
  config: UsageQueryConfig,
  baseUrl: string,
  apiKey: string,
  usageAccessToken?: string,
  signal?: AbortSignal
): Promise<UsageQueryResult> {
  const checkedAt = new Date().toISOString();
  if (config.preset === 'auto') {
    return queryUsageAutomatically(baseUrl, apiKey, usageAccessToken, config.userId, checkedAt, signal);
  }
  const endpoint = resolveTemplate(config.url, baseUrl, config.preset);
  if (!endpoint) return { ok: false, checkedAt, error: 'Usage URL is required' };

  if (config.preset === 'newapi' && (!usageAccessToken || !config.userId?.trim())) {
    return { ok: false, endpoint, checkedAt, error: 'New API requires Access Token and User ID' };
  }
  const headers = buildUsageHeaders(
    config.preset === 'newapi' ? usageAccessToken ?? '' : apiKey,
    config.preset === 'newapi' ? config.userId : undefined
  );
  return queryUsageEndpoint(
    endpoint,
    headers,
    [{
      label: config.preset ?? 'custom',
      remainingPath: config.remainingPath,
      usedPath: config.usedPath,
      totalPath: config.totalPath,
      unit: config.unit,
      divisor: config.divisor
    }],
    checkedAt,
    signal,
    10_000
  );
}

interface UsageShape {
  label: string;
  remainingPath: string;
  usedPath?: string;
  totalPath?: string;
  unit: string;
  divisor?: number;
}

interface UsageCandidate {
  endpoint: string;
  label: string;
  auth?: 'provider' | 'management' | 'newapi';
}

async function queryUsageAutomatically(
  baseUrl: string,
  apiKey: string,
  usageAccessToken: string | undefined,
  userId: string | undefined,
  checkedAt: string,
  signal?: AbortSignal
): Promise<UsageQueryResult> {
  const attempts: NonNullable<UsageQueryResult['attempts']> = [];
  const deadline = Date.now() + 20_000;
  const candidates = buildAutomaticCandidates(baseUrl);
  if (usageAccessToken) {
    candidates.sort((left, right) => Number(right.auth !== undefined && right.auth !== 'provider') - Number(left.auth !== undefined && left.auth !== 'provider'));
  }
  for (const candidate of candidates) {
    if (signal?.aborted) return { ok: false, checkedAt, attempts, error: 'Cancelled' };
    if (Date.now() >= deadline) break;
    if (candidate.auth === 'management' && !usageAccessToken) {
      attempts.push({ endpoint: candidate.endpoint, error: 'Management Access Token required' });
      continue;
    }
    if (candidate.auth === 'newapi' && (!usageAccessToken || !userId?.trim())) {
      attempts.push({ endpoint: candidate.endpoint, error: 'Management Access Token and User ID required' });
      continue;
    }
    const headers = candidate.auth === 'management'
      ? buildUsageHeaders(usageAccessToken ?? '')
      : candidate.auth === 'newapi'
        ? buildUsageHeaders(usageAccessToken ?? '', userId)
        : buildUsageHeaders(apiKey);
    const result = await queryUsageEndpoint(
      candidate.endpoint,
      headers,
      automaticShapes(),
      checkedAt,
      signal,
      Math.min(4_000, Math.max(1, deadline - Date.now()))
    );
    attempts.push({
      endpoint: candidate.endpoint,
      httpStatus: result.httpStatus,
      responseShape: result.responseShape,
      error: result.ok ? undefined : result.error
    });
    if (result.ok) return { ...result, strategy: `${candidate.label} / ${result.strategy}`, attempts };
    if (result.error === 'Cancelled') return { ...result, attempts };
  }
  return {
    ok: false,
    checkedAt,
    attempts,
    error: `No supported usage endpoint found after ${attempts.length} attempts`
  };
}

async function queryUsageEndpoint(
  endpoint: string,
  headers: Record<string, string>,
  shapes: UsageShape[],
  checkedAt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<UsageQueryResult> {

  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, endpoint, httpStatus: response.status, checkedAt, error: `HTTP ${response.status}` };
    }
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      const contentType = response.headers.get('content-type') ?? '';
      const looksLikeHtml = contentType.includes('text/html') || /^\s*<!doctype|^\s*<html/i.test(text);
      return {
        ok: false,
        endpoint: response.url || endpoint,
        httpStatus: response.status,
        checkedAt,
        error: looksLikeHtml ? 'Usage endpoint returned HTML instead of JSON' : 'Usage endpoint returned invalid JSON'
      };
    }
    for (const shape of shapes) {
      const divisor = shape.divisor && shape.divisor > 0 ? shape.divisor : 1;
      const used = divide(readNumber(data, shape.usedPath), divisor);
      const total = divide(readNumber(data, shape.totalPath), divisor);
      const directRemaining = divide(readNumber(data, shape.remainingPath), divisor);
      const remaining = directRemaining ?? (used !== undefined && total !== undefined ? total - used : undefined);
      if (remaining === undefined) continue;
      return {
        ok: true,
        endpoint: response.url || endpoint,
        httpStatus: response.status,
        remaining,
        used,
        total,
        unit: shape.unit,
        strategy: shape.label,
        checkedAt
      };
    }
    const responseShape = describeJsonShape(data);
    return {
      ok: false,
      endpoint: response.url || endpoint,
      httpStatus: response.status,
      responseShape,
      checkedAt,
      error: `JSON response did not match ${shapes.length} known usage schema${shapes.length === 1 ? '' : 's'} (${responseShape})`
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      checkedAt,
      error: signal?.aborted
        ? 'Cancelled'
        : error instanceof Error && error.name === 'AbortError'
          ? 'Request timed out'
          : error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function buildUsageHeaders(token: string, newApiUserId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'VSCodeModelSwitch/0.1'
  };
  if (newApiUserId?.trim()) headers['New-Api-User'] = newApiUserId.trim();
  return headers;
}

function buildAutomaticCandidates(baseUrl: string): UsageCandidate[] {
  const exact = baseUrl.trim().replace(/\/+$/g, '');
  const root = exact.replace(/\/v1$/i, '');
  let origin = root;
  try {
    origin = new URL(exact).origin;
  } catch {
    // Validation elsewhere reports malformed Provider URLs.
  }
  const candidates: UsageCandidate[] = [
    { endpoint: appendPath(exact, 'user/balance'), label: 'Generic balance' },
    { endpoint: appendPath(root, 'user/balance'), label: 'Generic balance (root)' },
    { endpoint: appendPath(exact, 'user/info'), label: 'User info' },
    { endpoint: appendPath(root, 'v1/user/info'), label: 'User info (v1)' },
    { endpoint: appendPath(exact, 'key'), label: 'API key status' },
    { endpoint: appendPath(exact, 'credits'), label: 'Credits' },
    { endpoint: appendPath(exact, 'credits'), label: 'Credits (management)', auth: 'management' },
    { endpoint: appendPath(origin, 'api/v1/key'), label: 'OpenRouter key status' },
    { endpoint: appendPath(origin, 'api/v1/credits'), label: 'OpenRouter credits' },
    { endpoint: appendPath(origin, 'api/v1/credits'), label: 'OpenRouter credits (management)', auth: 'management' },
    { endpoint: appendPath(root, 'dashboard/billing/credit_grants'), label: 'Credit grants' },
    { endpoint: appendPath(root, 'v1/dashboard/billing/credit_grants'), label: 'Credit grants (v1)' },
    { endpoint: appendPath(root, 'v1/accounts'), label: 'StepFun account' },
    { endpoint: appendPath(root, 'v1/users/me/balance'), label: 'Kimi balance' },
    { endpoint: appendPath(root, 'openapi/v1/billing/balance/detail'), label: 'Novita balance' },
    { endpoint: appendPath(root, 'usage/current_balance'), label: 'Current point balance' },
    { endpoint: appendPath(root, 'api/biz/account/query-customer-account-report'), label: 'Account report' },
    { endpoint: appendPath(root, 'account/query_balance'), label: 'Account balance' },
    { endpoint: appendPath(root, 'api/user/self'), label: 'New API user', auth: 'newapi' },
    { endpoint: appendPath(root, 'api/data/self'), label: 'New API usage', auth: 'newapi' }
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const identity = `${candidate.auth ?? 'provider'}:${candidate.endpoint}`;
    if (!candidate.endpoint || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function automaticShapes(): UsageShape[] {
  return [
    { label: 'Generic balance', remainingPath: 'balance', usedPath: 'used_quota', totalPath: 'total_quota', unit: 'USD' },
    { label: 'DeepSeek', remainingPath: 'balance_infos.0.total_balance', unit: 'USD' },
    { label: 'SiliconFlow total balance', remainingPath: 'data.totalBalance', unit: 'CNY' },
    { label: 'SiliconFlow balance', remainingPath: 'data.balance', totalPath: 'data.totalBalance', unit: 'CNY' },
    { label: 'Kimi', remainingPath: 'data.available_balance', unit: 'CNY' },
    { label: 'OpenRouter', remainingPath: 'data.limit_remaining', usedPath: 'data.usage', totalPath: 'data.limit', unit: 'USD' },
    { label: 'OpenRouter credits', remainingPath: '', usedPath: 'data.total_usage', totalPath: 'data.total_credits', unit: 'USD' },
    { label: 'OpenAI credit grants', remainingPath: 'total_available', usedPath: 'total_used', totalPath: 'total_granted', unit: 'USD' },
    { label: 'Nested credit grants', remainingPath: 'data.total_available', usedPath: 'data.total_used', totalPath: 'data.total_granted', unit: 'USD' },
    { label: 'New API', remainingPath: 'data.quota', usedPath: 'data.used_quota', unit: 'USD', divisor: 500000 },
    { label: 'Novita', remainingPath: 'availableBalance', unit: 'USD', divisor: 10000 },
    { label: 'Available amount', remainingPath: 'available_amount', unit: 'CNY' },
    { label: 'Available balance', remainingPath: 'availableBalance', unit: 'CNY' },
    { label: 'Point balance', remainingPath: 'current_point_balance', unit: 'points' },
    { label: 'Remaining balance', remainingPath: 'remaining_balance', unit: 'USD' },
    { label: 'Nested remaining', remainingPath: 'data.remaining', unit: 'USD' }
  ];
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/g, '')}/${path.replace(/^\/+/, '')}`;
}

function describeJsonShape(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (!value || typeof value !== 'object') return typeof value;
  const object = value as Record<string, unknown>;
  const topLevel = Object.keys(object).slice(0, 12);
  const nested = topLevel.flatMap((key) => {
    const child = object[key];
    if (!child || typeof child !== 'object' || Array.isArray(child)) return [];
    return Object.keys(child as Record<string, unknown>).slice(0, 12).map((childKey) => `${key}.${childKey}`);
  });
  return `keys: ${[...topLevel, ...nested].join(', ') || '(none)'}`;
}

function divide(value: number | undefined, divisor: number): number | undefined {
  return value === undefined ? undefined : value / divisor;
}

function resolveTemplate(value: string, baseUrl: string, preset?: UsageQueryConfig['preset']): string {
  let root = baseUrl.replace(/\/+$/g, '');
  if (preset === 'deepseek' || preset === 'newapi') root = root.replace(/\/v1$/i, '');
  return value.trim().replace('{{baseUrl}}', root);
}

function readNumber(value: unknown, path: string | undefined): number | undefined {
  if (!path?.trim()) return undefined;
  let current: unknown = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'number' && Number.isFinite(current)) return current;
  if (typeof current === 'string' && current.trim() && Number.isFinite(Number(current))) return Number(current);
  return undefined;
}
