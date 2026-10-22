'use strict';
// Synthetic inputs only. HTTP and web-tool mocks bind exclusively to loopback.
const assert = require('node:assert/strict');
const http = require('node:http');
const { ProxyServer } = require('../out/proxy/server');
const { normalizeProxyConfig, proxyDefaults } = require('../out/proxy/config');
const { buildResponsesPayload, processResponse, responsesToAnthropic, anthropicToResponse, responseEvents, decodeResponsesBody, trimResponsesInput } = require('../out/proxy/responses');
const { proxyClientConfig, managedProxyId } = require('../out/proxy/applied');
let passed = 0;
function check(name, fn) { fn(); console.log('PASS ' + name); passed++; }
const cfg = (overrides = {}, apiFormat = 'responses') => ({ mode: 'proxy', preset: 'custom', apiFormat, overrides });
const opts = (overrides = {}) => ({ ...proxyDefaults('custom', 'responses'), ...overrides });
const textItem = text => ({ id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const reply = (output = [textItem('OK')], extra = {}) => ({ id: 'resp_mock', object: 'response', created_at: 1, model: 'mock-model', status: 'completed', error: null, output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...extra });
const call = (name, args = '{}', id = 'call_mock') => ({ id: 'fc_mock', type: 'function_call', name, arguments: args, call_id: id, status: 'completed' });
const tool = name => ({ type: 'function', name, description: 'A complete tool description', parameters: { type: 'object', properties: { command: { type: 'string' } } } });
const request = (extra = {}) => ({ model: 'mock-model', input: 'Hello', ...extra });
const frame = data => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n';

async function main() {
  check('Codex defaults to Responses; CC defaults and explicit Anthropic translation remain available', () => {
    assert.equal(normalizeProxyConfig(cfg(), 'codex').apiFormat, 'responses');
    assert.equal(normalizeProxyConfig(cfg({}, 'anthropic'), 'codex').apiFormat, 'anthropic');
    assert.equal(proxyDefaults('custom').messagesPath, '/v1/messages');
    assert.throws(() => normalizeProxyConfig(cfg({ extraThinkingBudget: 1024 }), 'codex'), /reasoning.effort/);
    assert.throws(() => normalizeProxyConfig(cfg({ rebuildStream: false }, 'anthropic'), 'codex'), /translation requires/);
    assert.throws(() => normalizeProxyConfig(cfg({ parameters: { input: [] } }), 'codex'), /Proxy owns input/);
  });
  const opaque = { id: 'rs_opaque', type: 'reasoning', encrypted_content: 'synthetic-encrypted-state', summary: [] };
  const image = { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' };
  check('Responses transformations preserve opaque state/images/custom tools and apply native parameters/caps/cache', () => {
    const original = request({ instructions: 'Stable instructions', input: [opaque, { role: 'user', content: [{ type: 'input_text', text: 'look' }, image] }], tools: [tool('run'), { type: 'custom', name: 'apply_patch', format: { type: 'text' } }], max_output_tokens: 8000, previous_response_id: 'resp_previous' });
    const built = buildResponsesPayload(original, opts({ parameters: { reasoning: { effort: 'high' } }, maxOutputTokens: 4000, cacheSystemPrefix: true, nativeToolMap: { run: 'exec' } }));
    assert.deepEqual(built.payload.input, original.input); assert.equal(built.payload.previous_response_id, 'resp_previous');
    assert.deepEqual(built.payload.tools[1], original.tools[1]); assert.equal(built.payload.tools[0].name, 'exec');
    assert.equal(built.payload.max_output_tokens, 4000); assert.equal(built.payload.reasoning.effort, 'high');
    assert.match(built.payload.prompt_cache_key, /^vsmodelswitch-/); assert.equal(original.max_output_tokens, 8000);
    assert.throws(() => buildResponsesPayload(original, opts({ toolInjection: true })), /full input history/);
  });
  check('Responses history trimming preserves full parallel call/output groups and marks missing context', () => {
    const history = [{ role: 'user', content: 'Original instruction' }];
    for (let index = 0; index < 15; index++) history.push({ ...opaque, id: 'rs' + index }, call('run', '{}', 'a' + index), call('run', '{}', 'b' + index),
      { type: 'function_call_output', call_id: 'a' + index, output: 'x'.repeat(1000) }, { type: 'function_call_output', call_id: 'b' + index, output: 'x'.repeat(1000) });
    const result = trimResponsesInput(history, 3500), ids = new Set(result.input.filter(item => item.type === 'function_call').map(item => item.call_id));
    assert.ok(result.dropped > 0); assert.equal(result.input[0].content, 'Original instruction'); assert.match(JSON.stringify(result.input), /context gap/);
    for (const item of result.input.filter(item => item.type === 'function_call_output')) assert.ok(ids.has(item.call_id));
  });
  check('tool result caps preserve images and text protocol preserves call/output identity', () => {
    const client = request({ input: [call('run'), { type: 'function_call_output', call_id: 'call_mock', output: [{ type: 'input_text', text: 'x'.repeat(20) }, { type: 'input_text', text: 'rest' }, image] }] });
    const native = buildResponsesPayload(client, opts({ maxToolResultChars: 5 }));
    assert.deepEqual(native.payload.input[1].output[2], image); assert.match(native.payload.input[1].output[1].text, /omitted 4/);
    const emulated = buildResponsesPayload({ ...client, tools: [tool('run')], tool_choice: { type: 'function', name: 'run' } }, opts({ toolInjection: true }));
    assert.equal(emulated.payload.tools, undefined); assert.match(emulated.payload.instructions, /requires a call to run/); assert.match(emulated.payload.input[1].content, /tool_result name="run"/);
  });
  check('native and text tools are restored with repaired JSON while custom/opaque output remains intact', () => {
    const native = processResponse(reply([opaque, call('exec', '{"command":"ok",}'), { type: 'custom_tool_call', id: 'ct', call_id: 'c', name: 'apply_patch', input: '*** patch ***' }]), opts({ nativeToolMap: { run: 'exec' } }), new Set(['run']));
    assert.deepEqual(native.output[0], opaque); assert.equal(native.output[1].name, 'run'); assert.equal(native.output[1].arguments, '{"command":"ok"}'); assert.equal(native.output[2].input, '*** patch ***');
    assert.throws(() => processResponse(reply([call('run', '{"command":"ok",}')]), opts({ repairToolJson: false }), new Set(['run'])), /Invalid JSON/);
    const emulated = processResponse(reply([textItem('<tool_call name="run">{"command":"ok"}</tool_call>')]), opts({ toolInjection: true }), new Set(['run']));
    assert.equal(emulated.output[0].type, 'function_call'); assert.equal(emulated.output[0].name, 'run');
  });
  check('incomplete, failed and reasoning-only Responses never count as answers', () => {
    assert.throws(() => processResponse(reply([opaque]), opts(), new Set()), /without an answer/);
    assert.throws(() => processResponse(reply([], { status: 'incomplete' }), opts(), new Set()), /incomplete/);
    assert.throws(() => decodeResponsesBody(frame({ type: 'response.failed', response: { error: { message: 'synthetic failure' } } }), true), /synthetic failure/);
    assert.throws(() => decodeResponsesBody(frame({ type: 'response.created', response: {} }), true), /without response.completed/);
  });
  check('Anthropic bridge translates function/custom tools and images without fabricating opaque state support', () => {
    const client = request({ input: [{ role: 'developer', content: 'System instruction' }, { role: 'user', content: [image] }, { type: 'custom_tool_call', call_id: 'ct', name: 'apply_patch', input: 'raw patch' }, { type: 'custom_tool_call_output', call_id: 'ct', output: 'done' }], tools: [tool('run'), { type: 'custom', name: 'apply_patch' }] });
    const built = responsesToAnthropic(client);
    assert.match(built.system, /System instruction/); assert.equal(built.messages[0].content[0].source.type, 'base64'); assert.equal(built.messages[1].content[0].input.input, 'raw patch');
    const restored = anthropicToResponse({ content: [{ type: 'tool_use', id: 'ct', name: 'apply_patch', input: { input: 'next patch' } }], usage: { input_tokens: 10, output_tokens: 2 } }, client);
    assert.equal(restored.output[0].type, 'custom_tool_call'); assert.equal(restored.output[0].input, 'next patch'); assert.equal(restored.usage.total_tokens, 12);
    assert.throws(() => responsesToAnthropic(request({ input: [opaque] })), /cannot be translated/);
    assert.throws(() => responsesToAnthropic(request({ previous_response_id: 'resp_old' })), /full input history/);
  });
  check('Responses reconstruction supplies ordered envelopes, calls, text, terminal output and real usage', () => {
    const response = reply([textItem('OK'), call('run')]);
    const events = [...responseEvents(response)].map(text => JSON.parse(text.split('data: ')[1]));
    assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed');
    assert.deepEqual(events.at(-1).response, response); assert.ok(events.some(item => item.type === 'response.function_call_arguments.delta'));
    assert.deepEqual(events.map(item => item.sequence_number), events.map((_, index) => index));
  });
  check('Codex applied TOML uses a local /v1 endpoint and never mutates the provider template', () => {
    const source = 'model_provider = "OpenAI"\n[model_providers.OpenAI]\nbase_url = "https://upstream.test/v1"\nexperimental_bearer_token = ""\n';
    const endpoint = { baseUrl: 'http://127.0.0.1:1234/providers/codex/v1', key: 'vscodemodelswitch-local' };
    const local = proxyClientConfig(source, endpoint, 'codex');
    assert.match(local, /base_url = "http:\/\/127.0.0.1:1234\/providers\/codex\/v1"/); assert.match(source, /upstream.test/);
    assert.equal(managedProxyId(endpoint.baseUrl, endpoint.key), 'codex');
  });

  let queue = [], offered = [], webHits = [], cancelled = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      webHits.push(req.headers);
      if (req.url === '/image') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgo=', 'base64')); }
      else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>LOCAL_WEB_RESULT</h1>'); }
      return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    offered.push({ payload: JSON.parse(Buffer.concat(chunks)), headers: req.headers, url: req.url });
    const item = queue.shift() ?? { response: reply() };
    if (item.delay) await new Promise(resolve => { const timer = setTimeout(resolve, item.delay); res.once('close', () => { if (!res.writableEnded) cancelled++; clearTimeout(timer); resolve(); }); });
    if (res.destroyed) return;
    res.writeHead(item.status ?? 200, { 'content-type': item.sse ? 'text/event-stream' : 'application/json' });
    if (item.sse) { res.write(item.sse.slice(0, 53)); await new Promise(resolve => setTimeout(resolve, 2)); res.end(item.sse.slice(53)); }
    else res.end(JSON.stringify(item.response ?? { error: { message: item.error ?? 'synthetic upstream failure' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port, proxy = new ProxyServer();
  const endpoint = await proxy.register('native', base + '/api/v1', 'synthetic-codex-key', 'mock-model', cfg({ maxAttempts: 2, maxOutputTokens: 500, headers: { 'x-custom': 'test' }, parameters: { reasoning: { effort: 'high' } }, keepAliveMs: 100 }), 'codex');
  const send = async (payload, ep = endpoint, signal) => {
    const response = await fetch(ep.baseUrl + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + ep.key, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
    return { response, text: await response.text() };
  };
  try {
    let result = await send(request({ max_output_tokens: 2000 }));
    check('native wire path/auth/headers/reasoning/output cap reach the upstream', () => {
      assert.equal(JSON.parse(result.text).status, 'completed'); assert.equal(JSON.parse(result.text).id, 'resp_mock'); assert.equal(offered.at(-1).url, '/api/v1/responses');
      assert.equal(offered.at(-1).headers.authorization, 'Bearer synthetic-codex-key'); assert.equal(offered.at(-1).headers['x-custom'], 'test');
      assert.equal(offered.at(-1).payload.reasoning.effort, 'high'); assert.equal(offered.at(-1).payload.max_output_tokens, 500);
    });
    queue = [{ status: 503 }, { response: reply() }]; await send(request());
    check('Responses retries transient HTTP failures within the configured maximum', () => assert.equal(proxy.runtime('native').retries, 1));
    const before = offered.length; queue = [{ status: 401, error: 'bad synthetic-codex-key' }]; result = await send(request());
    check('Responses authentication failures are not retried and credentials are redacted', () => { assert.equal(offered.length, before + 1); assert.equal(result.response.status, 401); assert.doesNotMatch(result.text, /synthetic-codex-key/); });
    queue = [{ response: reply(), delay: 150 }]; result = await send(request({ stream: true }));
    check('reconstructed Responses SSE has stable identity, usage and protocol-neutral keepalives', () => {
      assert.match(result.text, /: keepalive/); assert.doesNotMatch(result.text, /message_start/);
      const events = result.text.split('\n\n').filter(frame => frame.includes('data:')).map(frame => JSON.parse(frame.split('\ndata: ')[1]));
      assert.equal(events[0].response.id, 'resp_mock'); assert.equal(events[0].response.id, events.at(-1).response.id); assert.equal(events.at(-1).response.usage.total_tokens, 12);
    });
    result = await send(request({ previous_response_id: 'resp_mock', input: 'Continue' }));
    check('native response identity remains usable for previous_response_id', () => { assert.equal(JSON.parse(result.text).id, 'resp_mock'); assert.equal(offered.at(-1).payload.previous_response_id, 'resp_mock'); });
    queue = [{ response: reply([opaque]) }]; result = await send(request({ stream: true }));
    check('HTTP200 with reasoning-only output emits response.failed and increments failed requests', () => { assert.match(result.text, /response.failed/); assert.doesNotMatch(result.text, /event: response.completed/); assert.equal(proxy.runtime('native').lastRequest.ok, false); });
    const direct = await proxy.register('pass', base, 'synthetic-stream-key', 'mock-model', cfg({ rebuildStream: false, repairToolJson: false, maxAttempts: 2 }), 'codex');
    queue = [{ status: 503 }, { sse: [...responseEvents(reply())].join('') }]; result = await send(request({ stream: true }), direct);
    check('native SSE forwarding parses fragmented frames and retries only before the body starts', () => { assert.equal((result.text.match(/event: response.created/g) ?? []).length, 1); assert.match(result.text, /event: response.completed/); assert.equal(proxy.runtime('pass').retries, 1); });
    queue = [{ sse: frame({ type: 'response.created', sequence_number: 0, response: {} }) }]; result = await send(request({ stream: true }), direct);
    check('premature Responses EOF is a model failure', () => { assert.match(result.text, /response.failed/); assert.equal(proxy.runtime('pass').lastRequest.ok, false); });
    const bridge = await proxy.register('bridge', base, 'synthetic-bridge-key', 'claude-test', cfg({ nativeToolMap: { run: 'exec' }, maxThinkingBudget: 1500, parameters: { thinking: { type: 'enabled', budget_tokens: 2000 } }, maxOutputTokens: 4000 }, 'anthropic'), 'codex');
    queue = [{ response: { content: [{ type: 'tool_use', id: 'call_bridge', name: 'exec', input: { command: 'test' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } } }];
    result = await send(request({ stream: true, tools: [tool('run')], max_output_tokens: 8000 }), bridge);
    check('Codex Anthropic bridge applies real thinking budgets/tool maps and returns Responses calls', () => {
      assert.equal(offered.at(-1).url, '/v1/messages'); assert.equal(offered.at(-1).payload.thinking.budget_tokens, 1500); assert.equal(offered.at(-1).payload.max_tokens, 4000);
      assert.match(result.text, /"name":"run"/); assert.match(result.text, /response.function_call_arguments.delta/); assert.match(result.text, /response.completed/);
    });
    const web = await proxy.register('web', base, 'synthetic-web-key', 'mock-model', cfg({ webTools: true }), 'codex');
    queue = [{ response: reply([call('WebFetch', JSON.stringify({ url: base + '/web' }))]) }, { response: reply([textItem('Page seen')]) }];
    result = await send(request(), web);
    check('Responses web tools execute locally and feed actual page content into the next model round', () => {
      assert.match(result.text, /Page seen/); assert.match(JSON.stringify(offered.at(-1).payload.input.at(-1)), /LOCAL_WEB_RESULT/); assert.equal(webHits.at(-1).authorization, undefined);
    });
    queue = [{ response: reply([call('fetch_image', JSON.stringify({ url: base + '/image' }))]) }, { response: reply() }];
    await send(request(), web);
    check('Responses fetch_image retains a real image content block in tool output', () => assert.match(offered.at(-1).payload.input.at(-1).output.find(part => part.type === 'input_image').image_url, /^data:image\/png;base64,/));
    const timeout = await proxy.register('timeout', base, 'synthetic-timeout-key', 'mock-model', cfg({ timeoutMs: 1000 }), 'codex');
    queue = [{ response: reply(), delay: 1500 }]; result = await send(request(), timeout);
    check('Responses timeout aborts the upstream and produces a failed request', () => { assert.equal(result.response.status, 504); assert.equal(proxy.runtime('timeout').lastRequest.ok, false); });
    queue = [{ response: reply(), delay: 1500 }];
    const controller = new AbortController(), pending = fetch(endpoint.baseUrl + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.key }, body: JSON.stringify(request({ stream: true })), signal: controller.signal });
    const response = await pending; await new Promise(resolve => setTimeout(resolve, 25)); controller.abort(); await response.text().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 30));
    check('Responses client cancellation closes the upstream request', () => assert.ok(cancelled >= 2));
  } finally { proxy.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log(`RESULT: ${passed} passed, 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
