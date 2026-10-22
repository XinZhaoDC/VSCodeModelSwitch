import { createHash, randomUUID } from 'crypto';
import { ProxyOptions } from '../types';
import { Json, parseToolJson, parseToolText, WEB_TOOLS } from './protocol';

const uid = (prefix: string) => prefix + randomUUID().replace(/-/g, '');
const clipped = (text: string, limit: number) => limit && text.length > limit
  ? text.slice(0, limit) + `\n[Proxy omitted ${text.length - limit} tool-output characters.]` : text;
const inputItems = (input: unknown): Json[] => typeof input === 'string'
  ? [{ role: 'user', content: input }] : Array.isArray(input) ? structuredClone(input) : [];

/** Keep call/output exchanges and their preceding reasoning together when trimming. */
export function trimResponsesInput(input: Json[], budget: number): { input: Json[]; dropped: number } {
  if (!budget || JSON.stringify(input).length <= budget || input.length < 2) return { input, dropped: 0 };
  const ends = new Map<string, number>();
  input.forEach((item, index) => { if (item.call_id && item.type?.endsWith('_output')) ends.set(item.call_id, index); });
  const groups: Json[][] = [];
  for (let index = 0; index < input.length;) {
    let end = index;
    for (let cursor = index; cursor <= end; cursor++) {
      const item = input[cursor];
      if (item.type === 'reasoning' && cursor + 1 < input.length) end = Math.max(end, cursor + 1);
      if (item.call_id && !item.type?.endsWith('_output')) end = Math.max(end, ends.get(item.call_id) ?? cursor);
    }
    groups.push(input.slice(index, end + 1)); index = end + 1;
  }
  const keep = new Set<number>([groups.length - 1]);
  groups.forEach((group, index) => {
    if (group.some(item => item.role === 'system' || item.role === 'developer') || index === 0) keep.add(index);
  });
  let used = [...keep].reduce((sum, index) => sum + JSON.stringify(groups[index]).length, 0);
  for (let index = groups.length - 2; index >= 0; index--) {
    const size = JSON.stringify(groups[index]).length;
    if (!keep.has(index) && used + size <= budget) { keep.add(index); used += size; }
  }
  let dropped = 0, gap = false;
  const retained: Json[] = [];
  groups.forEach((group, index) => {
    if (keep.has(index)) retained.push(...group);
    else {
      dropped += group.length;
      if (!gap) retained.push({ role: 'user', content: '[Proxy context gap: earlier exchanges were omitted. Do not infer their contents.]' });
      gap = true;
    }
  });
  return { input: retained, dropped };
}

