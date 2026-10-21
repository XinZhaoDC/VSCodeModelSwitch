'use strict';
// No provider credentials or internet access: all HTTP listeners bind to loopback.
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');

const { ProxyServer } = require('../out/proxy/server');
const { proxyDefaults, normalizeProxyConfig } = require('../out/proxy/config');
const { buildPayload, parseToolJson, processMessage, trimHistory } = require('../out/proxy/protocol');
const { proxyClientConfig, managedProxyId } = require('../out/proxy/applied');
const { requestHttp } = require('../out/proxy/transport');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const config = (overrides = {}) => ({ mode: 'proxy', preset: 'justdowork', overrides: { webTools: false, cacheSystemPrefix: false, ...overrides } });
const options = { ...proxyDefaults('justdowork'), webTools: false, cacheSystemPrefix: false };
const client = (extra = {}) => ({ model: 'test-model', max_tokens: 256, messages: [{ role: 'user', content: 'Hello' }], ...extra });

class Memento {
  constructor(values = {}) { this.values = values; }
  get(key, fallback) { return this.values[key] ?? fallback; }
  async update(key, value) { if (this.failOnceKey === key) { this.failOnceKey = undefined; throw new Error('Synthetic metadata write failure'); } this.values[key] = value; }
  setKeysForSync() {}
}
const disposable = () => ({ dispose() {} });
const logs = [];
const settings = { globalCliSync: true, configTarget: 'sandbox', anthropicVersion: '2023-06-01' };
const vscode = {
  window: {
    createOutputChannel: () => ({ info: s => logs.push(s), warn: s => logs.push(s), error: s => logs.push(s), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: disposable,
    showInformationMessage: async () => {}, showWarningMessage: async () => {}, showErrorMessage: async () => {},
    withProgress: async (_options, callback) => callback({ report() {} }, { isCancellationRequested: false, onCancellationRequested: disposable })
  },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
    createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }) },
  commands: { registerCommand: disposable }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
  RelativePattern: class {}, Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
};
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };

let appliedClaude = {}, appliedCodex = {}, failWrite = false, writes = 0;
const sandboxRoot = path.join(__dirname, 'proxy-test-sandbox');
const { ClaudeAdapter } = require('../out/adapters/claudeAdapter');
const { CodexAdapter } = require('../out/adapters/codexAdapter');
ClaudeAdapter.prototype.getConfigPath = () => path.join(sandboxRoot, '.claude/settings.json');
ClaudeAdapter.prototype.readActiveConfig = async () => ({ baseUrl: appliedClaude.env?.ANTHROPIC_BASE_URL, key: appliedClaude.env?.ANTHROPIC_AUTH_TOKEN, model: appliedClaude.model });
ClaudeAdapter.prototype.apply = async function (resolved) {
  if (failWrite) throw new Error('Synthetic configuration write failure');
  appliedClaude = JSON.parse(resolved.claude.configText);
  appliedClaude.env.ANTHROPIC_AUTH_TOKEN = resolved.claude.key;
  writes++;
};
CodexAdapter.prototype.getConfigPath = () => path.join(sandboxRoot, '.codex/config.toml');
CodexAdapter.prototype.readActiveConfig = async () => appliedCodex;
CodexAdapter.prototype.apply = async resolved => { appliedCodex = { baseUrl: resolved.codex.baseUrl, key: resolved.codex.key, model: resolved.codex.model }; };
const { VSModelSwitchApp } = require('../out/app');
const { SidebarViewProvider } = require('../out/ui/sidebarView');
const { verifyModel } = require('../out/models/compatibilityCheck');

function context(globalState = new Memento(), workspaceState = new Memento(), secretMap = new Map()) {
  return { globalState, workspaceState, subscriptions: [], extensionUri: vscode.Uri.file(path.join(__dirname, '..')), logUri: vscode.Uri.file(path.join(sandboxRoot, 'log')),
    secrets: { get: async key => secretMap.get(key), store: async (key, value) => { secretMap.set(key, value); }, delete: async key => { secretMap.delete(key); } },
    environmentVariableCollection: { delete() {}, replace() {} } };
}

