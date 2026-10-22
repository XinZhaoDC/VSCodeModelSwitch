// Compatibility behavior adapted from justdowork-proxy.
// Licensed under PolyForm Noncommercial License 1.0.0; see THIRD_PARTY_NOTICES.md.
// Required Notice: Copyright (c) 2026 abdurrehmandaudi — justdowork-proxy — https://github.com/abdurrehmandaudi/justdowork-proxy
import { randomUUID } from 'crypto';
import { ProxyOptions } from '../types';

export type Json = Record<string, any>;

export const WEB_NAMES = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_fetch', 'fetch_image']);
export const WEB_TOOLS = [
  { name: 'WebSearch', description: 'Search the web for information.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'WebFetch', description: 'Read text from a web page.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'fetch_image', description: 'Fetch an image by URL.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }
];

/** Strict JSON is always tried first; repairs never change an already valid tool input. */
export function parseToolJson(raw: string, repair = true): Json | undefined {
  const parse = (text: string) => {
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }
    catch { return undefined; }
  };
  const strict = parse(raw);
  if (strict || !repair) return strict;
  let output = '', quoted = false;
  const stack: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '\\') {
        const next = raw[i + 1];
        if (next && '"\\/bfnrtu'.includes(next)) { output += c + next; i++; }
        else output += '\\\\';
      } else if (c === '"') { quoted = false; output += c; }
      else if (c.charCodeAt(0) < 32) output += JSON.stringify(c).slice(1, -1);
      else output += c;
    } else if (c === '"') { quoted = true; output += c; }
    else if (c === '{' || c === '[') { stack.push(c); output += c; }
    else if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === (c === '}' ? '{' : '[')) { stack.pop(); output += c; }
    } else if (c === ',' && /^\s*[}\]]/.test(raw.slice(i + 1))) { /* trailing comma */ }
    else output += c;
  }
  if (quoted) output += '"';
  output += stack.reverse().map(c => c === '{' ? '}' : ']').join('');
  const fixed = parse(output);
  if (fixed) return fixed;
  const start = output.indexOf('{'), end = output.lastIndexOf('}');
  return start >= 0 && end > start ? parse(output.slice(start, end + 1)) : undefined;
}

function decodeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseToolText(text: string, validNames: Set<string>, repair: boolean): Json[] {
  const spans: Array<{ start: number; end: number; block: Json }> = [];
  const add = (name: string, input: Json | undefined, start: number, end: number) => {
    if (input && validNames.has(name)) spans.push({ start, end, block: { type: 'tool_use', id: 'toolu_' + randomUUID().replace(/-/g, ''), name, input } });
  };
  const open = /<(?:antml:)?tool_call(?:\s+name\s*=\s*["']([^"']+)["'])?\s*>/g;
  const matches = [...text.matchAll(open)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i], start = match.index!, bodyStart = start + match[0].length;
    const close = /<\/(?:antml:)?tool_call\s*>/.exec(text.slice(bodyStart));
    const next = matches[i + 1]?.index ?? text.length;
    const bodyEnd = close && bodyStart + close.index < next ? bodyStart + close.index : next;
    const end = close && bodyEnd < next ? bodyEnd + close[0].length : next;
    const value = parseToolJson(text.slice(bodyStart, bodyEnd).trim(), repair);
    const name = match[1] ?? value?.name;
    const input = value && (value.input ?? value.arguments ?? value.parameters ?? (match[1] ? value : undefined));
    if (name && validNames.has(name) && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error(`Invalid JSON arguments for tool ${name}`);
    add(name, input && typeof input === 'object' && !Array.isArray(input) ? input : undefined, start, end);
  }
  if (!spans.length) {
    for (const match of text.matchAll(/<(?:antml:)?invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g)) {
      const input: Json = {};
      for (const param of match[2].matchAll(/<(?:antml:)?parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g)) {
        const value = decodeXml(param[2]);
        try { input[param[1]] = JSON.parse(value); } catch { input[param[1]] = value; }
      }
      add(match[1], input, match.index!, match.index! + match[0].length);
    }
  }
  if (!spans.length) {
    const value = parseToolJson(text.trim(), repair);
    if (value?.name && value.input && typeof value.input === 'object') add(value.name, value.input, 0, text.length);
  }
  const blocks: Json[] = [];
  let cursor = 0;
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue;
    const before = text.slice(cursor, span.start).trim();
    if (before) blocks.push({ type: 'text', text: before });
    blocks.push(span.block); cursor = span.end;
  }
  const tail = text.slice(cursor).trim();
  if (tail) blocks.push({ type: 'text', text: tail });
  return blocks;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: Json) => b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
}

