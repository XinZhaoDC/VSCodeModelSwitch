'use strict';
// Synthetic API and terminal diagnostics; no user configuration or paid model.
const assert = require('node:assert/strict'), http = require('node:http'), Module = require('node:module');
const load = Module._load;
Module._load = function(n, ...args) { return n === 'vscode' ? {} : load.call(this, n, ...args); };
const transport = require('../out/network/transport');
const { fetchModels, testModelsEndpoint } = require('../out/models/modelFetcher');
const { verifyModel } = require('../out/models/compatibilityCheck');
const { queryUsage } = require('../out/models/usageQuery');
const { VSModelSwitchApp } = require('../out/app');
Module._load = load;
async function main() {
  let mode = 'ok', passed = 0; const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization }); req.resume(); res.setHeader('content-type', 'application/json');
    if (mode === 'unauthorized') { res.writeHead(401); res.end('{"error":"denied"}'); return; }
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'gpt-fixture' }, { id: 'gpt-fixture' }, { id: '' }, { id: 7 }] })); return; }
    if (req.url.endsWith('/responses')) { res.end(JSON.stringify({ id: 'resp-fixture', object: 'response', status: 'completed', output: mode === 'reasoning' ? [{ type: 'reasoning', summary: [] }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] })); return; }
    res.end(JSON.stringify({ data: { left: 1250, spent: 750, all: 2000 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port, base = 'http://diagnostic.fixture.invalid/v1';
  const fetch = transport.networkFetch, proxied = transport.isNetworkProxied;
  // Routing has its own CONNECT tests. Here only redirect the fixture origin.
  transport.networkFetch = (url, init) => fetch(String(url).replace('http://diagnostic.fixture.invalid', local), init);
  transport.isNetworkProxied = () => true;
  const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  try {
    await test('Codex catalog normalizes entries and sends Bearer authentication', async () => { const result = await fetchModels('codex', base, 'synthetic-diagnostic-key'); assert.deepEqual(result.map(x => x.id), ['gpt-fixture']); assert.equal(requests.at(-1).authorization, 'Bearer synthetic-diagnostic-key'); });
    await test('Codex endpoint distinguishes reachable transport from unauthorized model catalog', async () => { mode = 'unauthorized'; const result = await testModelsEndpoint('codex', base, 'synthetic-diagnostic-key'); assert.equal(result.ok, true); assert.equal(result.reachable, true); assert.equal(result.modelsApi, 'httpError'); assert.equal(result.httpStatus, 401); mode = 'ok'; });
    await test('Codex verification accepts a completed OK answer', async () => { assert.equal((await verifyModel('codex', base, 'synthetic-diagnostic-key', 'gpt-fixture')).ok, true); });
    await test('Codex verification rejects reasoning without a final answer', async () => { mode = 'reasoning'; assert.equal((await verifyModel('codex', base, 'synthetic-diagnostic-key', 'gpt-fixture')).ok, false); mode = 'ok'; });
    await test('Codex verification keeps unauthorized responses failed without exposing the key', async () => { mode = 'unauthorized'; const result = await verifyModel('codex', base, 'synthetic-diagnostic-key', 'gpt-fixture'); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('synthetic-diagnostic-key')); mode = 'ok'; });
    await test('Codex usage applies configured paths divisor and unit', async () => { const result = await queryUsage({ enabled: true, preset: 'custom', url: base + '/usage', remainingPath: 'data.left', usedPath: 'data.spent', totalPath: 'data.all', divisor: 100, unit: 'USD' }, base, 'synthetic-diagnostic-key', undefined, undefined, 'codex'); assert.equal(result.ok, true); assert.equal(result.remaining, 12.5); assert.equal(result.used, 7.5); assert.equal(result.total, 20); assert.equal(result.unit, 'USD'); });
    await test('cancelled Codex model discovery sends no request', async () => { const c = new AbortController(); c.abort(); const n = requests.length; await assert.rejects(fetchModels('codex', base, 'synthetic-diagnostic-key', c.signal)); assert.equal(requests.length, n); });
    await test('Codex terminal uses its route without applying a provider or unrelated tool variables', async () => { const app = Object.create(VSModelSwitchApp.prototype); let opened; app.lastEnv = { OPENAI_BASE_URL: base, ANTHROPIC_BASE_URL: 'http://unrelated.invalid' }; app.networkProxy = { environment: tool => { assert.equal(tool, 'codex'); return { HTTPS_PROXY: 'http://127.0.0.1:15001' }; } }; app.terminalManager = { openCodex: env => { opened = env; } }; app.sessionController = { assertReady() {} }; app.applyProvider = () => { throw Error('Must not Apply'); }; await app.openCodexTerminal(); assert.equal(opened.HTTPS_PROXY, 'http://127.0.0.1:15001'); assert.equal(opened.ANTHROPIC_BASE_URL, undefined); });
    console.log('RESULT: ' + passed + ' Codex diagnostic checks passed');
  } finally { transport.networkFetch = fetch; transport.isNetworkProxied = proxied; transport.disposeNetworkTransport(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
