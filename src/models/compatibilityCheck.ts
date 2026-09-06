import { CompatibilityResult, ToolId } from '../types';
import { buildAuthHeaderCandidates, buildCompatibilityUrl } from './modelFetcher';

export async function verifyModel(
  tool: ToolId,
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<CompatibilityResult> {
  const endpoint = buildCompatibilityUrl(tool, baseUrl);
  const checkedAt = new Date().toISOString();
  const body = JSON.stringify(tool === 'claude'
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] }
    : { model, max_output_tokens: 1, input: 'Reply OK.' });

  for (const authHeaders of buildAuthHeaderCandidates(tool, apiKey)) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 20_000);
    const startedAt = performance.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body,
        signal: controller.signal
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const text = await response.text();
      if (response.ok) {
        return { ok: true, endpoint: response.url || endpoint, httpStatus: response.status, latencyMs, checkedAt };
      }
      if ((response.status === 401 || response.status === 403) && tool === 'claude' && authHeaders.Authorization) {
        continue;
      }
      return {
        ok: false,
        endpoint: response.url || endpoint,
        httpStatus: response.status,
        latencyMs,
        checkedAt,
        failureKind: classifyHttpFailure(response.status),
        error: readErrorMessage(text, response.status)
      };
    } catch (error) {
      if (signal?.aborted) return { ok: false, cancelled: true, endpoint, checkedAt, error: 'Cancelled' };
      return {
        ok: false,
        endpoint,
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt,
        failureKind: 'network',
        error: error instanceof Error && error.name === 'AbortError'
          ? 'Request timed out'
          : error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  return { ok: false, endpoint, checkedAt, failureKind: 'authentication', error: 'Authentication failed' };
}

function classifyHttpFailure(status: number): NonNullable<CompatibilityResult['failureKind']> {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404 || status === 405 || status === 501) return 'unsupported';
  return 'request';
}

function readErrorMessage(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    return typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `HTTP ${status}`;
  } catch {
    return `HTTP ${status}`;
  }
}
