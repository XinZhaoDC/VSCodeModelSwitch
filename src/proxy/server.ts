import { randomUUID } from 'crypto';
import * as http from 'http';
import { ProxyConfig, ProxyOptions, ProxyRuntime, ToolId } from '../types';
import { normalizeProxyConfig, proxyAuthHeaders, resolveProxyOptions } from './config';
import { buildPayload, event, Json, messageEvents, processMessage, WEB_NAMES } from './protocol';
import { requestHttp, upstreamUrl } from './transport';
import { executeWebTool } from './webTools';
import { anthropicToResponse, buildResponsesPayload, decodeResponsesBody, processResponse, responseEvents, responsesToAnthropic } from './responses';

interface Route { id: string; tool: ToolId; baseUrl: string; key: string; model?: string; config: ProxyConfig; options: ProxyOptions; stopped: boolean }
export interface ProxyEndpoint { baseUrl: string; key: string; rollback?: () => void }
class UpstreamError extends Error { constructor(message: string, readonly status = 502, readonly retryable = false) { super(message); } }

/** One loopback server per extension host, with immutable per-request provider snapshots. */
export class ProxyServer {
  private server?: http.Server;
  private port?: number;
  private starting?: Promise<void>;
  private readonly routes = new Map<string, Route>();
  private readonly stats = new Map<string, ProxyRuntime>();
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly localKey = 'vscodemodelswitch-local';

  constructor(private readonly changed: (id: string) => void = () => {}, private readonly log: (message: string) => void = () => {}) {}