async function main() {
  const originalFetch = global.fetch;
  let fetchTransportCalled = false;
  global.fetch = async (_url, init) => {
    fetchTransportCalled = true;
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ transport: 'fetch' }), { status: 200, headers: { 'x-transport': 'fetch' } });
  };
  const fetchedReply = await requestHttp('https://host-proxy.test/v1/messages', 'POST', { 'content-type': 'application/json' }, Buffer.from('{}'), new AbortController().signal);
  global.fetch = originalFetch;
  check('shared upstream transport uses extension-host fetch and preserves the response', () => {
    assert.equal(fetchTransportCalled, true);
    assert.equal(fetchedReply.status, 200);
    assert.equal(fetchedReply.headers['x-transport'], 'fetch');
    assert.equal(fetchedReply.body.toString(), '{"transport":"fetch"}');
  });
  check('valid JSON is unchanged, multiline/invalid escapes/trailing comma are repaired', () => {
    assert.deepEqual(parseToolJson('{"x":"a\\nb"}'), { x: 'a\nb' });
    assert.deepEqual(parseToolJson('{"x":"a\nb","regex":"\\d+",}'), { x: 'a\nb', regex: '\\d+' });
    assert.deepEqual(parseToolJson('{"x":1'), { x: 1 });
    assert.equal(parseToolJson('{"x":1', false), undefined);
  });
  check('provider overrides are separate from presets and validate authentication metadata', () => {
    assert.equal(normalizeProxyConfig(undefined, 'claude').mode, 'direct');
    assert.deepEqual(normalizeProxyConfig({ mode: 'proxy', preset: 'justdowork', overrides: { maxAttempts: 3, timeoutMs: 5000 } }, 'claude').overrides, { timeoutMs: 5000 });
    assert.throws(() => normalizeProxyConfig(config(), 'codex'));
    assert.throws(() => normalizeProxyConfig(config({ headers: { Authorization: 'secret' } }), 'claude'));
    assert.throws(() => normalizeProxyConfig(config({ parameters: { model: 'override' } }), 'claude'));
  });
  check('native tool maps and forced emulated tools preserve real schemas', () => {
    const payload = buildPayload(client({ tools: [{ name: 'Read', input_schema: { type: 'object' } }, { name: 'Grep', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'Grep' } }), options).payload;
    assert.equal(payload.tools, undefined); assert.match(payload.system, /requires a call to Grep/);
    assert.equal(payload.max_tokens, 256); // no hidden output inflation
    const native = buildPayload(client({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] }), options).payload;
    assert.equal(native.tools[0].name, 'read'); assert.deepEqual(native.tools[0].input_schema, { type: 'object' });
  });
  check('history trimming preserves complete tool pairs and marks gaps', () => {
    const history = [{ role: 'user', content: 'Original instructions' }];
    for (let i = 0; i < 20; i++) history.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't' + i, name: 'read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'x'.repeat(500) }] });
    const result = trimHistory(history, 1800);
    assert.ok(result.dropped > 0); assert.equal(result.messages[0].content, 'Original instructions');
    assert.match(JSON.stringify(result.messages), /context gap/);
    const ids = new Set(result.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.id) : []));
    for (const m of result.messages) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result') assert.ok(ids.has(b.tool_use_id));
  });
  check('tool output limits leave images intact and label missing text', () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/img' } };
    const req = client({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x'.repeat(100) }, image] }] }] });
    const built = buildPayload(req, { ...options, maxToolResultChars: 10 });
    assert.deepEqual(built.payload.messages[0].content[0].content[1], image);
    assert.match(built.payload.messages[0].content[0].content[0].text, /omitted 90/);
  });
  check('thinking-only responses fail and native stop_reason is retained', () => {
    assert.throws(() => processMessage({ content: [{ type: 'thinking', thinking: 'only' }] }, client(), options, new Set()), /without an answer/);
    assert.equal(processMessage({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }, client(), options, new Set()).stop_reason, 'max_tokens');
  });
  check('generated local config does not mutate upstream config', () => {
    const source = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://upstream.invalid' }, model: 'test' });
    const local = proxyClientConfig(source, { baseUrl: 'http://127.0.0.1:1234/providers/a', key: 'vscodemodelswitch-local' });
    assert.equal(JSON.parse(source).env.ANTHROPIC_BASE_URL, 'https://upstream.invalid');
    assert.equal(JSON.parse(local).env.ENABLE_TOOL_SEARCH, 'false');
    assert.equal(managedProxyId('http://127.0.0.1:1234/providers/a', 'vscodemodelswitch-local'), 'a');
    assert.equal(managedProxyId('https://upstream.invalid/providers/a', 'vscodemodelswitch-local'), undefined);
  });

  let script = [], offered = [], delay = 0, aborted = false, webRequests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      webRequests.push({ url: req.url, headers: req.headers });
      if (req.url === '/image') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgo=', 'base64')); }
      else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><style>hidden style</style><h1>Visible title</h1><script>hidden script</script><p>Body &amp; text</p></html>'); }
      return;
    }
    const chunks = []; for await (const part of req) chunks.push(part);
    const payload = JSON.parse(Buffer.concat(chunks)); offered.push({ payload, headers: req.headers });
    const item = script.shift() ?? { text: 'OK' };
    if (delay) { res.on('close', () => { if (!res.writableEnded) aborted = true; }); await new Promise(resolve => setTimeout(resolve, delay)); }
    if (res.destroyed) return;
    if (typeof item === 'number') { res.writeHead(item); res.end(item === 403 ? '' : JSON.stringify({ error: { message: 'all nodes exhausted' } })); return; }
    if (item.sse) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(item.sse); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_upstream', type: 'message', role: 'assistant', model: payload.model,
      content: item.content ?? [{ type: 'text', text: item.text }], stop_reason: item.stop_reason ?? 'end_turn', usage: { input_tokens: 12, output_tokens: 2 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const proxy = new ProxyServer();
  const endpoint = await proxy.register('alpha', base, 'synthetic-secret-a', 'test-model', config({ keepAliveMs: 100 }));
  const send = async (payload, ep = endpoint) => {
    const r = await fetch(ep.baseUrl + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ep.key }, body: JSON.stringify(payload) });
    return { response: r, text: await r.text() };
  };
  try {
    let out = await send(client({ stream: true }));
    check('reconstructed SSE delivers ordered text and final events with original usage', () => {
      assert.equal(out.response.status, 200); assert.match(out.text, /event: ping/); assert.match(out.text, /text_delta/); assert.match(out.text, /"text":"OK"/); assert.match(out.text, /event: message_stop/);
      assert.equal(offered[0].payload.stream, false); assert.equal(offered[0].headers['x-api-key'], 'synthetic-secret-a');
    });
    script = [{ content: [{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/synthetic' } }] }];
    out = await send(client({ stream: true, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }));
    check('native lowercase tool is restored to Claude client name', () => { assert.match(out.text, /"name":"Read"/); assert.match(out.text, /input_json_delta/); assert.match(out.text, /"stop_reason":"tool_use"/); });
    script = [{ text: '<tool_call name="Grep">{"pattern":"one\ntwo"}</tool_call>' }];
    out = await send(client({ stream: false, tools: [{ name: 'Grep', input_schema: { type: 'object' } }] }));
    check('emulated tool JSON becomes a structured tool_use', () => { const body = JSON.parse(out.text); assert.equal(body.content[0].name, 'Grep'); assert.equal(body.content[0].input.pattern, 'one\ntwo'); });
    script = [503, 403, { text: 'OK' }];
    out = await send(client({ stream: true }));
    check('default bounded retries recover transient 503 and empty JDW403', () => { assert.match(out.text, /message_stop/); assert.equal(proxy.runtime('alpha').retries, 2); });
    script = [503, 503, 503];
    out = await send(client({ stream: true }));
    check('HTTP200 plus SSE error is a failed model request', () => { assert.equal(out.response.status, 200); assert.match(out.text, /event: error/); assert.doesNotMatch(out.text, /event: message_stop/); assert.equal(proxy.runtime('alpha').lastRequest.ok, false); assert.equal(proxy.runtime('alpha').lastRequest.status, 503); });
    script = [401]; offered = [];
    out = await send(client());
    check('authentication failure is not blindly retried', () => { assert.equal(out.response.status, 401); assert.equal(offered.length, 1); });
    const beta = await proxy.register('beta', base, 'synthetic-secret-b', 'test-model-b', config());
    offered = []; await send(client(), beta); await send(client());
    check('provider route isolation keeps keys and endpoint identity separate', () => { assert.notEqual(beta.baseUrl, endpoint.baseUrl); assert.equal(offered[0].headers['x-api-key'], 'synthetic-secret-b'); assert.equal(offered[1].headers['x-api-key'], 'synthetic-secret-a'); });
    const staged = await proxy.register('alpha', base, 'staged-key', 'staged-model', config()); staged.rollback();
    offered = []; await send(client());
    check('failed Apply can roll a staged route back', () => assert.equal(offered[0].headers['x-api-key'], 'synthetic-secret-a'));
    proxy.stopRoute('alpha'); out = await send(client());
    check('stopped route returns an actionable error and can resume unchanged', () => { assert.equal(out.response.status, 503); assert.equal(proxy.resumeRoute('alpha'), true); });
    delay = 150; out = await send(client({ stream: true })); delay = 0;
    check('long wait sends repeated keepalive events', () => assert.ok((out.text.match(/event: ping/g) || []).length >= 2));
    // Claude Verify tries the standard body and the adaptive-thinking
    // fallback; exhaust both proxy retry windows before asserting failure.
    script = [503, 503, 503, 503, 503, 503];
    let verified = await verifyModel('claude', endpoint.baseUrl, endpoint.key, 'test-model', undefined, config());
    check('Verify Model rejects an SSE error even when HTTP is 200', () => { assert.equal(verified.ok, false); assert.match(verified.error, /all nodes exhausted/); });
    verified = await verifyModel('claude', endpoint.baseUrl, endpoint.key, 'test-model', undefined, config());
    check('Verify Model checks the actual text and terminal event', () => assert.equal(verified.ok, true));
    const passthrough = await proxy.register('native-stream', base, 'synthetic-secret-c', 'test-model', { mode: 'proxy', preset: 'custom', overrides: { rebuildStream: false, maxAttempts: 2 } });
    const frame = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
    const nativeStream = frame('message_start', { message: {} }) + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }) + frame('message_stop', {});
    script = [503, { sse: nativeStream }]; out = await send(client({ stream: true }), passthrough);
    check('custom native SSE mode retries headers then forwards a complete stream', () => { assert.match(out.text, /"text":"OK"/); assert.equal((out.text.match(/event: message_start/g) || []).length, 1); assert.match(out.text, /event: message_stop/); assert.equal(proxy.runtime('native-stream').retries, 1); });
    script = [{ sse: frame('content_block_delta', { delta: { type: 'text_delta', text: 'partial' } }) }]; out = await send(client({ stream: true }), passthrough);
    check('native SSE mode rejects an incomplete stream', () => { assert.match(out.text, /event: error/); assert.equal(proxy.runtime('native-stream').lastRequest.ok, false); });
    const webProxy = await proxy.register('web-tools', base, 'synthetic-secret-web', 'test-model', config({ webTools: true, maxAttempts: 1 }));
    script = [{ text: '<tool_call name="WebFetch">' + JSON.stringify({ url: base + '/web' }) + '</tool_call>' }, { text: 'Web result seen' }];
    offered = []; out = await send(client({ stream: true }), webProxy);
    check('WebFetch executes locally and returns page text to the model before its final answer', () => { assert.match(out.text, /Web result seen/); assert.equal(offered.length, 2); const text = JSON.stringify(offered[1].payload.messages.at(-1)); assert.match(text, /Visible title/); assert.doesNotMatch(text, /hidden script/); assert.equal(webRequests.at(-1).headers.authorization, undefined); assert.equal(webRequests.at(-1).headers['x-api-key'], undefined); });
    script = [{ text: '<tool_call name="fetch_image">' + JSON.stringify({ url: base + '/image' }) + '</tool_call>' }, { text: 'Image seen' }];
    offered = []; out = await send(client(), webProxy);
    check('fetch_image feeds a structured image to the model and returns its final answer', () => { assert.match(out.text, /Image seen/); const image = offered[1].payload.messages.at(-1).content.find(b => b.type === 'image'); assert.equal(image.source.media_type, 'image/png'); assert.equal(image.source.data, 'iVBORw0KGgo='); });
    script = [{ content: [{ type: 'tool_use', id: 'read-pending', name: 'read', input: { file_path: '/synthetic' } }, { type: 'tool_use', id: 'web-pending', name: 'WebFetch', input: { url: base + '/web' } }] }];
    offered = []; const beforeWeb = webRequests.length; out = await send(client({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] }), webProxy);
    check('mixed web/client tool batches preserve the client call and defer web work explicitly', () => { const result = JSON.parse(out.text); assert.equal(result.content[0].name, 'Read'); assert.equal(result.content[0].id, 'read-pending'); assert.equal(result.stop_reason, 'tool_use'); assert.match(JSON.stringify(result.content), /deferred web requests/); assert.equal(offered.length, 1); assert.equal(webRequests.length, beforeWeb); });
    delay = 300; const cancel = new AbortController();
    const pending = fetch(endpoint.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': endpoint.key, 'content-type': 'application/json' }, body: JSON.stringify(client({ stream: true })), signal: cancel.signal });
    const response = await pending; await new Promise(resolve => setTimeout(resolve, 20)); cancel.abort(); await response.text().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 30)); delay = 0;
    check('client disconnect cancels the upstream socket', () => assert.equal(aborted, true));

    await testApplication(base, offered, () => { offered = []; }, () => offered, config);
    await testUnsyncedApplication(base, config);
    testUi();
    check('diagnostics contain no upstream test key', () => assert.ok(logs.every(line => !line.includes('synthetic-secret'))));
  } finally {
    proxy.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  console.log(`RESULT: ${passed} passed, 0 failed`);
}

