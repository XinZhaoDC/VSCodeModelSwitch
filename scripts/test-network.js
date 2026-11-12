'use strict';
// Synthetic editor settings and loopback CONNECT fixtures only. No user accounts.
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const transport = require('../out/network/transport');
let passed = 0;
async function test(name, action) { await action(); passed++; console.log('PASS ' + name); }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

class Memento {
  constructor() { this.values = new Map(); }
  get(key, fallback) { return this.values.has(key) ? this.values.get(key) : fallback; }
  async update(key, value) { if (this.failOnce) { this.failOnce = false; throw Error('fixture metadata failure'); } if (value === undefined) this.values.delete(key); else this.values.set(key, structuredClone(value)); }
}
const values = { settingsSync: { ignoredSettings: ['editor.fontSize'] }, http: { proxy: 'http://original.invalid:8000' }, claudeCode: { environmentVariables: [
  { name: 'ANTHROPIC_AUTH_TOKEN', value: 'synthetic-credential' }, { name: 'HTTP_PROXY', value: 'http://previous.invalid:9000' }
] } };
let failedUpdate, override;
const vscode = { ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration(section) {
  // Real VS Code get() reads a snapshot, while inspect() reads the latest model.
  const snapshot = structuredClone(values[section] ?? {});
  if (override?.section === section) snapshot[override.key] = structuredClone(override.value);
  return {
  get(key, fallback) { return snapshot[key] ?? fallback; },
  inspect(key) { return { globalValue: values[section]?.[key] }; },
  async update(key, value) {
    if (failedUpdate === section + '.' + key) { failedUpdate = undefined; throw Error('fixture setting failure'); }
    if (value === undefined) delete values[section][key]; else values[section][key] = structuredClone(value);
  }
}; } } };
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { NetworkProxyManager } = require('../out/network/manager');
const { ProxyServer } = require('../out/proxy/server');
function context() {
  const secrets = new Map();
  return { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'network-environment-fixture') }, globalState: new Memento(), secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } }, secretValues: secrets };
}

