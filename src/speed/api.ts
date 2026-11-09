import { networkFetch } from '../network/transport';
import { performance } from 'perf_hooks';
import { SpeedMeasurement } from './measurement';
import { count, record, SPEED_PROMPT, SpeedMetrics, SpeedUsage } from './types';

export interface ApiSpeedOptions {
  protocol: 'anthropic' | 'responses' | 'chat';
  url: string;
  headers: Record<string, string>;
  model: string;
  effort: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  timingSource: SpeedMetrics['timingSource'];
}

/** Meter the actual selected connection. No fallback retries or hidden parameter changes. */
export async function measureApi(options: ApiSpeedOptions): Promise<SpeedMetrics> {
  const body = options.protocol === 'anthropic'
    ? { model: options.model, max_tokens: options.maxOutputTokens, stream: true, messages: [{ role: 'user', content: SPEED_PROMPT }] }
    : options.protocol === 'responses'
    ? { model: options.model, input: SPEED_PROMPT, max_output_tokens: options.maxOutputTokens, reasoning: { effort: options.effort }, stream: true, tools: [], tool_choice: 'none' }
    : { model: options.model, messages: [{ role: 'user', content: SPEED_PROMPT }], ...(/^(?:gpt-[5-9]|o[1-9])/.test(options.model) ? { max_completion_tokens: options.maxOutputTokens } : { max_tokens: options.maxOutputTokens }), stream: true };
  const meter = new SpeedMeasurement();
  const started = performance.now();
  const response = await networkFetch(options.url, { method: 'POST', headers: { ...options.headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: options.signal, redirect: 'manual' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Model request HTTP ${response.status}`); }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw new Error('Expected a native SSE stream'); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', completed = false, actualModel = options.model, serviceTier: string | undefined;
  const usage: SpeedUsage = {};
  const readUsage = (value: unknown) => {
    const data = record(value);
    const assign = (key: keyof SpeedUsage, value: unknown) => { const number = count(value); if (number !== undefined) usage[key] = number; };
    assign('inputTokens', data.input_tokens ?? data.prompt_tokens);
    assign('outputTokens', data.output_tokens ?? data.completion_tokens);
    assign('reasoningTokens', record(data.output_tokens_details ?? data.completion_tokens_details).reasoning_tokens);
    assign('cachedInputTokens', record(data.input_tokens_details ?? data.prompt_tokens_details).cached_tokens ?? data.cache_read_input_tokens);
  };
  const consume = (raw: string) => {
    if (raw === '[DONE]') { if (options.protocol === 'chat') completed = true; return; }
    let data: Record<string, unknown>;
    try { data = record(JSON.parse(raw)); } catch { throw new Error('Invalid SSE JSON'); }
    const delta = record(data.delta), message = record(data.message), result = record(data.response);
    if (data.type === 'error' || data.type === 'response.failed' || data.type === 'response.incomplete' || data.error) throw new Error('Model stream failed or was incomplete');
    if (typeof data.model === 'string') actualModel = data.model;
    if (typeof message.model === 'string') actualModel = message.model;
    if (typeof result.model === 'string') actualModel = result.model;
    if (typeof data.service_tier === 'string') serviceTier = data.service_tier;
    if (typeof result.service_tier === 'string') serviceTier = result.service_tier;
    readUsage(data.usage); readUsage(message.usage); readUsage(result.usage);
    const elapsed = performance.now() - started;
    if (data.type === 'content_block_start') {
      const block = record(data.content_block);
      if (block.type === 'tool_use') throw new Error('Tool call is not a text benchmark sample');
      if (block.type === 'text' && typeof block.text === 'string') meter.add(block.text, elapsed);
    }
    if (data.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') meter.add(delta.text, elapsed);
    if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') meter.add(data.delta, elapsed);
    if (data.type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(String(record(data.item).type))) throw new Error('Tool call is not a text benchmark sample');
    if (options.protocol === 'chat' && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        const entry = record(choice), part = record(entry.delta);
        if (part.tool_calls || part.function_call) throw new Error('Tool call is not a text benchmark sample');
        if (typeof part.content === 'string') meter.add(part.content, elapsed);
        if (entry.finish_reason === 'length' || entry.finish_reason === 'content_filter') throw new Error('Model output was incomplete');
      }
    }
    if (data.type === 'message_delta' && delta.stop_reason === 'max_tokens') throw new Error('Model output token limit reached');
    if (data.type === 'message_stop') completed = true;
    if (data.type === 'response.completed') {
      if (result.status !== 'completed') throw new Error('Model response did not complete');
      completed = true;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      if (done && pending.trim()) pending += '\n\n';
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (raw) consume(raw);
        if (completed) return meter.finish(actualModel, performance.now() - started, 0, usage, options.timingSource, serviceTier);
      }
      if (done) break;
    }
    if (!completed) throw new Error('Stream ended without a completion event');
    return meter.finish(actualModel, performance.now() - started, 0, usage, options.timingSource, serviceTier);
  } finally { await reader.cancel().catch(() => {}); }
}