async function testApplication(base, _offered, clear, offered, config) {
  const ctx = context(), app = new VSModelSwitchApp(ctx);
  await new Promise(resolve => setImmediate(resolve));
  try {
    await app.createProviderFromSidebar({ tool: 'claude', name: 'Alpha', baseUrl: base, key: 'synthetic-secret-a', model: 'test-model', applyNow: true, proxy: config() });
    let state = await app.getSidebarState(), alpha = state.providers.find(p => p.name === 'Alpha');
    const endpoint = { baseUrl: appliedClaude.env.ANTHROPIC_BASE_URL, key: appliedClaude.env.ANTHROPIC_AUTH_TOKEN };
    check('Apply starts a proxy and persists only local credentials in client config', () => { assert.equal(alpha.proxyRuntime.state, 'running'); assert.equal(endpoint.key, 'vscodemodelswitch-local'); assert.equal(state.currentProviderIds.claude, alpha.id); assert.equal(JSON.stringify(appliedClaude).includes('synthetic-secret'), false); });
    const edit = await app.getProviderConfigFromSidebar(alpha.id);
    const beforeWrites = writes;
    await app.saveProviderConfigFromSidebar(alpha.id, edit.text, undefined, undefined, undefined, config({ parameters: { temperature: 0.7 } }));
    state = await app.getSidebarState(); alpha = state.providers.find(p => p.id === alpha.id);
    clear();
    let response = await fetch(endpoint.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': endpoint.key, 'content-type': 'application/json' }, body: JSON.stringify(client()) }); await response.text();
    check('Save marks Pending Apply without changing config or the running route', () => { assert.equal(writes, beforeWrites); assert.equal(alpha.needsApply, true); assert.equal(offered().at(-1).payload.temperature, undefined); });
    await app.verifyProviderModelFromSidebar(alpha.id);
    check('Verify uses the edited settings in a temporary route', () => assert.equal(offered().at(-1).payload.temperature, 0.7));
    clear(); response = await fetch(endpoint.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': endpoint.key, 'content-type': 'application/json' }, body: JSON.stringify(client()) }); await response.text();
    check('Verify does not alter the already applied route', () => assert.equal(offered().at(-1).payload.temperature, undefined));
    const oldWrites = writes, oldRecord = ctx.workspaceState.get('vscodemodelswitch.appliedProxy');
    ctx.workspaceState.failOnceKey = 'vscodemodelswitch.appliedRevisions';
    await assert.rejects(() => app.applyProviderFromSidebar(alpha.id), /metadata write failure/);
    check('metadata persistence failure leaves the client file and applied snapshot unchanged', () => { assert.equal(writes, oldWrites); assert.equal(ctx.workspaceState.get('vscodemodelswitch.appliedProxy').provider.updatedAt, oldRecord.provider.updatedAt); assert.equal(appliedClaude.env.ANTHROPIC_BASE_URL, endpoint.baseUrl); });
    failWrite = true;
    await assert.rejects(() => app.applyProviderFromSidebar(alpha.id), /Synthetic/); failWrite = false;
    clear(); response = await fetch(endpoint.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': endpoint.key, 'content-type': 'application/json' }, body: JSON.stringify(client()) }); await response.text();
    check('failed configuration write preserves the prior active route and config', () => { assert.equal(offered().at(-1).payload.temperature, undefined); assert.equal(appliedClaude.env.ANTHROPIC_BASE_URL, endpoint.baseUrl); });
    await app.applyProviderFromSidebar(alpha.id);
    check('Apply clears the pending revision', () => assert.equal(app.appliedRevisions.get(alpha.id), app.store.getProvider(alpha.id).updatedAt));
    const shared = { globalState: ctx.globalState, workspaceState: ctx.workspaceState, secrets: ctx.secrets };
    app.dispose();
    const reloaded = new VSModelSwitchApp({ ...context(shared.globalState, shared.workspaceState), secrets: shared.secrets });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      const restored = await reloaded.getSidebarState();
      check('window reload restores the applied endpoint and provider identity', () => { assert.equal(restored.currentProviderIds.claude, alpha.id); assert.equal(restored.providers.find(p => p.id === alpha.id).proxyRuntime.localUrl, endpoint.baseUrl); assert.equal(restored.providers.find(p => p.id === alpha.id).proxyRuntime.state, 'running'); });
      const currentEdit = await reloaded.getProviderConfigFromSidebar(alpha.id);
      await reloaded.saveProviderConfigFromSidebar(alpha.id, currentEdit.text, undefined, undefined, undefined, { mode: 'direct', preset: 'justdowork' });
      await reloaded.applyProviderFromSidebar(alpha.id);
      check('existing provider can disable proxy and return to its real upstream', () => { assert.equal(appliedClaude.env.ANTHROPIC_BASE_URL, base); assert.equal(appliedClaude.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-secret-a'); });
    } finally { reloaded.dispose(); }
  } finally { app.dispose(); failWrite = false; }
}

async function testUnsyncedApplication(base, config) {
  settings.globalCliSync = false;
  const ctx = context(), app = new VSModelSwitchApp(ctx), before = writes;
  try {
    await new Promise(resolve => setImmediate(resolve));
    await app.createProviderFromSidebar({ tool: 'claude', name: 'Unsynced', baseUrl: base, key: 'synthetic-secret-unsynced', model: 'unsynced-model', applyNow: true, proxy: config() });
    const state = await app.getSidebarState();
    check('terminal-only mode keeps its active identity/model without rewriting global config', () => { assert.equal(writes, before); assert.equal(state.currentProviderIds.claude, state.providers[0].id); assert.equal(state.apiStatuses.find(row => row.tool === 'claude').model, 'unsynced-model'); assert.equal(app.lastEnv.ANTHROPIC_AUTH_TOKEN, 'vscodemodelswitch-local'); });
    app.dispose();
    const reloaded = new VSModelSwitchApp({ ...context(ctx.globalState, ctx.workspaceState), secrets: ctx.secrets });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      const restored = await reloaded.getSidebarState();
      check('terminal-only proxy state restores without overwriting unrelated global config', () => { assert.equal(writes, before); assert.equal(restored.providers[0].proxyRuntime.state, 'running'); assert.equal(restored.apiStatuses.find(row => row.tool === 'claude').model, 'unsynced-model'); });
    } finally { reloaded.dispose(); }
  } finally { app.dispose(); settings.globalCliSync = true; }
}

function testUi() {
  const html = new SidebarViewProvider(vscode.Uri.file('/extension'), {}).getHtml();
  const elements = new Map(), messages = [], listeners = {};
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.value = ''; this.type = ''; this.checked = false; this.disabled = false; this.hidden = false; this.children = []; this.listeners = {}; this.options = []; this.selectedIndex = 0; this.style = {}; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text || ''; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    scrollIntoView() {} focus() {} setAttribute() {}
  }
  for (const match of html.matchAll(/<(input|select|textarea|button|div|form|section|datalist|details)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.type = /type="([^"]+)"/.exec(match[0])?.[1] || '';
    element.value = /value="([^"]*)"/.exec(match[0])?.[1] || ''; elements.set(match[2], element);
  }
  for (const match of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const element = elements.get(match[1]);
    element.options = [...match[2].matchAll(/<option value="([^"]+)"/g)].map(m => ({ value: m[1], disabled: false })); element.value = element.options[0]?.value || '';
  }
  const document = { getElementById: id => { assert.ok(elements.has(id), 'Missing DOM id ' + id); return elements.get(id); }, createElement: tag => new Element(tag), querySelectorAll: () => [...elements.values()].filter(e => e.tagName === 'BUTTON') };
  const sandbox = { document, window: { addEventListener: (name, callback) => { listeners[name] = callback; }, setTimeout: () => {} }, acquireVsCodeApi: () => ({ postMessage: message => messages.push(message), getState: () => ({}), setState() {} }), console };
  vm.runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1], sandbox);
  const fire = message => listeners.message({ data: message });
  const form = prefix => (name => elements.get(prefix + 'Proxy' + name));
  fire({ type: 'configEditor', providerId: 'existing', tool: 'claude', text: '{"env":{}}', hasKey: true, proxy: config({ timeoutMs: 5000 }) });
  check('existing Config form loads connection, preset and advanced overrides', () => { assert.equal(form('edit')('Mode').value, 'proxy'); assert.equal(form('edit')('timeoutMs').value, '5000'); });
  form('edit')('timeoutMs').value = '6000'; elements.get('saveConfigButton').listeners.click();
  check('Config Save sends proxy metadata without an Apply action', () => { assert.equal(messages.at(-1).type, 'saveProviderConfig'); assert.equal(messages.at(-1).proxy.overrides.timeoutMs, 6000); });
  elements.get('cancelConfigButton').listeners.click();
  check('Cancel restores proxy settings as well as config text', () => assert.equal(form('edit')('timeoutMs').value, '5000'));
  form('edit')('Reset').listeners.click();
  check('Restore preset defaults removes provider-specific overrides', () => assert.equal(form('edit')('timeoutMs').value, '300000'));
  elements.get('providerName').value = 'New'; elements.get('baseUrl').value = 'https://upstream.invalid'; elements.get('apiKey').value = 'synthetic'; elements.get('modelSelect').value = 'model'; form('add')('Mode').value = 'proxy';
  elements.get('providerForm').listeners.submit({ preventDefault() {} });
  check('Add Provider form includes proxy settings with real upstream fields', () => { assert.equal(messages.at(-1).type, 'createProvider'); assert.equal(messages.at(-1).payload.proxy.mode, 'proxy'); assert.equal(messages.at(-1).payload.baseUrl, 'https://upstream.invalid'); });
  const provider = { id: 'existing', name: 'Existing', tool: 'claude', modelPolicy: { type: 'fixed', model: 'model' }, hasKey: true, proxy: config(), needsApply: true, proxyRuntime: { state: 'running', requests: 1, succeeded: 0, failed: 1, retries: 0, trimmedMessages: 0, lastRequest: { ok: false, status: 503, error: 'all nodes exhausted', durationMs: 5 } } };
  fire({ type: 'state', state: { providers: [provider], currentProviderIds: { claude: 'existing' }, apiStatuses: [], configPaths: {}, toolEnabled: { claude: true, codex: true }, storageSizes: {}, globalCliSync: true } });
  const allText = element => element.textContent + ' ' + element.children.map(allText).join(' ');
  check('card separates local Running, upstream failure and Pending Apply', () => { const text = allText(elements.get('claudeProviders')); assert.match(text, /Proxy: Running/); assert.match(text, /Failed · HTTP 503/); assert.match(text, /Pending Apply/); });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