export function buildResponsesPayload(client: Json, options: ProxyOptions): { payload: Json; dropped: number; tools: Set<string> } {
  const payload: Json = { ...structuredClone(client), ...structuredClone(options.parameters), stream: false };
  const forced = client.tool_choice?.type === 'function' ? client.tool_choice.name : undefined;
  const visible: Json[] = client.tool_choice === 'none' ? [] : structuredClone(client.tools ?? []).filter((tool: Json) => !forced || tool.name === forced);
  if (options.webTools && !forced && client.tool_choice !== 'none') for (const tool of WEB_TOOLS) {
    if (!visible.some(item => item.name === tool.name)) visible.push({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema });
  }
  const functions = visible.filter(tool => tool.type === 'function' && (!forced || tool.name === forced));
  const names = new Set<string>(functions.map(tool => tool.name));
  const emulated = new Set(functions.filter(tool => options.toolInjection && !options.nativeToolMap[tool.name]).map(tool => tool.name));
  if (client.previous_response_id && emulated.size) throw new Error('Text tool protocol requires full input history; use native tools with previous_response_id');
  const mapName = (name: string) => options.nativeToolMap[name] ?? name;
  payload.tools = visible.filter(tool => !emulated.has(tool.name)).map(tool => ({ ...tool,
    ...(tool.name ? { name: mapName(tool.name) } : {}),
    ...(typeof tool.description === 'string' && options.toolDescriptionChars ? { description: tool.description.slice(0, options.toolDescriptionChars) } : {})
  }));
  const nativeNames = payload.tools.filter((tool: Json) => tool.name).map((tool: Json) => tool.name);
  if (new Set(nativeNames).size !== nativeNames.length) throw new Error('Native tool mapping collides with another tool name');
  if (payload.tool_choice?.name) payload.tool_choice = emulated.has(payload.tool_choice.name) ? 'auto' : { ...payload.tool_choice, name: mapName(payload.tool_choice.name) };
  if (Array.isArray(payload.tool_choice?.tools)) payload.tool_choice.tools = payload.tool_choice.tools.map((tool: Json) => tool.name ? { ...tool, name: mapName(tool.name) } : tool);
  if (!payload.tools.length) { delete payload.tools; delete payload.tool_choice; }
  const original = inputItems(client.input);
  const calls = new Map(original.filter(item => item.type === 'function_call').map(item => [item.call_id, item.name]));
  const trimmed = trimResponsesInput(original, options.maxHistoryChars);
  payload.input = trimmed.input.map(item => {
    if (item.type === 'function_call') {
      if (emulated.has(item.name)) return { role: 'assistant', content: `<tool_call name="${item.name}">${item.arguments}</tool_call>` };
      return { ...item, name: mapName(item.name) };
    }
    if (item.type === 'custom_tool_call') return { ...item, name: mapName(item.name) };
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      let output = item.output;
      if (typeof output === 'string') output = clipped(output, options.maxToolResultChars);
      else if (Array.isArray(output)) {
        let remaining = options.maxToolResultChars;
        output = output.map((part: Json) => {
          if (typeof part.text !== 'string' || !options.maxToolResultChars) return part;
          const kept = Math.min(remaining, part.text.length); remaining -= kept;
          return { ...part, text: part.text.slice(0, kept) + (kept < part.text.length ? `\n[Proxy omitted ${part.text.length - kept} tool-output characters.]` : '') };
        });
      }
      if (emulated.has(calls.get(item.call_id) ?? '')) return { role: 'user', content: `<tool_result name="${calls.get(item.call_id)}">${typeof output === 'string' ? output : JSON.stringify(output)}</tool_result>` };
      return { ...item, output };
    }
    return item; // Images, hosted tools and encrypted reasoning retain their native shapes.
  });
  const instructions: string[] = [];
  for (const tool of functions.filter(tool => emulated.has(tool.name))) instructions.push(`${tool.name}: ${(tool.description ?? '').slice(0, options.toolDescriptionChars || undefined)}\nInput schema: ${JSON.stringify(tool.parameters ?? {})}`);
  if (instructions.length) instructions.unshift('Use exactly these tool schemas. Emit <tool_call name="ToolName">{"argument":"value"}</tool_call>. The client executes the tool; never invent execution results.');
  if (forced && emulated.has(forced)) instructions.push(`This request requires a call to ${forced}.`);
  if (trimmed.dropped) instructions.push(`Context notice: ${trimmed.dropped} historical input items were omitted.`);
  if (instructions.length) payload.instructions = [client.instructions, ...instructions].filter(Boolean).join('\n\n');
  if (options.maxOutputTokens) payload.max_output_tokens = Math.min(Number(payload.max_output_tokens) || options.maxOutputTokens, options.maxOutputTokens);
  const prefix = [payload.instructions, ...original.filter(item => item.role === 'system' || item.role === 'developer').map(item => JSON.stringify(item))].filter(Boolean).join('\n');
  if (options.cacheSystemPrefix && prefix) payload.prompt_cache_key ??= 'vsmodelswitch-' + createHash('sha256').update(prefix).digest('hex').slice(0, 32);
  return { payload, dropped: trimmed.dropped, tools: names };
}