async function main() {
  await test('HTTP URL validation and mandatory loopback bypass', () => {
    assert.throws(() => transport.normalizeNetworkProxy({ ...transport.DEFAULT_PROXY, url: 'socks5://127.0.0.1:12000' }));
    assert.throws(() => transport.normalizeNetworkProxy({ ...transport.DEFAULT_PROXY, url: 'http://user:password@127.0.0.1:12000' }));
    const c = transport.normalizeNetworkProxy({ ...transport.DEFAULT_PROXY, noProxy: '.internal.test' });
    for (const host of ['localhost', 'service.localhost', '127.4.5.6', '[::1]', 'a.internal.test']) assert.ok(transport.bypassNetworkProxy('http://' + host, c));
    assert.equal(transport.bypassNetworkProxy('https://remote.invalid', c), false);
    assert.equal(transport.proxyEnvironment(c).https_proxy, c.url);
  });
  await test('Editor configuration get retains its snapshot after update', async () => {
    const config = vscode.workspace.getConfiguration('http');
    const before = config.get('proxy');
    try {
      await config.update('proxy', transport.DEFAULT_PROXY.url);
      assert.equal(config.get('proxy'), before);
      assert.equal(vscode.workspace.getConfiguration('http').get('proxy'), transport.DEFAULT_PROXY.url);
      assert.equal(config.inspect('proxy').globalValue, transport.DEFAULT_PROXY.url);
    } finally { await config.update('proxy', before); }
  });
  // Manager ownership, native CLI files and rollback are tested in test-isolated-network.js.
  const connections = [], sockets = new Set();
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/redirect-local') { res.writeHead(302, { location: 'http://127.0.0.1:' + fixture.address().port + '/after-redirect' }); res.end(); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('first'); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n'); setTimeout(() => res.end('data: second\n\n'), 40); return;
    }
    if (req.url.endsWith('/messages')) {
      for await (const _ of req) {}
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); return;
    }
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, authorization: req.headers.authorization }));
  });
  const port = await listen(fixture);
  const proxy = http.createServer((_req, res) => { res.writeHead(500); res.end('CONNECT required'); });
  proxy.on('connect', (req, client, head) => {
    connections.push(req.url);
    const upstream = net.connect(Number(req.url.split(':').pop()), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(client); sockets.add(upstream);
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const config = { ...transport.DEFAULT_PROXY, url: 'http://127.0.0.1:' + proxyPort };
  const remote = 'http://upstream.invalid:' + port;
  let api;
  const directory = await fs.mkdtemp(path.join(process.env.VSCODEMODELSWITCH_TEST_HOME || os.tmpdir(), 'network-cert-'));
  console.log('RETAINED_FIXTURE: ' + directory);
  try {
    transport.setNetworkProxy(config);
    await test('concurrent Codex and Claude requests use different CONNECT proxies', async () => {
      const second = http.createServer(); let firstCount = 0, secondCount = 0;
      const countFirst = () => firstCount++;
      proxy.on('connect', countFirst);
      second.on('connect', proxy.listeners('connect')[0]); second.on('connect', () => secondCount++);
      const secondPort = await listen(second);
      try {
        transport.setNetworkProxy(config, 'codex');
        transport.setNetworkProxy({ ...config, url: 'http://127.0.0.1:' + secondPort }, 'claude');
        await Promise.all(['codex', 'claude'].map(tool => transport.withNetworkTool(tool, async () => {
          await new Promise(resolve => setTimeout(resolve, tool === 'codex' ? 5 : 1));
          const response = await transport.networkFetch(remote + '/tool-' + tool); assert.equal(response.status, 200); await response.text();
        })));
        assert.ok(firstCount > 0); assert.ok(secondCount > 0);
        const before = [firstCount, secondCount];
        transport.setNetworkProxy(undefined, 'claude');
        const direct = await transport.withNetworkTool('claude', () => transport.networkFetch('http://127.0.0.1:' + port + '/direct'));
        await direct.text(); assert.deepEqual([firstCount, secondCount], before);
      } finally {
        proxy.removeListener('connect', countFirst);
        transport.disposeNetworkTransport();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => second.close(resolve));
        transport.setNetworkProxy(config);
      }
    });
    await test('CONNECT proxy resolves a remote hostname with no local DNS', async () => {
      const response = await transport.networkFetch(remote + '/ok');
      assert.equal(response.status, 200); assert.equal((await response.json()).host, 'upstream.invalid:' + port);
      assert.ok(connections.includes('upstream.invalid:' + port));
    });
    await test('Loopback requests bypass both explicit proxy and ambient fetch hooks', async () => {
      const before = connections.length, oldFetch = global.fetch;
      global.fetch = () => { throw Error('Ambient proxy must not receive loopback'); };
      try { assert.equal((await transport.networkFetch('http://127.0.0.1:' + port + '/local')).status, 200); }
      finally { global.fetch = oldFetch; }
      assert.equal(connections.length, before);
    });
    await test('Redirects recheck loopback bypass and drop cross-origin credentials', async () => {
      const before = connections.length;
      const response = await transport.networkFetch(remote + '/redirect-local', { headers: { Authorization: 'Bearer synthetic-key' } });
      const result = await response.json(); assert.equal(result.path, '/after-redirect'); assert.equal(result.authorization, undefined);
      assert.ok(connections.slice(before).every(target => !target.startsWith('127.0.0.1:')));
    });
    await test('Native SSE remains streaming through the HTTP CONNECT proxy', async () => {
      const response = await transport.networkFetch(remote + '/stream');
      const reader = response.body.getReader();
      const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /first/);
      let tail = ''; for (;;) { const v = await reader.read(); if (v.done) break; tail += new TextDecoder().decode(v.value); }
      assert.match(tail, /second/);
    });
    await test('Abort cancels a proxied response body', async () => {
      const controller = new AbortController();
      const response = await transport.networkFetch(remote + '/slow', { signal: controller.signal });
      controller.abort(); await assert.rejects(response.text());
    });
    await test('Existing API compatibility relay uses network proxy for its upstream', async () => {
      api = new ProxyServer();
      const endpoint = await api.register('fixture', remote, 'synthetic-key', 'fixture', { mode: 'proxy', preset: 'custom', overrides: { webTools: false } }, 'claude');
      const reply = await transport.networkFetch(endpoint.baseUrl + '/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': endpoint.key },
        body: JSON.stringify({ model: 'fixture', max_tokens: 32, messages: [{ role: 'user', content: 'Hi' }], stream: false })
      });
      assert.equal(reply.status, 200); assert.equal((await reply.json()).content[0].text, 'OK');
    });
    await test('Proxy failure is reported without silently sending the request direct', async () => {
      transport.setNetworkProxy({ ...config, url: 'http://127.0.0.1:1' });
      await assert.rejects(transport.networkFetch(remote + '/ok'));
      transport.setNetworkProxy(config);
    });
    const key = path.join(directory, 'fixture-key.pem'), cert = path.join(directory, 'fixture-cert.pem');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=upstream.invalid', '-addext', 'subjectAltName=DNS:upstream.invalid']);
    const tls = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (_req, res) => res.end('TLS OK'));
    const tlsPort = await listen(tls);
    try {
      await test('TLS certificate validation remains enabled', async () => {
        await assert.rejects(transport.networkFetch('https://upstream.invalid:' + tlsPort));
      });
      await test('HTTPS CONNECT succeeds with a trusted fixture CA', async () => {
        const script = `const t=require(${JSON.stringify(path.resolve(__dirname, '../out/network/transport'))});t.setNetworkProxy(${JSON.stringify(config)});t.networkFetch('https://upstream.invalid:${tlsPort}').then(async r=>{if(await r.text()!=='TLS OK')process.exitCode=1;t.disposeNetworkTransport()}).catch(e=>{console.error(e.message);t.disposeNetworkTransport();process.exitCode=1});`;
        await run(process.execPath, ['-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 10000 });
      });
    } finally { tls.closeAllConnections(); tls.close(); }
    await test('Disabled feature preserves the previous fetch transport', async () => {
      transport.setNetworkProxy(); let called = false; const before = global.fetch;
      global.fetch = async () => { called = true; return new Response('original'); };
      try { assert.equal(await (await transport.networkFetch('https://unused.invalid')).text(), 'original'); }
      finally { global.fetch = before; }
      assert.equal(called, true);
    });
  } finally {
    api?.dispose(); transport.disposeNetworkTransport();
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections(); fixture.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => fixture.close(r))]);
  }
  console.log(`Network proxy tests passed: ${passed}`);
}
main().catch(error => { transport.disposeNetworkTransport(); console.error(error); process.exitCode = 1; });
