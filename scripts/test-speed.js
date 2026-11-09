'use strict';
// All requests below use loopback fixtures or a synthetic Codex executable.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SpeedMeasurement } = require('../out/speed/measurement');
const { measureApi } = require('../out/speed/api');
const { measureOfficialCodex } = require('../out/speed/codex');
const { runSpeedBenchmark } = require('../out/speed/runner');
const { SpeedStore, speedResultStatus } = require('../out/speed/store');
const { querySpeed } = require('../out/speed/query');

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = { tool: 'codex', mode: 'api', providerId: 'fixture', providerName: 'Fixture', model: 'gpt-test', configRevision: 'revision-1' };
const runnerOptions = { effort: 'low', timeoutMs: 5000, maxOutputTokens: 512 };
const disposable = () => ({ dispose() {} });
let copied = '';
const vscode = {
  workspace: { getConfiguration: () => ({ get: (name, fallback) => fallback }), workspaceFolders: [] },
  window: {
    withProgress: async (_options, callback) => callback({ report() {} }, { isCancellationRequested: false, onCancellationRequested: disposable }),
    showWarningMessage: async () => {}, showInformationMessage: async () => {}, showErrorMessage: async () => {}, showQuickPick: async () => 'codex'
  }, ProgressLocation: { Notification: 1 }, extensions: { getExtension: () => undefined },
  env: { clipboard: { writeText: async text => { copied = text; } } },
  Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { VSModelSwitchApp } = require('../out/app');
const { SidebarViewProvider } = require('../out/ui/sidebarView');
const { ProxyServer } = require('../out/proxy/server');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodemodelswitch-speed-test-'));
  console.log('RETAINED_FIXTURE: ' + directory);
  const fixtureText = 'Hello forest robots share synchronized observations and build a map.';
  const events = {
    anthropic: [
      { type: 'message_start', message: { model: 'claude-fixture', usage: { input_tokens: 23, cache_read_input_tokens: 3 } } },
      { type: 'ping' }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'not visible' } },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello forest ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'robots share synchronized observations and build a map.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } }, { type: 'message_stop' }
    ],
    responses: [
      { type: 'response.created', response: { model: 'gpt-fixture' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'not visible' },
      { type: 'response.output_text.delta', delta: 'Hello forest ' },
      { type: 'response.output_text.delta', delta: 'robots share synchronized observations and build a map.' },
      { type: 'response.completed', response: { status: 'completed', model: 'gpt-fixture', service_tier: 'default', usage: { input_tokens: 23, output_tokens: 30, output_tokens_details: { reasoning_tokens: 15 } } } }
    ],
    chat: [
      { model: 'gpt-fixture', choices: [{ delta: { role: 'assistant' } }] },
      { model: 'gpt-fixture', choices: [{ delta: { content: 'Hello forest ' } }] },
      { choices: [{ delta: { content: 'robots share synchronized observations and build a map.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 23, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 15 } } }, '[DONE]'
    ]
  };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ url: req.url, body });
      const route = req.url.split('/').filter(Boolean)[0];
      if (route === 'http-error') { res.writeHead(503); res.end('synthetic-secret must never be exported'); return; }
      if (route === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (route === 'upstream' && !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: fixtureText }], stop_reason: 'end_turn', usage: { input_tokens: 23, output_tokens: 15 } })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (route === 'slow') { const timer = setTimeout(() => res.end(), 5000); res.on('close', () => clearTimeout(timer)); return; }
      let frames = events[route === 'upstream' ? 'anthropic' : route] || events.responses;
      if (route === 'bad-json') { res.end('data: invalid\n\n'); return; }
      if (route === 'no-stop') frames = frames.slice(0, -1);
      if (route === 'incomplete') frames = [{ type: 'response.incomplete' }];
      if (route === 'tool') frames = [{ type: 'response.output_item.added', item: { type: 'function_call' } }];
      if (route === 'sse-error') frames = [{ type: 'error', error: { message: 'synthetic-secret' } }];
      for (const frame of frames) {
        if (res.destroyed) return;
        const data = Buffer.from('event: fixture\r\ndata: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\r\n\r\n');
        res.write(data.subarray(0, 7)); res.write(data.subarray(7, 21)); res.write(data.subarray(21));
        await sleep(8);
      }
      if (route === 'terminal-open') { const timer = setTimeout(() => res.end(), 5000); res.on('close', () => clearTimeout(timer)); }
      else res.end();
    } catch { if (!res.destroyed) res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = (route, protocol = 'responses', extra = {}) => measureApi({ protocol, url: base + '/' + route, headers: { Authorization: 'Bearer synthetic-key' }, model: 'gpt-test', effort: 'low', maxOutputTokens: 512, signal: new AbortController().signal, timingSource: 'native-stream', ...extra });
  let metrics;
  try {
    await test('meter ignores empty/whitespace prelude and excludes first batch', () => {
      const meter = new SpeedMeasurement(); meter.add(' ', 10); meter.add('Hello forest ', 1000); meter.add('robots share a map.', 2000);
      const value = meter.finish('gpt-fixture', 2500, 50, { outputTokens: 999 });
      assert.equal(value.ttftMs, 1000); assert.ok(value.generationTps > value.endToEndTps);
      assert.ok(value.visibleTextTokens < 999); assert.equal(value.usage.outputTokens, 999); assert.equal(value.initializationMs, 50);
    });
    await test('one batch and reconstructed streams have no generation rate', () => {
      const meter = new SpeedMeasurement(); meter.add('Hello forest', 100);
      assert.equal(meter.finish('claude-fixture', 100, 0).generationTps, null);
      meter.add(' more text', 1000); assert.equal(meter.finish('claude-fixture', 1000, 0, {}, 'buffered-proxy').generationTps, null);
    });
    for (const protocol of ['anthropic', 'responses', 'chat']) await test(protocol + ' fragmented SSE, actual model and usage', async () => {
      const value = await api(protocol, protocol); assert.ok(value.ttftMs > 0); assert.ok(value.totalMs >= value.ttftMs);
      assert.ok(value.generationTps > 0); assert.equal(value.usage.inputTokens, 23); assert.match(value.actualModel, /fixture/);
      if (protocol !== 'anthropic') assert.equal(value.usage.reasoningTokens, 15);
      else assert.equal(value.usage.cachedInputTokens, 3);
      metrics = value;
    });
    for (const route of ['http-error', 'json', 'bad-json', 'no-stop', 'incomplete', 'tool', 'sse-error']) await test('reject ' + route + ' without exposing remote body', async () => {
      await assert.rejects(api(route), error => !error.message.includes('synthetic-secret'));
    });
    await test('stop on terminal event even when server keeps connection open', async () => {
      const begin = Date.now(); await api('terminal-open'); assert.ok(Date.now() - begin < 2000);
    });
    await test('abort interrupts a silent SSE body', async () => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30);
      try { await assert.rejects(api('slow', 'responses', { signal: controller.signal })); } finally { clearTimeout(timer); }
    });
    await test('three samples run serially; requested parameters and actual models retained', async () => {
      let active = 0, maximum = 0;
      const report = await runSpeedBenchmark(target, 3, async () => { maximum = Math.max(maximum, ++active); await sleep(4); active--; return metrics; }, runnerOptions);
      assert.equal(maximum, 1); assert.equal(report.summary.succeeded, 3); assert.equal(report.summary.comparable, true);
      assert.equal(report.parameters.promptId, 'forest-sync-120-words-v1');
    });
    await test('one failed request stops remaining paid samples and preserves failure', async () => {
      let calls = 0;
      const report = await runSpeedBenchmark(target, 3, async () => { calls++; throw Error('synthetic failure'); }, runnerOptions);
      assert.equal(calls, 1); assert.equal(report.summary.failed, 1); assert.equal(report.summary.endToEndMedianTps, null); assert.equal(speedResultStatus(report), 'failed');
    });
    await test('cancelled request is excluded from success aggregates', async () => {
      const controller = new AbortController();
      const report = await runSpeedBenchmark(target, 3, async () => { controller.abort(); return metrics; }, { ...runnerOptions, signal: controller.signal });
      assert.equal(report.summary.cancelled, 1); assert.equal(speedResultStatus(report), 'cancelled'); assert.equal(report.summary.succeeded, 0);
    });
    await test('changed actual model never becomes a combined speed ranking', async () => {
      let index = 0;
      const report = await runSpeedBenchmark(target, 3, async () => ({ ...metrics, actualModel: 'model-' + index++ }), runnerOptions);
      assert.equal(report.summary.succeeded, 3); assert.equal(report.summary.endToEndMedianTps, null); assert.equal(speedResultStatus(report), 'mixed');
    });
    const store = new SpeedStore(path.join(directory, 'results'));
    const report = await runSpeedBenchmark(target, 1, async () => metrics, runnerOptions);
    await store.save(report); await store.writeCurrent({ updatedAt: new Date().toISOString(), tools: { codex: target } });
    await test('persistent current-target query is read-only and contains no text or key', async () => {
      const savedFetch = global.fetch; global.fetch = () => { throw Error('query attempted network'); };
      try { const result = await querySpeed(['--tool', 'codex'], store); assert.equal(result.status, 'fresh'); assert.equal(result.currentContextFresh, true); assert.ok(!JSON.stringify(result).includes('synthetic-key')); assert.ok(!JSON.stringify(result).includes(fixtureText)); } finally { global.fetch = savedFetch; }
    });
    await test('model/revision changes cannot return previous provider measurements as current', async () => {
      await store.writeCurrent({ updatedAt: new Date().toISOString(), tools: { codex: { ...target, configRevision: 'revision-2' } } });
      assert.equal((await querySpeed(['--tool', 'codex'], store)).status, 'unavailable');
      assert.equal((await querySpeed(['--tool', 'codex', '--provider-id', target.providerId], store)).scope, 'explicit-provider-history');
      await store.writeCurrent({ updatedAt: new Date().toISOString(), tools: { codex: { ...target, model: 'another-model' } } });
      assert.equal((await querySpeed(['--tool', 'codex'], store)).status, 'unavailable');
    });
    await test('freshness expires and stale current snapshots are labelled', async () => {
      assert.equal(speedResultStatus(report, Date.parse(report.finishedAt) + 16 * 60_000), 'stale');
      await store.writeCurrent({ updatedAt: '2020-01-01T00:00:00Z', tools: { codex: target } });
      assert.equal((await querySpeed(['--tool', 'codex'], store)).currentContextFresh, false);
    });
    await test('standalone CLI reads JSON without starting extension or model', async () => {
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../out/speed/query.js'), '--tool', 'codex', '--directory', store.directory]);
      assert.equal(JSON.parse(stdout).report.id, report.id);
    });
    const fakeScript = `const fs=require('fs');const readline=require('readline');const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{mcp_servers:{fixture:{enabled:true}}}};if(m.method==='thread/start'){if(!m.params.ephemeral||m.params.config.mcp_servers.fixture.enabled!==false)process.exit(9);result={thread:{id:'thread-fixture'},model:'gpt-official-fixture'};}if(m.method==='turn/start'){out({method:'item/agentMessage/delta',params:{threadId:'thread-fixture',delta:'Hello forest '}});setTimeout(()=>{out({method:'item/agentMessage/delta',params:{delta:'robots share a common map.'}});out({method:'thread/tokenUsage/updated',params:{tokenUsage:{last:{inputTokens:23,outputTokens:30,reasoningOutputTokens:15}}}});out({method:'turn/completed',params:{turn:{status:'completed'}}});out({id:m.id,result:{turn:{id:'turn-fixture'}}});},12);return;}out({id:m.id,result});});`;
    const executable = path.join(directory, 'fake-codex.cjs'); await fs.writeFile(executable, fakeScript);
    await test('official app-server handles early notifications, ephemeral thread, MCP disable and numeric usage', async () => {
      const result = await measureOfficialCodex(executable, 'auto', 'low', new AbortController().signal);
      assert.equal(result.actualModel, 'gpt-official-fixture'); assert.equal(result.usage.outputTokens, 30); assert.equal(result.usage.reasoningTokens, 15); assert.ok(result.initializationMs > 0);
    });
    await test('official login type mismatch fails without returning account information', async () => {
      const file = path.join(directory, 'fake-api.cjs'); await fs.writeFile(file, fakeScript.replace("type:'chatgpt'", "type:'apiKey',private:'synthetic-secret'"));
      await assert.rejects(measureOfficialCodex(file, 'auto', 'low', new AbortController().signal), error => /ChatGPT login/.test(error.message) && !error.message.includes('synthetic-secret'));
    });
    await test('official child uses the selected Codex home, including sandbox homes', async () => {
      const home = path.join(directory, 'selected-codex-home');
      const file = path.join(directory, 'fake-home.cjs');
      await fs.writeFile(file, `if(process.env.CODEX_HOME!==${JSON.stringify(home)})process.exit(9);` + fakeScript);
      assert.equal((await measureOfficialCodex(file, 'auto', 'low', new AbortController().signal, home)).actualModel, 'gpt-official-fixture');
    });
    await test('official cancellation interrupts initialization and exits the child', async () => {
      const file = path.join(directory, 'silent-codex.cjs'); await fs.writeFile(file, "process.stdin.resume();setInterval(()=>{},1000);");
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 50);
      try { await assert.rejects(measureOfficialCodex(file, 'auto', 'low', controller.signal)); } finally { clearTimeout(timer); }
    });
    await test('extension binary discovery supports the actual linux-x86_64 layout', async () => {
      const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
      const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
      const binary = path.join(directory, 'extension', 'bin', platform + '-' + arch, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await fs.mkdir(path.dirname(binary), { recursive: true }); await fs.writeFile(binary, 'fixture');
      vscode.extensions.getExtension = () => ({ extensionPath: path.join(directory, 'extension') });
      assert.equal(await Object.create(VSModelSwitchApp.prototype).codexSpeedExecutable(), binary);
      vscode.extensions.getExtension = () => undefined;
    });
    await test('sidebar emits both sample counts and read-only query actions', async () => {
      const actions = [];
      const sidebar = new SidebarViewProvider({ fsPath: path.join(__dirname, '..') }, { speedTestFromSidebar: async (...args) => actions.push(args), copySpeedQuery: async () => actions.push('query'), getSidebarState: async () => ({}) });
      const html = sidebar.getHtml();
      const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1]; new vm.Script(script);
      assert.match(html, /quickOfficialSpeedButton/); assert.match(html, /Standard Speed Test · Official/);
      assert.ok(!html.includes('copySpeedQueryButton'));
      await sidebar.handleMessage({ type: 'speedTest', providerId: 'fixture', runs: 3 });
      await sidebar.handleMessage({ type: 'copySpeedQuery' });
      assert.deepEqual(actions, [['fixture', 3], 'query']);
    });
    await test('compact diagnostic rows unify network, usage and speed while retaining states in Details', async () => {
      const sidebar = new SidebarViewProvider({ fsPath: path.join(__dirname, '..') }, {});
      const html = sidebar.getHtml();
      const script = html.match(/function formatNetwork\(result\) \{([\s\S]*?)\n    function post/)[0].replace(/\n    function post$/, '');
      const createElement = tag => ({ tag, children: [], listeners: {}, get textContent() { return this._text || ''; }, set textContent(value) { this._text = value; this.children = []; }, appendChild(node) { this.children.push(node); }, addEventListener(event, action) { this.listeners[event] = action; } });
      const actions = [];
      const context = { document: { createElement }, busy: false, post: message => actions.push(message) };
      const render = vm.runInNewContext(script + '; renderDiagnostics', context);
      const container = createElement('div');
      const text = node => [node.textContent, ...node.children.map(text)].join('\n');
      const format = value => { render(container, undefined, undefined, false, value); return text(container); };
      const visible = () => container.children.filter(node => node.tag !== 'details').map(text).join('\n');
      const screenshot = structuredClone(report);
      screenshot.parameters.runs = 3;
      Object.assign(screenshot.summary, { comparable: true, succeeded: 3, failed: 0, cancelled: 0, ttftMedianMs: 3400, generationMedianTps: 33.28, endToEndMedianTps: 18.36 });
      const normal = format(screenshot);
      for (const label of ['Output 33.28 tok/s', 'TTFT 3.40 s', 'Overall 18.36 tok/s', '3/3 passed', 'estimated', 'correct completed task', 'not live conversation monitoring']) assert.ok(normal.includes(label), label);
      assert.equal(container.children.filter(node => node.className === 'diagnosticRow').length, 1);
      const details = container.children.find(node => node.tag === 'details'); assert.ok(!details.open);
      assert.ok(!visible().includes('correct completed task'));
      assert.ok(!html.includes('speedCards')); assert.ok(!html.includes('.speedValue'));
      details.children.find(node => node.tag === 'button').listeners.click(); assert.equal(actions[0].type, 'copySpeedQuery');
      context.busy = true; format(screenshot); assert.equal(container.children.at(-1).children.find(node => node.tag === 'button').disabled, true); context.busy = false;
      const buffered = structuredClone(report); buffered.summary.generationMedianTps = null; buffered.rounds[0].metrics.timingSource = 'buffered-proxy';
      assert.match(format(buffered), /Output N\/A/); assert.match(visible(), /Buffered stream/);
      buffered.finishedAt = '2020-01-01T00:00:00Z'; format(buffered); assert.match(visible(), /Stale/);
      buffered.summary.comparable = false; format(buffered); assert.match(visible(), /Mixed conditions/);
      assert.ok(!visible().includes('33.28'));
      const failed = structuredClone(report); Object.assign(failed.summary, { succeeded: 0, failed: 1, cancelled: 1 });
      format(failed); assert.match(visible(), /1 failed/); assert.match(visible(), /1 cancelled/);
      assert.equal((visible().match(/N\/A/g) || []).length, 3);
      assert.equal(format(undefined), ''); assert.equal(container.children.length, 0);
      screenshot.rounds[0].metrics.actualModel = '<img src=x onerror=alert(1)>';
      assert.ok(format(screenshot).includes('<img src=x onerror=alert(1)>'));
      assert.ok(container.children.every(node => node.tag !== 'img'));
      const network = { ok: true, reachable: true, latencyMs: 123, httpStatus: 200, modelsApi: 'available', modelCount: 42, endpoint: 'https://fixture.invalid/v1/models', resolvedAddresses: ['192.0.2.1'], checkedAt: '2026-10-23T08:00:00Z' };
      const usage = { ok: true, remaining: 0, used: 12.34, total: 12.34, unit: 'USD', checkedAt: network.checkedAt };
      render(container, network, usage, true, screenshot);
      assert.deepEqual(container.children.filter(node => node.tag !== 'details').map(node => node.children[0].textContent), ['Network', 'Usage', 'Speed']);
      assert.match(visible(), /Reachable/); assert.match(visible(), /123 ms/); assert.match(visible(), /Remaining 0 USD/);
      assert.ok(!visible().includes(network.endpoint)); assert.ok(!visible().includes('192.0.2.1')); assert.ok(text(container.children.at(-1)).includes(network.endpoint));
      assert.equal(container.children.filter(node => node.tag === 'details').length, 1);
      render(container, { ...network, ok: false, httpStatus: 401, modelsApi: 'httpError' }, { ...usage, ok: false, httpStatus: 403, error: 'fixture error' }, true);
      assert.match(visible(), /Reachable/); assert.match(visible(), /Models error/); assert.match(visible(), /Unavailable/); assert.match(visible(), /HTTP 403/);
      render(container, { ...network, ok: false, reachable: false, failureStage: 'dns' }, undefined, false);
      assert.match(visible(), /Unreachable/); assert.match(visible(), /DNS error/); assert.match(visible(), /Not enabled/);
    });
    for (const buffered of [false, true]) await test('app ' + (buffered ? 'saved proxy' : 'direct') + ' benchmark does not Apply and removes its temporary route', async () => {
      const provider = { id: 'claude-fixture', name: 'Fixture', tool: 'claude', baseUrl: base + '/upstream', modelPolicy: { type: 'fixed', model: 'claude-fixture' }, updatedAt: '1', ...(buffered ? { proxy: { mode: 'proxy', preset: 'custom', overrides: { rebuildStream: true, webTools: false, cacheSystemPrefix: false, messagesPath: '/v1/messages' } } } : {}) };
      const app = Object.create(VSModelSwitchApp.prototype);
      app.store = { getProvider: id => id === provider.id ? provider : undefined, getToolEnabled: () => true };
      app.secretStore = { get: async () => 'synthetic-key' }; app.speedStore = new SpeedStore(path.join(directory, 'app-' + buffered));
      app.runtimeState = { claude: { matchedProviderId: provider.id, model: provider.modelPolicy.model }, codex: {} };
      app.appliedRevisions = new Map(); app.proxyServer = new ProxyServer(); app.refreshStatus = () => {}; app.outputChannel = { info() {} };
      app.context = { extensionUri: { fsPath: path.join(__dirname, '..') } };
      try {
        const first = app.speedTestFromSidebar(provider.id, 1);
        await assert.rejects(app.speedTestFromSidebar(provider.id, 1), /already running/);
        await first;
        const result = (await app.speedStore.readAll())[0]; assert.equal(result.summary.succeeded, 1);
        if (buffered) { assert.equal(result.rounds[0].metrics.generationTps, null); assert.equal(result.connection.mode, 'built-in-proxy'); }
        assert.equal(app.proxyServer.routes.size, 0); assert.equal(app.speedController, undefined);
        await app.copySpeedQuery(); assert.match(copied, /--directory/);
      } finally { app.proxyServer.dispose(); }
    });
    console.log('RESULT: ' + passed + ' passed, 0 failed');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