export function processResponse(upstream: Json, options: ProxyOptions, tools: Set<string>): Json {
  if (!Array.isArray(upstream.output)) throw new Error('Upstream returned no Responses output');
  if (upstream.status !== 'completed') throw new Error(upstream.error?.message ?? `Response ${upstream.status ?? 'has no completion status'}: ${upstream.incomplete_details?.reason ?? 'no completed answer'}`);
  const reverse = Object.fromEntries(Object.entries(options.nativeToolMap).map(([a, b]) => [b, a]));
  const output: Json[] = [];
  for (const original of upstream.output) {
    const item = structuredClone(original);
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      item.name = reverse[item.name] ?? item.name;
      if (item.type === 'function_call' && tools.has(item.name)) {
        const parsed = parseToolJson(item.arguments ?? '', options.repairToolJson);
        if (!parsed) throw new Error(`Invalid JSON arguments for tool ${item.name}`);
        item.arguments = JSON.stringify(parsed);
      }
      output.push(item);
    } else if (item.type === 'message' && options.toolInjection) {
      let content: Json[] = [], first = true;
      const flush = () => {
        if (content.length) { output.push({ ...item, id: first ? item.id : uid('msg_'), content }); content = []; first = false; }
      };
      for (const part of item.content ?? []) {
        if (part.type !== 'output_text') { content.push(part); continue; }
        for (const block of parseToolText(part.text ?? '', tools, options.repairToolJson)) {
          if (block.type === 'text') content.push({ ...part, text: block.text });
          else { flush(); output.push({ id: uid('fc_'), type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input), status: 'completed' }); }
        }
      }
      flush();
    } else output.push(item);
  }
  const answer = output.some(item => ['function_call', 'custom_tool_call'].includes(item.type)
    || item.type === 'message' && item.content?.some((part: Json) => part.text?.trim() || part.type === 'refusal'));
  if (!answer) throw new Error('Upstream returned reasoning or empty output without an answer');
  return { ...upstream, output };
}

function anthropicContent(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new Error('Unsupported Responses message content for Anthropic upstream');
  return content.map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return { type: 'text', text: part.text };
    if (part.type === 'input_image') {
      const data = /^data:([^;]+);base64,(.+)$/s.exec(part.image_url ?? '');
      if (!part.image_url) throw new Error('Anthropic upstream requires image_url rather than an OpenAI file_id');
      return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: part.image_url } };
    }
    throw new Error(`Responses content ${part.type} cannot be sent to an Anthropic upstream; select OpenAI Responses`);
  });
}

/** Protocol translation is explicit: opaque OpenAI state is never silently discarded. */
export function responsesToAnthropic(client: Json): Json {
  if (client.previous_response_id || client.conversation) throw new Error('Anthropic upstream requires full input history; previous_response_id/conversation is unsupported');
  if (client.text?.format && client.text.format.type !== 'text') throw new Error('Structured Responses output requires an OpenAI Responses upstream');
  const system = client.instructions ? [client.instructions] : [];
  const messages: Json[] = [];
  for (const item of inputItems(client.input)) {
    if (item.role === 'developer' || item.role === 'system') { system.push(anthropicContent(item.content).map(part => part.text ?? '').join('\n')); continue; }
    if (item.role && (!item.type || item.type === 'message')) messages.push({ role: item.role, content: anthropicContent(item.content) });
    else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const input = item.type === 'custom_tool_call' ? { input: item.input } : parseToolJson(item.arguments ?? '', false);
      if (!input) throw new Error(`Invalid historical arguments for ${item.name}`);
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id, name: item.name, input }] });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id, content: anthropicContent(item.output) }] });
    else if (item.type === 'reasoning' && !item.encrypted_content) {
      const summary = (item.summary ?? []).map((part: Json) => part.text ?? '').join('\n');
      if (summary) messages.push({ role: 'assistant', content: [{ type: 'text', text: '[Previous reasoning summary]\n' + summary }] });
    } else throw new Error(`Responses input ${item.type} cannot be translated to Anthropic; select OpenAI Responses or start a new session`);
  }
  const tools = (client.tools ?? []).map((tool: Json) => {
    if (tool.type === 'function') return { name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: 'object', properties: {} } };
    if (tool.type === 'custom') return { name: tool.name, description: `${tool.description ?? ''}\nPass the complete tool input as the input string.`, input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } };
    throw new Error(`Hosted tool ${tool.type} requires an OpenAI Responses upstream`);
  });
  const choice = client.tool_choice;
  let toolChoice: Json | undefined;
  if (choice === 'required') toolChoice = { type: 'any' };
  else if (choice === 'auto') toolChoice = { type: 'auto' };
  else if (choice?.name) toolChoice = { type: 'tool', name: choice.name };
  else if (choice && choice !== 'none') throw new Error('This tool_choice requires an OpenAI Responses upstream');
  return { model: client.model, system: system.join('\n\n'), messages, tools: choice === 'none' ? [] : tools,
    max_tokens: client.max_output_tokens ?? 8192, stream: client.stream,
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(client.temperature !== undefined ? { temperature: client.temperature } : {}),
    ...(client.top_p !== undefined ? { top_p: client.top_p } : {}),
    ...(client.reasoning?.effort && client.reasoning.effort !== 'none' ? { thinking: { type: 'adaptive' }, output_config: { effort: client.reasoning.effort === 'xhigh' ? 'high' : client.reasoning.effort } } : {}) };
}