  async start(port = 0): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => { void this.handle(req, res); });
      server.once('error', error => { this.starting = undefined; reject(error); });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        this.starting = undefined;
        server.unref(); resolve();
      });
    });
    return this.starting;
  }

  async register(id: string, baseUrl: string, key: string, model: string | undefined, config: ProxyConfig, tool: ToolId = 'claude'): Promise<ProxyEndpoint> {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Proxy upstream must use HTTP or HTTPS');
    config = normalizeProxyConfig(config, tool);
    await this.start();
    const previous = this.routes.get(id), previousStats = this.stats.get(id) && structuredClone(this.stats.get(id)!);
    this.routes.set(id, { id, tool, baseUrl, key, model, config: structuredClone(config), options: resolveProxyOptions(config), stopped: false });
    if (!this.stats.has(id)) this.stats.set(id, { state: 'running', requests: 0, succeeded: 0, failed: 0, retries: 0, trimmedMessages: 0 });
    Object.assign(this.stats.get(id)!, { state: 'running', localUrl: this.url(id) });
    this.changed(id);
    return { baseUrl: this.url(id), key: this.localKey, rollback: () => {
      if (previous) this.routes.set(id, previous); else this.routes.delete(id);
      if (previousStats) this.stats.set(id, previousStats); else this.stats.delete(id);
      this.changed(id);
    } };
  }

  url(id: string): string { return `http://127.0.0.1:${this.port}/providers/${encodeURIComponent(id)}${this.routes.get(id)?.tool === 'codex' ? '/v1' : ''}`; }
  getPort(): number | undefined { return this.port; }
  runtime(id: string): ProxyRuntime {
    return structuredClone(this.stats.get(id) ?? { state: 'stopped', requests: 0, succeeded: 0, failed: 0, retries: 0, trimmedMessages: 0 });
  }
  stopRoute(id: string): void {
    const route = this.routes.get(id);
    if (route) route.stopped = true;
    for (const controller of this.active.get(id) ?? []) controller.abort();
    if (this.stats.has(id)) this.stats.get(id)!.state = 'stopped';
    this.changed(id);
  }
  resumeRoute(id: string): boolean {
    const route = this.routes.get(id);
    if (!route || !this.server) return false;
    route.stopped = false;
    this.stats.get(id)!.state = 'running';
    this.changed(id); return true;
  }
  remove(id: string): void { this.stopRoute(id); this.routes.delete(id); this.stats.delete(id); }
  dispose(): void {
    for (const id of this.routes.keys()) this.stopRoute(id);
    this.server?.close(); this.server?.closeAllConnections();
    this.server = undefined; this.port = undefined;
  }

  private json(res: http.ServerResponse, status: number, value: Json): void {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const match = /^\/providers\/([^/]+)(\/.*)?$/.exec(path);
      const saved = match ? this.routes.get(decodeURIComponent(match[1])) : undefined;
      if (!saved || saved.stopped) { this.json(res, 503, { type: 'error', error: { type: 'api_error', message: 'Provider proxy is stopped or unavailable; Apply it in VSCodeModelSwitch.' } }); return; }
      const route = structuredClone(saved), suffix = match![2] ?? '/';
      if (req.headers['x-api-key'] !== this.localKey && req.headers.authorization !== `Bearer ${this.localKey}`) { this.json(res, 401, { error: { message: 'Invalid local proxy credential' } }); return; }
      if (req.method === 'GET' && ['/v1/models', '/models'].includes(suffix)) { this.json(res, 200, { data: route.model ? [{ type: 'model', id: route.model, display_name: route.model }] : [] }); return; }
      const endpoints = route.tool === 'codex' ? ['/responses', '/v1/responses'] : ['/v1/messages', '/v1/messages/count_tokens'];
      if (req.method !== 'POST' || !endpoints.includes(suffix)) { this.json(res, 404, { error: { message: 'Unsupported proxy endpoint' } }); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let client: Json;
      try { client = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { this.json(res, 400, { error: { message: 'Invalid request JSON' } }); return; }
      if (!client || typeof client !== 'object' || Array.isArray(client)) { this.json(res, 400, { error: { message: 'Request must be a JSON object' } }); return; }
      if (route.tool === 'codex' ? !(typeof client.input === 'string' || Array.isArray(client.input) || client.previous_response_id) : !Array.isArray(client.messages)) { this.json(res, 400, { error: { message: route.tool === 'codex' ? 'input must be a string or array' : 'messages must be an array' } }); return; }
      if (suffix.endsWith('/count_tokens')) { this.json(res, 200, { input_tokens: Math.ceil(JSON.stringify({ system: client.system, messages: client.messages, tools: client.tools }).length / 4) }); return; }
      if (!client.model) client.model = route.model;
      await this.messages(route, client, req, res);
    } catch (error) {
      if (!res.headersSent) this.json(res, 500, { type: 'error', error: { type: 'api_error', message: 'Local proxy could not process this request' } });
      else if (!res.destroyed) res.end();
    }
  }

  private async messages(route: Route, client: Json, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now(), stats = this.stats.get(route.id)!;
    stats.requests++;
    const controller = new AbortController();
    const active = this.active.get(route.id) ?? new Set<AbortController>();
    active.add(controller); this.active.set(route.id, active);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    const timeout = setTimeout(() => controller.abort(), route.options.timeoutMs);
    let keepalive: NodeJS.Timeout | undefined;
    const responses = route.tool === 'codex', nativeResponses = responses && route.config.apiFormat === 'responses';
    const responsesClient = client;
    const stream = Boolean(client.stream);
    let messageId = (responses ? 'resp_' : 'msg_') + randomUUID().replace(/-/g, '');
    const createdAt = Math.floor(Date.now() / 1000);
    let responseSequence = route.options.rebuildStream && !nativeResponses ? 2 : 0;
    try {
      if (responses && !nativeResponses) client = responsesToAnthropic(client);
      const built = nativeResponses ? buildResponsesPayload(client, route.options) : buildPayload(client, responsesClient.tool_choice === 'none' ? { ...route.options, webTools: false } : route.options);
      stats.trimmedMessages += built.dropped;
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        if (!responses) {
          res.write(event('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: client.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
          res.write(event('ping', { type: 'ping' }));
        } else if (route.options.rebuildStream && !nativeResponses) {
          const response = { id: messageId, object: 'response', created_at: createdAt, status: 'in_progress', model: client.model, output: [] };
          res.write(event('response.created', { type: 'response.created', sequence_number: 0, response }));
          res.write(event('response.in_progress', { type: 'response.in_progress', sequence_number: 1, response }));
        }
        keepalive = setInterval(() => { if (!res.destroyed) res.write(responses ? ': keepalive\n\n' : event('ping', { type: 'ping' })); }, route.options.keepAliveMs);
      }
      if (stream && !route.options.rebuildStream) {
        if (nativeResponses) await this.passResponsesStream(route, { ...built.payload, stream: true }, res, controller.signal, stats, built.tools, (sequence, id) => { responseSequence = sequence; if (id) messageId = id; });
        else await this.passStream(route, { ...built.payload, stream: true }, res, controller.signal, stats);
      } else {
        let payload = built.payload;
        let message: Json | undefined;
        for (let iteration = 0; iteration <= route.options.maxWebIterations; iteration++) {
          const upstream = await this.upstream(route, payload, controller.signal, stats);
          message = nativeResponses ? processResponse(upstream, route.options, built.tools) : processMessage(upstream, client, route.options, built.tools);
          const blocks: Json[] = nativeResponses ? message.output : message.content;
          const toolType = nativeResponses ? 'function_call' : 'tool_use';
          const calls: Json[] = route.options.webTools ? blocks.filter((b: Json) => b.type === toolType && WEB_NAMES.has(b.name)).map((b: Json) => nativeResponses ? { ...b, id: b.call_id, input: JSON.parse(b.arguments) } : b) : [];
          if (!calls.length) break;
          if (blocks.some((b: Json) => b.type === toolType && !WEB_NAMES.has(b.name) || b.type === 'custom_tool_call')) {
            // Client tools must finish before another model round can consume their results.
            // Keep their real calls and leave an explicit reminder for the next turn.
            const text = `After the pending client tools complete, perform these deferred web requests: ${calls.map(call => `${call.name} ${JSON.stringify(call.input)}`).join('; ')}`;
            if (nativeResponses) message.output = [...blocks.filter(b => b.type !== toolType || !WEB_NAMES.has(b.name)), { type: 'message', id: 'msg_' + randomUUID().replace(/-/g, ''), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
            else {
              message.content = blocks.filter(b => b.type !== toolType || !WEB_NAMES.has(b.name));
              message.content.push({ type: 'text', text }); message.stop_reason = 'tool_use';
            }
            break;
          }
          if (iteration === route.options.maxWebIterations) throw new UpstreamError('Web tool iteration limit reached');
          const results = await Promise.all(calls.map(async (call: Json) => ({ call, blocks: await executeWebTool(call.name, call.input, route.options, controller.signal) })));
          if (nativeResponses) payload = { ...payload, input: [...payload.input, ...message.output, ...results.map(({ call, blocks }: Json) => ({ type: 'function_call_output', call_id: call.id,
            output: blocks.some((block: Json) => block.type === 'image') ? blocks.map((block: Json) => block.type === 'image'
              ? { type: 'input_image', image_url: block.source.type === 'base64' ? `data:${block.source.media_type};base64,${block.source.data}` : block.source.url }
              : { type: 'input_text', text: block.text ?? '' }) : blocks.map((block: Json) => block.text ?? '').join('\n') }))] };
          else {
            const text = message.content.map((b: Json) => b.type === 'tool_use' ? `<tool_call name="${b.name}">${JSON.stringify(b.input)}</tool_call>` : b.text ?? '').join('\n');
            payload = { ...payload, messages: [...payload.messages, { role: 'assistant', content: text }, { role: 'user', content: results.flatMap(({ call, blocks }: Json) => [{ type: 'text', text: `Result of ${call.name}:` }, ...blocks]) }] };
          }
        }
        if (responses && !nativeResponses) message = anthropicToResponse(message!, responsesClient);
        // Preserve native upstream response IDs: clients may use them as
        // previous_response_id on their next request. Keepalives can be sent
        // while waiting, but response.created must carry the real ID.
        if (nativeResponses) messageId = message!.id;
        else message!.id = messageId;
        if (responses) {
          if (!nativeResponses) message!.created_at = createdAt;
          if (message!.status !== 'completed') throw new UpstreamError('Model response was incomplete; output token limit reached');
        }
        if (stream) { for (const value of responses ? responseEvents(message!, nativeResponses) : messageEvents(message!, false)) res.write(value); res.end(); }
        else this.json(res, 200, message!);
      }
      stats.succeeded++;
      stats.lastRequest = { ok: true, status: 200, durationMs: Date.now() - started };
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : controller.signal.aborted ? 504 : 502;
      const text = (controller.signal.aborted ? 'Request cancelled or timed out' : error instanceof Error ? error.message : 'Unknown proxy error').split(route.key).join('[redacted]').slice(0, 500);
      stats.failed++;
      stats.lastRequest = { ok: false, status, durationMs: Date.now() - started, error: text };
      const value = { type: 'error', error: { type: 'api_error', message: text } };
      if (!res.destroyed) {
        if (stream && res.headersSent) {
          if (responses) res.write(event('response.failed', { type: 'response.failed', sequence_number: responseSequence, response: { id: messageId, object: 'response', created_at: createdAt, status: 'failed', output: [], error: { code: 'proxy_error', message: text } } }));
          else res.write(event('error', value));
          res.end();
        } else this.json(res, status, value);
      }
    } finally {
      clearTimeout(timeout); if (keepalive) clearInterval(keepalive);
      res.off('close', close); active.delete(controller);
      this.log(`proxy ${route.id}: ${JSON.stringify(stats.lastRequest)}`);
      this.changed(route.id);
    }
  }

  private headers(route: Route): Record<string, string> {
    return { 'content-type': 'application/json', ...proxyAuthHeaders(route.key, route.config, route.tool) };
  }

  private async passResponsesStream(route: Route, payload: Json, res: http.ServerResponse, signal: AbortSignal, stats: ProxyRuntime, tools: Set<string>, sequence: (next: number, id?: string) => void): Promise<void> {
    let response: Response | undefined;
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < route.options.maxAttempts; attempt++) {
      if (signal.aborted) throw new Error('Request cancelled');
      if (attempt) stats.retries++;
      try {
        response = await fetch(upstreamUrl(route.baseUrl, route.options.messagesPath), { method: 'POST', headers: { ...this.headers(route), 'content-length': String(Buffer.byteLength(body)) }, body, signal, redirect: 'manual' });
        if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) break;
        const status = response.status;
        await response.body?.cancel();
        const retryable = [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(status);
        if (!retryable || attempt + 1 === route.options.maxAttempts) throw new UpstreamError(response.ok ? 'Expected a Responses SSE stream' : `Upstream HTTP ${status}`, status >= 400 ? status : 502);
      } catch (error) {
        if (signal.aborted || error instanceof UpstreamError || attempt + 1 === route.options.maxAttempts) throw error;
      }
    }
    if (!response?.body) throw new UpstreamError('Upstream returned no stream');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
        if (done && pending.trim()) pending += '\n\n';
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!raw || raw === '[DONE]') continue;
          const data = JSON.parse(raw);
          if (Number.isInteger(data.sequence_number)) sequence(data.sequence_number + 1, data.response?.id);
          if (['error', 'response.failed', 'response.incomplete'].includes(data.type)) throw new UpstreamError(data.response?.error?.message ?? data.error?.message ?? data.message ?? `Upstream ${data.type}`);
          if (data.type === 'response.completed') {
            processResponse(data.response, { ...route.options, repairToolJson: false }, tools);
            res.write(frame + '\n\n'); res.end(); return;
          }
          res.write(frame + '\n\n');
        }
        if (done) break;
      }
      throw new UpstreamError('Upstream stream ended without response.completed');
    } finally { await reader.cancel().catch(() => {}); }
  }

  private async upstream(route: Route, payload: Json, signal: AbortSignal, stats: ProxyRuntime): Promise<Json> {
    let last: Error = new UpstreamError('Upstream request failed');
    for (let attempt = 0; attempt < route.options.maxAttempts; attempt++) {
      if (signal.aborted) throw new Error('Request cancelled');
      if (attempt) stats.retries++;
      try {
        const reply = await requestHttp(upstreamUrl(route.baseUrl, route.options.messagesPath), 'POST', this.headers(route), Buffer.from(JSON.stringify(payload)), signal);
        let data: Json;
        try { data = route.config.apiFormat === 'responses' ? decodeResponsesBody(reply.body.toString('utf8'), String(reply.headers['content-type']).includes('text/event-stream')) : JSON.parse(reply.body.toString('utf8')); }
        catch (error) { data = { error: { message: error instanceof Error ? error.message : 'Upstream returned invalid JSON' } }; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = { error: { message: 'Upstream returned an invalid message object' } };
        if (reply.status < 400 && (route.config.apiFormat === 'responses' ? Array.isArray(data.output) : Array.isArray(data.content))) return data;
        const retryable = [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(reply.status) || (reply.status === 403 && route.config.preset === 'justdowork' && !reply.body.length) || reply.status < 400;
        const error = new UpstreamError(`Upstream ${reply.status}: ${typeof data.error === 'string' ? data.error : data.error?.message ?? data.message ?? 'No message content'}`, reply.status >= 400 ? reply.status : 502, retryable);
        last = error;
        if (!retryable) throw error;
      } catch (error) {
        if (signal.aborted || (error instanceof UpstreamError && !error.retryable)) throw error;
        last = error instanceof Error ? error : new Error('Upstream connection failed');
      }
    }
    throw last;
  }

  /** Optional native SSE forwarding still validates errors and terminal events. */
  private async passStream(route: Route, payload: Json, res: http.ServerResponse, signal: AbortSignal, stats: ProxyRuntime): Promise<void> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < route.options.maxAttempts; attempt++) {
      if (attempt) stats.retries++;
      try {
        const next = await fetch(upstreamUrl(route.baseUrl, route.options.messagesPath), { method: 'POST', headers: this.headers(route), body: JSON.stringify(payload), signal });
        if (next.ok && next.body) { response = next; break; }
        const raw = await next.text();
        const retryable = [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(next.status) || (next.status === 403 && !raw && route.config.preset === 'justdowork');
        let detail = '';
        try { detail = JSON.parse(raw).error?.message ?? ''; } catch { /* do not expose an HTML auth response */ }
        if (!retryable || attempt + 1 === route.options.maxAttempts) throw new UpstreamError(`Upstream ${next.status}${detail ? ': ' + detail : ''}`, next.status);
      } catch (error) {
        if (signal.aborted || error instanceof UpstreamError || attempt + 1 === route.options.maxAttempts) throw error;
      }
    }
    if (!response?.body) throw new UpstreamError('Upstream returned no stream');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', stopped = false, answer = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (data.type === 'message_start' || data.type === 'ping') continue;
          if (data.type === 'error') throw new UpstreamError(data.error?.message ?? 'Upstream stream error');
          if (data.delta?.type === 'text_delta' && data.delta.text || data.content_block?.type === 'tool_use' || data.content_block?.type === 'text' && data.content_block.text) answer = true;
          if (data.type === 'message_stop') { if (!answer) throw new UpstreamError('Upstream stream ended without an answer'); stopped = true; }
          res.write(frame + '\n\n');
          if (stopped) { res.end(); return; }
        }
      }
      if (!stopped) throw new UpstreamError('Upstream stream ended without message_stop');
      res.end();
    } finally { await reader.cancel().catch(() => {}); }
  }
}