function limitText(text: string, limit: number): string {
  return limit > 0 && text.length > limit ? text.slice(0, limit) + `\n[Proxy omitted ${text.length - limit} tool-output characters.]` : text;
}

function convertHistory(messages: Json[], options: ProxyOptions): Json[] {
  const emulated = new Map<string, string>();
  if (options.toolInjection) for (const m of messages) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'tool_use' && !options.nativeToolMap[b.name]) emulated.set(b.id, b.name);
  }
  return messages.map(m => {
    if (!Array.isArray(m.content)) return { ...m };
    const content = m.content.map((b: Json): Json => {
      if (b.type === 'tool_use') {
        const mapped = options.nativeToolMap[b.name];
        if (mapped) return { ...b, name: mapped };
        if (options.toolInjection) return { type: 'text', text: `<tool_call name="${b.name}">${JSON.stringify(b.input ?? {})}</tool_call>` };
      }
      if (b.type === 'tool_reference') return { type: 'text', text: `[Available tool: ${b.tool_name ?? ''}]` };
      if (b.type === 'tool_result') {
        if (emulated.has(b.tool_use_id)) return { type: 'text', text: `<tool_result name="${emulated.get(b.tool_use_id)}"${b.is_error ? ' error="true"' : ''}>${limitText(textOf(b.content), options.maxToolResultChars)}</tool_result>` };
        if (typeof b.content === 'string') return { ...b, content: limitText(b.content, options.maxToolResultChars) };
        if (Array.isArray(b.content)) {
          let remaining = options.maxToolResultChars;
          return { ...b, content: b.content.map((inner: Json) => {
            if (inner.type !== 'text' || options.maxToolResultChars === 0) return inner;
            const text = inner.text ?? '', kept = Math.min(remaining, text.length);
            remaining -= kept;
            return { ...inner, text: text.slice(0, kept) + (kept < text.length ? `\n[Proxy omitted ${text.length - kept} tool-output characters.]` : '') };
          }) };
        }
      }
      return b;
    });
    return { role: m.role, content };
  });
}

/** Trim complete native tool exchanges, preserving the original user instruction and current turn. */
export function trimHistory(messages: Json[], budget: number): { messages: Json[]; dropped: number } {
  if (!budget || messages.length < 2 || JSON.stringify(messages).length <= budget) return { messages, dropped: 0 };
  const groups: Json[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i], group = [m];
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: Json) => b.type === 'tool_use') && messages[i + 1]?.role === 'user') group.push(messages[++i]);
    groups.push(group);
  }
  const keep = new Set<number>();
  if (groups[0][0].role === 'user') keep.add(0);
  keep.add(groups.length - 1);
  let used = [...keep].reduce((sum, i) => sum + JSON.stringify(groups[i]).length, 0);
  let recentMessages = groups[groups.length - 1].length;
  for (let i = groups.length - 2; i >= 0 && recentMessages < 24; i--) {
    if (keep.has(i)) continue;
    const size = JSON.stringify(groups[i]).length;
    if (used + size > budget) break;
    keep.add(i); used += size; recentMessages += groups[i].length;
  }
  // Older human instructions receive a reserved share before general history.
  let reserved = Math.max(0, budget * 0.35);
  for (let i = groups.length - 2; i >= 0; i--) {
    const size = JSON.stringify(groups[i]).length;
    if (!keep.has(i) && groups[i][0].role === 'user' && size <= reserved && used + size <= budget) {
      keep.add(i); used += size; reserved -= size;
    }
  }
  for (let i = groups.length - 2; i >= 0; i--) {
    if (keep.has(i)) continue;
    const size = JSON.stringify(groups[i]).length;
    if (used + size <= budget) { keep.add(i); used += size; }
  }
  const out: Json[] = [];
  let dropped = 0, marked = false;
  for (let i = 0; i < groups.length; i++) {
    if (keep.has(i)) out.push(...groups[i]);
    else {
      dropped += groups[i].length;
      if (!marked) { out.push({ role: 'user', content: '[Proxy context gap: earlier exchanges were omitted. Do not infer their contents.]' }); marked = true; }
    }
  }
  return { messages: out, dropped };
}

