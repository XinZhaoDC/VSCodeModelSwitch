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
  const { DEFAULT_PROXY } = require('../out/network/transport');
  const state = new Map(), secrets = new Map();
  const environment = { id: 'fixture-env', ready: Promise.resolve(), get: (k, fallback) => state.has(k) ? state.get(k) : fallback, key: k => 'fixture.' + k, async update(k, v) { if (stateFailure) { stateFailure = false; throw Error('synthetic state failure'); } if (v === undefined) state.delete(k); else state.set(k, structuredClone(v)); } };
  const context = { globalStorageUri: { fsPath: path.join(root, 'storage') }, secrets: { get: async k => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async k => secrets.delete(k) } };
  const envHash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)))).digest('hex');
  const parentEnv = envHash(process.env), originalSettings = structuredClone(values);
  let manager = new NetworkProxyManager(context, environment); await manager.ready;
  let count = 0; const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  const a = { ...DEFAULT_PROXY, url: 'http://127.0.0.1:15001' }, b = { ...DEFAULT_PROXY, url: 'http://127.0.0.1:15002' };
  const protectedSettings = structuredClone(values.claudeCode), protectedFile = await fs.readFile(native, 'utf8');
  const run = async () => JSON.parse((await exec(path.join(binaryRoot, 'vscodemodelswitch-codex'), ['app-server', 'quote \' " $()` 中文'], { env: { ...process.env, HTTPS_PROXY: 'http://inherited.invalid', CODEX_HOME: '/synthetic/codex' } })).stdout);
  await test('Codex apply injects only child routing and preserves arguments and CODEX_HOME', async () => {
    await manager.apply(a, 'codex');const result=await run();assert.equal(result.proxy,a.url);assert.equal(result.home,'/synthetic/codex');assert.equal(result.all,'');assert.equal(result.args[1],'quote \' " $()` 中文');assert.equal(envHash(process.env),parentEnv);assert.deepEqual(values.http,originalSettings.http);
  });
  await test('Codex operations leave unrelated tool settings and files byte-identical', async () => {assert.deepEqual(values.claudeCode,protectedSettings);assert.equal(await fs.readFile(native,'utf8'),protectedFile);});
  await test('startup restores the saved Codex route and checks the launcher registration', async () => {
    manager.dispose();manager=new NetworkProxyManager(context,environment);await manager.ready;assert.equal(manager.environment('codex').HTTPS_PROXY,a.url);
    for(const registration of [undefined,'/other/custom']){values.chatgpt.cliExecutable=registration;await manager.refresh();assert.equal(manager.state().tools.codex.error,true);}
    values.chatgpt.cliExecutable='vscodemodelswitch-codex';await manager.refresh();assert.equal(manager.state().tools.codex.error,false);
  });
  await test('Codex state persistence failure restores the previous script, route and settings', async () => {
    const script=await fs.readFile(path.join(binaryRoot,'vscodemodelswitch-codex'),'utf8'),before=structuredClone(values),saved=structuredClone([...state]);stateFailure=true;
    await assert.rejects(manager.apply(b,'codex'));assert.equal(await fs.readFile(path.join(binaryRoot,'vscodemodelswitch-codex'),'utf8'),script);assert.deepEqual(values,before);assert.deepEqual([...state],saved);assert.equal((await run()).proxy,a.url);assert.ok(![...secrets.keys()].some(k=>k.includes('.pending.')));
  });
  await test('explicit Codex restore uses the inherited route and keeps unrelated settings intact',async()=>{
    await manager.restore('codex');assert.equal((await run()).proxy,'http://inherited.invalid');assert.deepEqual(values.http,originalSettings.http);assert.deepEqual(values.claudeCode,protectedSettings);assert.equal(await fs.readFile(native,'utf8'),protectedFile);assert.equal(envHash(process.env),parentEnv);
  });
  await test('custom Codex executable is never overwritten',async()=>{values.chatgpt.cliExecutable='/user/custom';await assert.rejects(manager.apply(a,'codex'));assert.equal(values.chatgpt.cliExecutable,'/user/custom');delete values.chatgpt.cliExecutable;});
  await test('Codex setting write failure restores the original registration and all files',async()=>{failedUpdate='chatgpt.cliExecutable';const before=structuredClone(values),script=await fs.readFile(path.join(binaryRoot,'vscodemodelswitch-codex'),'utf8');await assert.rejects(manager.apply(a,'codex'));assert.deepEqual(values,before);assert.equal(await fs.readFile(path.join(binaryRoot,'vscodemodelswitch-codex'),'utf8'),script);});
  await test('an externally changed Codex dispatcher is preserved and reported',async()=>{await manager.apply(a,'codex');const shim=path.join(binaryRoot,'vscodemodelswitch-codex'),before=await fs.readFile(shim,'utf8');await fs.writeFile(shim,'#!/bin/sh\n# foreign launcher\n');await assert.rejects(manager.restore('codex'));assert.match(await fs.readFile(shim,'utf8'),/foreign launcher/);await fs.writeFile(shim,before);await manager.restore('codex');});
  manager.dispose();Module._load=original;
  console.log('RESULT: '+count+' Codex network checks passed; retained fixture '+root);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
