'use strict';
// Synthetic settings, credentials and executable; never opens real user homes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const original = Module._load;
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswitch-isolated-network-'));
  const home = path.join(root, 'home'), binaryRoot = path.join(root, 'official', 'bin', 'linux-' + (process.arch === 'x64' ? 'x86_64' : 'aarch64'));
  await fs.mkdir(binaryRoot, { recursive: true }); await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  const native = path.join(home, '.claude', 'settings.json');
  const initialFile = { theme: 'keep', env: { HTTPS_PROXY: 'http://original.invalid:8000', ANTHROPIC_AUTH_TOKEN: 'synthetic-only' } };
  await fs.writeFile(native, JSON.stringify(initialFile));
  const probe = path.join(root, 'probe.cjs');
  await fs.writeFile(probe, `console.log(JSON.stringify({args:process.argv.slice(2),proxy:process.env.HTTPS_PROXY,bypass:process.env.NO_PROXY,all:process.env.ALL_PROXY,home:process.env.CODEX_HOME}));`);
  const quote = v => "'" + v.replace(/'/g, "'\\''") + "'";
  await fs.writeFile(path.join(binaryRoot, 'codex'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(probe) + ' "$@"\n', { mode: 0o700 });
  const values = { http: { proxy: 'http://vscode-only.invalid:7777' }, chatgpt: {}, settingsSync: { ignoredSettings: [] }, claudeCode: { environmentVariables: [{ name: 'KEEP', value: 'preserved' }] }, vscodemodelswitch: { configTarget: 'sandbox', testHome: home } };
  let failedUpdate, restoreFailure = false, stateFailure = false;
  const vscode = { ConfigurationTarget: { Global: 1 }, extensions: { getExtension: () => ({ extensionUri: { fsPath: path.join(root, 'official') } }) }, window: { showWarningMessage: async (_message, _options, ...items) => items.find(item => item.title === '继续启用') }, workspace: { getConfiguration(section) {
    const snapshot = structuredClone(values[section] || {});
    return { get: (k, fallback) => snapshot[k] ?? fallback, inspect: k => ({ globalValue: values[section]?.[k] }), async update(k, value) {
      if (failedUpdate === section + '.' + k) { failedUpdate = undefined; throw Error('synthetic update failure'); }
      if (restoreFailure && section === 'claudeCode' && Array.isArray(value) && !value.some(e => e.name === 'HTTPS_PROXY')) throw Error('synthetic rollback failure');
      values[section] ||= {}; if (value === undefined) delete values[section][k]; else values[section][k] = structuredClone(value);
    } };
  } } };
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  const { NetworkProxyManager } = require('../out/network/manager');
  const { ClaudeAdapter } = require('../out/clients/claude/adapter');
  const { DEFAULT_PROXY } = require('../out/network/transport');
  const state = new Map(), secrets = new Map();
  const environment = { id: 'fixture-env', ready: Promise.resolve(), get: (k, fallback) => state.has(k) ? state.get(k) : fallback, key: k => 'fixture.' + k, async update(k, v) { if (stateFailure) { stateFailure = false; throw Error('synthetic state failure'); } if (v === undefined) state.delete(k); else state.set(k, structuredClone(v)); } };
  const context = { globalStorageUri: { fsPath: path.join(root, 'storage') }, secrets: { get: async k => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async k => secrets.delete(k) } };
  const envHash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)))).digest('hex');
  const parentEnv = envHash(process.env), originalSettings = structuredClone(values);
  let manager = new NetworkProxyManager(context, environment); await manager.ready;
  let count = 0; const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  const a = { ...DEFAULT_PROXY, url: 'http://127.0.0.1:15001' }, b = { ...DEFAULT_PROXY, url: 'http://127.0.0.1:15002' };
  await test('Claude config covers native CLI and plugin without changing parent env or VS Code HTTP settings', async () => {
    await manager.apply(b, 'claude');
    const file = JSON.parse(await fs.readFile(native)); assert.equal(file.env.HTTPS_PROXY, b.url); assert.equal(file.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-only');
    assert.equal(values.claudeCode.environmentVariables.find(e => e.name === 'HTTPS_PROXY').value, b.url);
    assert.equal(envHash(process.env), parentEnv); assert.deepEqual(values.http, originalSettings.http);
  });
  await test('Codex dispatcher changes only its child, preserves arguments and CODEX_HOME', async () => {
    await manager.apply(a, 'codex');
    const result = JSON.parse((await exec('vscodemodelswitch-codex', ['app-server', 'quote \' " $()` 中文'], { env: { ...process.env, PATH: process.env.PATH + path.delimiter + binaryRoot, HTTPS_PROXY: 'http://wrong.invalid', CODEX_HOME: '/synthetic/codex' } })).stdout);
    assert.equal(result.proxy, a.url); assert.equal(result.all, ''); assert.equal(result.home, '/synthetic/codex'); assert.equal(result.args[1], 'quote \' " $()` 中文');
    assert.equal(JSON.parse(await fs.readFile(native)).env.HTTPS_PROXY, b.url);
    assert.equal(envHash(process.env), parentEnv); assert.deepEqual(values.http, originalSettings.http);
  });
  await test('provider Apply preserves independent Claude route fields', async () => {
    await new ClaudeAdapter().apply({ missingSecrets: [], degraded: [], claude: { providerId: 'fixture', providerName: 'fixture', baseUrl: 'http://model.invalid', key: 'synthetic-new', model: 'fixture', configText: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://model.invalid', HTTPS_PROXY: 'http://bad-template.invalid' } }) } });
    assert.equal(JSON.parse(await fs.readFile(native)).env.HTTPS_PROXY, b.url);
    await assert.rejects(fs.access(path.join(home, '.claude', 'vscodemodelswitchbak')));
  });
  await test('reload checks stored fields and retains independent routes', async () => {
    manager.dispose(); manager = new NetworkProxyManager(context, environment); await manager.ready;
    assert.equal(manager.environment('codex').HTTPS_PROXY, a.url); assert.equal(manager.environment('claude').HTTPS_PROXY, b.url);
    assert.ok(!manager.state().tools.claude.message.includes('异常'));
  });
  await test('startup rejects a saved Codex route when its executable registration was removed or replaced', async () => {
    for (const registration of [undefined, '/other/custom-codex']) {
      values.chatgpt.cliExecutable = registration; await manager.refresh();
      assert.equal(manager.state().tools.codex.error, true); assert.equal(manager.state().tools.claude.error, false);
    }
    values.chatgpt.cliExecutable = 'vscodemodelswitch-codex'; await manager.refresh(); assert.equal(manager.state().tools.codex.error, false);
  });
  await test('failed plugin setting update rolls native file and state back', async () => {
    const before = await fs.readFile(native, 'utf8'), saved = structuredClone([...state]); failedUpdate = 'claudeCode.environmentVariables';
    await assert.rejects(manager.apply({ ...b, url: 'http://127.0.0.1:15003' }, 'claude'));
    assert.equal(await fs.readFile(native, 'utf8'), before); assert.deepEqual([...state], saved);
    assert.ok(![...secrets.keys()].some(k => k.includes('.pending.')));
  });
  await test('external Claude file changes are detected, not overwritten', async () => {
    const before = await fs.readFile(native, 'utf8'), changed = JSON.parse(before); changed.env.HTTPS_PROXY = 'http://external.invalid:1234'; await fs.writeFile(native, JSON.stringify(changed));
    const external = await fs.readFile(native, 'utf8'); await assert.rejects(manager.restore('claude')); assert.equal(await fs.readFile(native, 'utf8'), external);
    await fs.writeFile(native, before);
  });
  await test('restoring Codex leaves Claude route and shared VS Code HTTP configuration untouched', async () => {
    await manager.restore('codex');
    const result = JSON.parse((await exec(path.join(binaryRoot, 'vscodemodelswitch-codex'), [], { env: { ...process.env, HTTPS_PROXY: 'http://before.invalid:1111' } })).stdout);
    assert.equal(result.proxy, 'http://before.invalid:1111'); assert.equal(manager.environment('claude').HTTPS_PROXY, b.url); assert.deepEqual(values.http, originalSettings.http);
  });
  await test('restoring Claude restores original proxy fields and keeps unrelated provider edits', async () => {
    await manager.restore('claude'); const file = JSON.parse(await fs.readFile(native));
    assert.equal(file.env.HTTPS_PROXY, initialFile.env.HTTPS_PROXY); assert.equal(file.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-new');
    assert.deepEqual(values.claudeCode, originalSettings.claudeCode);
  });
  await test('failed rollback retains durable setting recovery and retries on restart', async () => {
    stateFailure = true; restoreFailure = true;
    await assert.rejects(manager.apply(b, 'claude'), /回滚未完成/);
    assert.ok([...secrets.keys()].some(k => k.includes('.pending.')));
    restoreFailure = false; manager.dispose(); manager = new NetworkProxyManager(context, environment); await manager.ready;
    assert.deepEqual(values.claudeCode, originalSettings.claudeCode); assert.ok(![...secrets.keys()].some(k => k.includes('.pending.')));
    assert.equal(manager.environment('claude').HTTPS_PROXY, undefined);
  });
  await test('custom Codex executable is never silently replaced', async () => {
    values.chatgpt.cliExecutable = '/user/custom-codex'; await assert.rejects(manager.apply(a, 'codex')); assert.equal(values.chatgpt.cliExecutable, '/user/custom-codex');
    values.chatgpt.cliExecutable = 'vscodemodelswitch-codex';
  });
  manager.dispose(); Module._load = original;
  console.log('RESULT: ' + count + ' isolated network checks passed; retained fixture ' + root);
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main };