function alternating(messages: Json[]): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    if (out.length && out[out.length - 1].role === m.role) {
      const previous = out[out.length - 1];
      const blocks = (c: any) => typeof c === 'string' ? [{ type: 'text', text: c }] : c;
      previous.content = [...blocks(previous.content), ...blocks(m.content)];
    } else out.push({ ...m });
  }
  return out;
}

export function buildPayload(client: Json, options: ProxyOptions): { payload: Json; dropped: number; tools: Set<string> } {
  const tools: Json[] = Array.isArray(client.tools) ? [...client.tools] : [];
  const forced = client.tool_choice?.type === 'tool' ? client.tool_choice.name : undefined;
  const visible = forced ? tools.filter(t => t.name === forced) : [...tools];
  if (options.webTools && !forced) for (const tool of WEB_TOOLS) if (!visible.some(t => t.name === tool.name)) visible.push(tool);
  const names = new Set<string>(visible.map(t => t.name));
  const native: Json[] = [], extra: Json[] = [];
  for (const tool of visible) {
    const mapped = options.nativeToolMap[tool.name];
    if (mapped || (!options.toolInjection && !WEB_NAMES.has(tool.name))) native.push({ ...tool, name: mapped ?? tool.name });
    else extra.push(tool);
  }
  const system = typeof client.system === 'string' ? client.system : textOf(client.system);
  const instructions: string[] = [];
  if (extra.length || Object.keys(options.nativeToolMap).length) {
    instructions.push('Tool protocol for this request: use the tool schemas exactly; do not invent tools or pretend execution succeeded.');
    for (const tool of extra) instructions.push(`${tool.name}: ${(tool.description ?? '').slice(0, options.toolDescriptionChars || undefined)}\nInput schema: ${JSON.stringify(tool.input_schema ?? {})}`);
    if (extra.length) instructions.push('For the tools described above, emit <tool_call name="ToolName">{"argument":"value"}</tool_call>. Emit JSON only inside the tag, with escaped newlines and quotes. The client will execute the call and return its result.');
    if (native.length) instructions.push('Native tool names: ' + native.map(t => t.name).join(', '));
    if (forced) instructions.push(`This request requires a call to ${options.nativeToolMap[forced] ?? forced}. Do not substitute a prose answer.`);
  }
  const converted = convertHistory(client.messages ?? [], options);
  const trimmed = trimHistory(converted, options.maxHistoryChars);
  if (trimmed.dropped) instructions.push(`Context notice: ${trimmed.dropped} historical messages were omitted. Retained instructions remain authoritative; ask for missing details rather than fabricating them.`);
  const payload: Json = { ...client, ...options.parameters, messages: alternating(trimmed.messages), stream: false };
  // SDK-only metadata is not understood by the relay.
  delete payload.metadata;
  payload.tools = native;
  if (!native.length) delete payload.tools;
  if (forced && options.nativeToolMap[forced]) payload.tool_choice = { type: 'tool', name: options.nativeToolMap[forced] };
  else if (forced && extra.some(t => t.name === forced)) delete payload.tool_choice;
  else if (!native.length) delete payload.tool_choice;
  payload.max_tokens = Math.max(1, Number(payload.max_tokens) || 8192);
  if (options.maxOutputTokens) payload.max_tokens = Math.min(payload.max_tokens, options.maxOutputTokens);
  const newest = client.messages?.at(-1);
  const freshUser = newest?.role === 'user' && (!Array.isArray(newest.content) || !newest.content.some((b: Json) => b.type === 'tool_result'));
  if (!payload.thinking && options.extraThinkingBudget > 0 && freshUser) payload.thinking = { type: 'enabled', budget_tokens: options.extraThinkingBudget };
  if (payload.thinking?.type === 'enabled') {
    const limit = options.maxThinkingBudget || Number(payload.thinking.budget_tokens);
    const budget = Math.min(Number(payload.thinking.budget_tokens) || 1024, limit);
    payload.max_tokens = Math.max(payload.max_tokens, budget + 2048);
    if (options.maxOutputTokens) payload.max_tokens = Math.min(payload.max_tokens, options.maxOutputTokens);
    if (budget < 1024 || budget >= payload.max_tokens) throw new Error('Thinking requires at least 1024 tokens and an output cap larger than its budget');
    payload.thinking = { ...payload.thinking, budget_tokens: budget };
  }
  const fullSystem = [instructions.join('\n\n'), system].filter(Boolean).join('\n\n');
  if (fullSystem) payload.system = options.cacheSystemPrefix ? [{ type: 'text', text: fullSystem, cache_control: { type: 'ephemeral' } }] : fullSystem;
  return { payload, dropped: trimmed.dropped, tools: names };
}