export function anthropicToResponse(message: Json, client: Json): Json {
  const output: Json[] = [];
  const custom = new Set((client.tools ?? []).filter((tool: Json) => tool.type === 'custom').map((tool: Json) => tool.name));
  let content: Json[] = [];
  const flush = () => { if (content.length) { output.push({ id: uid('msg_'), type: 'message', role: 'assistant', status: 'completed', content }); content = []; } };
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'output_text', text: block.text, annotations: [] });
    else if (block.type === 'tool_use') {
      flush();
      output.push({ id: uid('fc_'), type: custom.has(block.name) ? 'custom_tool_call' : 'function_call',
        call_id: block.id, name: block.name, status: 'completed',
        ...(custom.has(block.name) ? { input: block.input?.input ?? '' } : { arguments: JSON.stringify(block.input) }) });
    } else if (block.type === 'thinking') { flush(); output.push({ id: uid('rs_'), type: 'reasoning', summary: [{ type: 'summary_text', text: block.thinking }] }); }
  }
  flush();
  const incomplete = message.stop_reason === 'max_tokens';
  return { id: uid('resp_'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : 'completed',
    error: null, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, model: client.model, output,
    usage: { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0,
      total_tokens: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0) } };
}

/** Complete Responses event envelopes, including the final response object and usage. */
export function* responseEvents(response: Json, includeStart = true): Generator<string> {
  let sequence = includeStart ? 0 : 2;
  const emit = (type: string, value: Json) => `event: ${type}\ndata: ${JSON.stringify({ ...value, type, sequence_number: sequence++ })}\n\n`;
  if (includeStart) {
    const initial = { ...response, status: 'in_progress', output: [], usage: null };
    yield emit('response.created', { response: initial });
    yield emit('response.in_progress', { response: initial });
  }
  for (const [output_index, item] of response.output.entries()) {
    const base = { output_index, item_id: item.id };
    const start = item.type === 'message' ? { ...item, content: [], status: 'in_progress' }
      : item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' }
      : item.type === 'custom_tool_call' ? { ...item, input: '', status: 'in_progress' } : item;
    yield emit('response.output_item.added', { output_index, item: start });
    if (item.type === 'message') for (const [content_index, part] of item.content.entries()) {
      const key = part.type === 'refusal' ? 'refusal' : 'text';
      yield emit('response.content_part.added', { ...base, content_index, part: { ...part, [key]: '' } });
      yield emit('response.' + (key === 'text' ? 'output_text' : key) + '.delta', { ...base, content_index, delta: part[key] ?? '' });
      yield emit('response.' + (key === 'text' ? 'output_text' : key) + '.done', { ...base, content_index, [key]: part[key] ?? '' });
      yield emit('response.content_part.done', { ...base, content_index, part });
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call', kind = custom ? 'custom_tool_call_input' : 'function_call_arguments', field = custom ? 'input' : 'arguments';
      yield emit('response.' + kind + '.delta', { ...base, delta: item[field] });
      yield emit('response.' + kind + '.done', { ...base, name: item.name, [field]: item[field] });
    }
    if (item.type === 'reasoning') for (const [summary_index, part] of (item.summary ?? []).entries()) {
      yield emit('response.reasoning_summary_part.added', { ...base, summary_index, part: { ...part, text: '' } });
      yield emit('response.reasoning_summary_text.delta', { ...base, summary_index, delta: part.text ?? '' });
      yield emit('response.reasoning_summary_text.done', { ...base, summary_index, text: part.text ?? '' });
      yield emit('response.reasoning_summary_part.done', { ...base, summary_index, part });
    }
    yield emit('response.output_item.done', { output_index, item });
  }
  yield emit(response.status === 'completed' ? 'response.completed' : 'response.incomplete', { response });
}

export function decodeResponsesBody(body: string, sse: boolean): Json {
  if (!sse) return JSON.parse(body);
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!raw || raw === '[DONE]') continue;
    const data = JSON.parse(raw);
    if (data.type === 'response.completed') return data.response;
    if (['error', 'response.failed', 'response.incomplete'].includes(data.type)) throw new Error(data.response?.error?.message ?? data.error?.message ?? data.message ?? `Upstream ${data.type}`);
  }
  throw new Error('Upstream stream ended without response.completed');
}
