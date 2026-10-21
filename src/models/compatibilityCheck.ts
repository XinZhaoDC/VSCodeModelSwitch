import { CompatibilityResult, ProxyConfig, ToolId } from '../types';
import { buildAuthHeaderCandidates, buildCompatibilityUrl } from './modelFetcher';
import { resolveProxyOptions } from '../proxy/config';

export async function verifyModel(
  tool: ToolId,
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  proxy?: ProxyConfig
): Promise<CompatibilityResult> {
  const endpoint = buildCompatibilityUrl(tool, baseUrl);
  const checkedAt = new Date().toISOString();
  const bodies = tool === 'claude' ? [
    // Do not force `thinking: disabled`: newer Claude-compatible gateways can
    // require adaptive thinking for some models (for example claude-opus-5-5).
    // Omitting the field lets the provider select its supported default.
    { model, max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'Reply with exactly OK and no other text.' }] },
    { model, max_tokens: 256, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'Reply with exactly OK and no other text.' }] }
  ] : [{ model, max_output_tokens: 1, input: 'Reply OK.' }];

  for (const authHeaders of buildAuthHeaderCandidates(tool, apiKey)) {
    for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
      const body = JSON.stringify(bodies[bodyIndex]);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), proxy ? resolveProxyOptions(proxy).timeoutMs + 1000 : 20_000);
    const startedAt = performance.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body,
        signal: controller.signal
      });
      if (response.ok && tool === 'claude') {
        const outcome = await readVerifiedStream(response);
        if (outcome.ok) return { ok: true, endpoint, httpStatus: response.status, latencyMs: Math.round(performance.now() - startedAt), checkedAt };
        if (bodyIndex + 1 < bodies.length) continue;
        return { ok: false, endpoint, httpStatus: response.status, latencyMs: Math.round(performance.now() - startedAt), checkedAt, failureKind: 'request', error: (outcome.error ?? 'Invalid model stream').split(apiKey).join('[redacted]') };
      }
      const text = await response.text();
      const latencyMs = Math.round(performance.now() - startedAt);
      if (response.ok) {
        return { ok: true, endpoint: response.url || endpoint, httpStatus: response.status, latencyMs, checkedAt };
      }
      if ((response.status === 401 || response.status === 403) && tool === 'claude' && authHeaders.Authorization) {
        continue;
      }
      if (bodyIndex + 1 < bodies.length && (response.status === 400 || response.status === 422 || response.status >= 500)) continue;
      return {
        ok: false,
        endpoint: response.url || endpoint,
        httpStatus: response.status,
        latencyMs,
        checkedAt,
        failureKind: classifyHttpFailure(response.status),
        error: readErrorMessage(text, response.status).split(apiKey).join('[redacted]')
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
  }

  return { ok: false, endpoint, checkedAt, failureKind: 'authentication', error: 'Authentication failed' };
}

/** A successful HTTP handshake is not a successful model response. */
async function readVerifiedStream(response: Response): Promise<{ ok: boolean; error?: string }> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return { ok: false, error: 'Expected an Anthropic SSE response' };
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', text = '', stopped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let index: number;
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, index); pending = pending.slice(index + 2);
        const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!raw) continue;
        let data: any;
        try { data = JSON.parse(raw); } catch { return { ok: false, error: 'Invalid SSE JSON' }; }
        if (data.type === 'error') return { ok: false, error: data.error?.message ?? 'Model returned an SSE error' };
        if (data.content_block?.type === 'text') text += data.content_block.text ?? '';
        if (data.delta?.type === 'text_delta') text += data.delta.text ?? '';
        if (data.type === 'message_stop') stopped = true;
      }
    }
    return stopped && text.trim() === 'OK' ? { ok: true } : { ok: false, error: !stopped ? 'Model stream ended without message_stop' : 'Model returned no valid OK answer (thinking alone does not pass)' };
  } finally { await reader.cancel().catch(() => {}); }
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