export function processMessage(upstream: Json, client: Json, options: ProxyOptions, tools: Set<string>): Json {
  if (!Array.isArray(upstream.content)) throw new Error('Upstream returned no message content');
  const reverse = Object.fromEntries(Object.entries(options.nativeToolMap).map(([a, b]) => [b, a]));
  const content: Json[] = [];
  const clientThinking = client.thinking && client.thinking.type !== 'disabled';
  for (const block of upstream.content) {
    if (block.type === 'text') content.push(...(tools.size ? parseToolText(block.text ?? '', tools, options.repairToolJson) : [{ type: 'text', text: block.text ?? '' }]));
    else if (block.type === 'tool_use') {
      const name = reverse[block.name] ?? block.name;
      if (tools.has(name)) content.push({ ...block, name });
    } else if ((block.type === 'thinking' || block.type === 'redacted_thinking') && clientThinking) content.push(block);
  }
  if (!content.some(b => b.type === 'tool_use' || (b.type === 'text' && b.text?.trim()))) throw new Error('Upstream returned thinking or empty content without an answer');
  let stop = content.some(b => b.type === 'tool_use') ? 'tool_use' : upstream.stop_reason ?? 'end_turn';
  let stopSequence = upstream.stop_sequence ?? null;
  for (let i = 0; i < content.length; i++) {
    if (content[i].type !== 'text') continue;
    const candidates = (client.stop_sequences ?? []).map((s: string) => ({ sequence: s, index: content[i].text.indexOf(s) })).filter((x: Json) => x.sequence && x.index >= 0).sort((a: Json, b: Json) => a.index - b.index);
    if (candidates.length) { content[i].text = content[i].text.slice(0, candidates[0].index); content.splice(i + 1); stop = 'stop_sequence'; stopSequence = candidates[0].sequence; break; }
  }
  return { id: upstream.id ?? 'msg_' + randomUUID().replace(/-/g, ''), type: 'message', role: 'assistant',
    model: client.model ?? upstream.model, content, stop_reason: stop, stop_sequence: stopSequence,
    usage: upstream.usage ?? { input_tokens: 0, output_tokens: 0 } };
}

export function event(type: string, data: Json): string { return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; }

export function* messageEvents(message: Json, includeStart = true): Generator<string> {
  if (includeStart) yield event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null } });
  for (const [index, block] of message.content.entries()) {
    const start = block.type === 'text' ? { type: 'text', text: '' } : block.type === 'tool_use' ? { ...block, input: {} } : block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block;
    yield event('content_block_start', { type: 'content_block_start', index, content_block: start });
    if (block.type === 'text' || block.type === 'tool_use' || block.type === 'thinking') {
      const text = block.type === 'tool_use' ? JSON.stringify(block.input) : block.type === 'thinking' ? block.thinking : block.text;
      const kind = block.type === 'tool_use' ? 'input_json_delta' : block.type === 'thinking' ? 'thinking_delta' : 'text_delta';
      const field = block.type === 'tool_use' ? 'partial_json' : block.type === 'thinking' ? 'thinking' : 'text';
      for (let offset = 0; offset < (text ?? '').length; offset += 800) yield event('content_block_delta', { type: 'content_block_delta', index, delta: { type: kind, [field]: text.slice(offset, offset + 800) } });
      if (block.type === 'thinking' && block.signature) yield event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    }
    yield event('content_block_stop', { type: 'content_block_stop', index });
  }
  yield event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: { output_tokens: message.usage.output_tokens ?? 0 } });
  yield event('message_stop', { type: 'message_stop' });
}
