'use strict';
// Separate extension-host processes share client Memento/SecretStorage fixtures.
// Adapters and identity libraries use real files inside synthetic private homes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');

if (process.argv[2] === '--worker') worker().catch(error => { console.error(error); process.exit(1); });
else main().catch(error => { console.error(error); process.exitCode = 1; });

async function worker() {
  const [root, name] = process.argv.slice(3);
  const home = path.join(root, name), remote = name !== 'host';
  os.hostname = () => remote ? name : 'fixture-desktop';
  const disposable = () => ({ dispose() {} });
  const read = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID(); fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, file);
  };
  class Memento {
    constructor(directory) { this.directory = directory; }
    file(key) { return path.join(this.directory, Buffer.from(key).toString('base64url') + '.json'); }
    get(key, fallback) { return read(this.file(key), { value: fallback }).value; }
    async update(key, value) { write(this.file(key), { value }); }
    setKeysForSync(keys) { write(path.join(this.directory, 'sync-keys.json'), keys); }
  }
  const globalState = new Memento(path.join(root, 'client-state'));
  const secretStore = new Memento(path.join(root, 'client-secrets'));
  const hostSettings = path.join(root, 'host', 'editor-settings.json');
  const ownSettings = path.join(home, 'editor-settings.json');
  let pickedFolder, takeOver = false;
  const official = path.join(home, 'official', 'bin', 'linux-' + (process.arch === 'x64' ? 'x86_64' : 'aarch64'));
  await fsp.mkdir(official, { recursive: true }); await fsp.writeFile(path.join(official, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const vscode = {
    extensions: { getExtension: () => ({ extensionUri: { fsPath: path.join(home, 'official') } }) },
    env: remote ? { remoteName: 'dev-container' } : {},
    Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    RelativePattern: class {}, ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Left: 1 },
    window: {
      createOutputChannel: () => ({ info() {}, warn() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: disposable,
      showWarningMessage: async (_message, _options, ...items) => items.find(item => item.title), showInformationMessage: async () => undefined,
      showQuickPick: async items => takeOver ? items.find(item => item.transfer) : items[0],
      showOpenDialog: async () => [{ fsPath: pickedFolder }]
    },
    commands: { registerCommand: disposable },
    workspace: {
      createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }),
      getConfiguration(section) {
        if (section === 'vscodemodelswitch') return { get: (key, fallback) => ({ configTarget: 'sandbox', testHome: home, globalCliSync: true })[key] ?? fallback };
        const host = read(hostSettings), own = read(ownSettings);
        const localProxy = remote && own['http.useLocalProxyConfiguration'] !== false;
        const effective = key => {
          const full = section + '.' + key;
          return remote && section === 'http' && key !== 'useLocalProxyConfiguration' && localProxy ? host[full] : own[full] ?? host[full];
        };
        return {
          get: (key, fallback) => effective(key) ?? fallback,
          inspect(key) { const full = section + '.' + key; return { globalLocalValue: host[full], globalRemoteValue: remote ? own[full] : undefined, globalValue: effective(key) }; },
          async update(key, value, target) {
            assert.equal(target, 1);
            // Mirrors VS Code USER: machine settings => remote; application
            // http.proxy => host until remote proxy inheritance is disabled.
            const file = remote && section !== 'settingsSync' && (section === 'claudeCode' || key === 'useLocalProxyConfiguration' || !localProxy) ? ownSettings : hostSettings;
            const current = read(file); const full = section + '.' + key;
            if (value === undefined) delete current[full]; else current[full] = value;
            write(file, current);
          }
        };
      }
    }
  };
  const load = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
  const guard = require('../out/shared/runtimeGuard');
  guard.confirmCodexChange = async () => true;
  const { VSModelSwitchApp } = require('../out/app');
  const { CodexProfiles } = require('../out/clients/codex/history/codexProfiles');
  const context = {
    globalState, workspaceState: new Memento(path.join(home, 'workspace-' + process.env.FIXTURE_WORKSPACE)), subscriptions: [],
    // Deliberately shared server-storage mount: hostname fingerprint must split containers.
    globalStorageUri: vscode.Uri.file(path.join(root, remote ? 'mounted-server-storage' : 'desktop-storage')),
    extensionUri: vscode.Uri.file(path.join(__dirname, '..')), logUri: vscode.Uri.file(path.join(home, 'log')),
    secrets: { get: async key => secretStore.get(key), store: async (key, value) => secretStore.update(key, value), delete: async key => secretStore.update(key, undefined) },
    environmentVariableCollection: { delete() {}, replace() {} }
  };
  if (name === 'log-start-failure') {
    const { OperationLog } = require('../out/storage/operationLog');
    const write = OperationLog.prototype.write;
    OperationLog.prototype.write = function(event) { if (event.action === 'activate') return Promise.reject(Error('synthetic transient startup log error')); return write.call(this, event); };
  }
  const app = new VSModelSwitchApp(context);
  await app.environment.ready; await app.sessionController.ready;
  await app.initializeCurrentProviders();
  async function state() {
    const s = await app.getSidebarState();
    return { id: app.environment.id, selected: s.currentProviderIds, enabled: s.toolEnabled, mode: s.codexMode,
      providers: s.providers, network: s.networkProxy, sessions: s.sessions, logDirectory: s.logDirectory };
  }
  process.on('message', async ({ id, command, data = {} }) => {
    try {
      let result;
      if (command === 'state') result = await state();
      else if (command === 'logRecord') { await app.recordOperation({ id: data.marker, action: 'fixture.record', status: 'succeeded' }); result = await app.operationLog.text(); }
      else if (command === 'cancelApply') {
        guard.confirmCodexChange = async () => false;
        try { await app.applyProviderFromSidebar(data.provider); } finally { guard.confirmCodexChange = async () => true; }
      }
      else if (command === 'cancelMode') {
        guard.confirmCodexChange = async () => false;
        try { await app.applyCodexModeFromSidebar(data.mode); } finally { guard.confirmCodexChange = async () => true; }
      }
      else if (command === 'create') {
        await app.createProviderFromSidebar({ tool: data.tool ?? 'codex', name: data.name, baseUrl: 'https://' + data.name.toLowerCase() + '.invalid/v1', key: 'synthetic-' + data.name,
          model: 'fixture-model', applyNow: false, proxy: { mode: 'direct', preset: 'custom' } });
        result = app.store.getProviders().find(p => p.name === data.name).id;
      } else if (command === 'apply') { await app.applyProviderFromSidebar(data.provider); result = await state(); }
      else if (command === 'mode') { pickedFolder = path.join(root, 'workflow-mount'); await fsp.mkdir(pickedFolder, { recursive: true }); await app.applyCodexModeFromSidebar(data.mode); result = await state(); }
      else if (command === 'session') { await app.sessionActionFromSidebar(data.action, data.identity); result = await state(); }
      else if (command === 'refresh') { await app.reloadStateFromSidebar(); result = await state(); }
      else if (command === 'enabled') { await app.setToolEnabledFromSidebar(data.tool, data.value); result = await state(); }
      else if (command === 'edit') {
        const p = app.store.getProvider(data.provider);
        const text = p.configText.replace(p.baseUrl, data.url);
        await app.saveProviderConfigFromSidebar(p.id, text, 'synthetic-edited-key'); result = await state();
      } else if (command === 'network') { await app.applyNetworkProxyFromSidebar({ url: data.url, noProxy: 'localhost,127.0.0.1,::1', codex: true, claude: true }, data.tool); result = await state(); }
      else if (command === 'restoreNetwork') { await app.restoreNetworkProxyFromSidebar(data.tool); result = read(ownSettings); }
      else if (command === 'official') {
        const dir = path.join(home, '.codex'); await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'config.toml'), 'model = "fixture-official"\n');
        await fsp.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'synthetic-' + name, id_token: 'synthetic-id-' + name } }));
        await app.reloadStateFromSidebar(); result = await state();
      } else if (command === 'storage') {
        pickedFolder = data.folder ?? path.join(root, 'private-mount'); await fsp.mkdir(pickedFolder, { recursive: true }); takeOver = Boolean(data.takeOver);
        const originalUpdate = app.environment.update.bind(app.environment);
        let injected = false;
        if (data.failBinding) app.environment.update = async (key, value) => { if (!injected && key === 'vscodemodelswitch.codexIdentityStorage') { injected = true; throw Error('synthetic binding persistence failure'); } return originalUpdate(key, value); };
        try { await app.sessionActionFromSidebar('configure'); result = await state(); } finally { app.environment.update = originalUpdate; }
      } else if (command === 'identity') {
        const s = await app.sessionController.state();
        const profiles = new CodexProfiles(s.root, path.join(home, '.codex'), app.environment.id);
        const added = await profiles.add(data.name, data.kind); await profiles.switchTo(added.id); result = await state();
      } else if (command === 'foreign') {
        const s = await app.sessionController.state();
        const foreign = new CodexProfiles(data.root, path.join(home, 'other-codex'), app.environment.id);
        await foreign.bindEnvironment(); result = s;
      } else if (command === 'exit') { app.dispose(); process.send({ id, result: true }, () => process.exit(0)); return; }
      else throw Error('Unknown command');
      process.send({ id, result });
    } catch (error) { process.send({ id, error: error.stack }); }
  });
  process.send({ ready: true });
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vscodemodelswitch-environments-'));
  const workers = new Set(); let count = 0;
  const test = async (name, action) => { await action(); count++; console.log('PASS ' + name); };
  async function start(name, workspace = 'one') {
    const child = fork(__filename, ['--worker', root, name], { env: { ...process.env, FIXTURE_WORKSPACE: workspace }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    workers.add(child); let sequence = 0; const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      child.on('message', m => { if (m.ready) resolve(); else { const callback = pending.get(m.id); pending.delete(m.id); if (callback) m.error ? callback.reject(Error(m.error)) : callback.resolve(m.result); } });
      child.once('exit', code => { workers.delete(child); if (code) reject(Error(name + ' exited: ' + code)); for (const p of pending.values()) p.reject(Error('Worker exited')); });
    });
    await ready;
    return { call(command, data) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, command, data }); }); } };
  }
  const bytes = name => fsp.readFile(path.join(root, name, '.codex/config.toml'), 'utf8');
  const auth = name => fsp.readFile(path.join(root, name, '.codex/auth.json'), 'utf8');
  try {
    let host = await start('host'), c1 = await start('container-one'), c2 = await start('container-two');
    const ids = await Promise.all([host.call('state'), c1.call('state'), c2.call('state')]);
    await test('Host and two containers receive distinct stable identities despite shared server storage', () => assert.equal(new Set(ids.map(s => s.id)).size, 3));
    const A = await host.call('create', { name: 'ProviderA' }), B = await c1.call('create', { name: 'ProviderB' });
    await test('Shared Provider definitions and keys remain usable in both directions', async () => {
      assert.equal((await c2.call('state')).providers.length, 2);
      for (const p of (await c2.call('state')).providers) assert.equal(p.hasKey, true);
    });
    await host.call('apply', { provider: A }); await c1.call('apply', { provider: B });
    const aBytes = await bytes('host'), bBytes = await bytes('container-one');
    await test('Host A and container B keep separate selections and actual CLI files through alternating refreshes', async () => {
      for (let n = 0; n < 3; n++) {
        assert.equal((await host.call('refresh')).selected.codex, A);
        assert.equal((await c1.call('refresh')).selected.codex, B);
        await c2.call('refresh');
      }
      assert.equal(await bytes('host'), aBytes); assert.equal(await bytes('container-one'), bBytes);
    });
    await test('Concurrent enable toggles do not overwrite another environment', async () => {
      await Promise.all([host.call('enabled', { tool: 'claude', value: false }), c1.call('enabled', { tool: 'codex', value: false })]);
      assert.deepEqual((await host.call('refresh')).enabled, { claude: false, codex: true });
      assert.deepEqual((await c1.call('refresh')).enabled, { claude: true, codex: false });
      assert.deepEqual((await c2.call('state')).enabled, { claude: true, codex: true });
    });
    await test('Reconnection and a different workspace restore environment selections and enabled flags', async () => {
      await host.call('exit'); await c1.call('exit'); host = await start('host', 'two'); c1 = await start('container-one', 'two');
      assert.equal((await host.call('state')).id, ids[0].id); assert.equal((await c1.call('state')).id, ids[1].id);
      assert.equal((await host.call('state')).selected.codex, A); assert.equal((await c1.call('state')).selected.codex, B);
      assert.equal((await host.call('state')).enabled.claude, false); assert.equal((await c1.call('state')).enabled.codex, false);
    });
    await test('Editing a shared URL/key keeps the other environment selected and never rewrites its CLI', async () => {
      await c1.call('enabled', { tool: 'codex', value: true });
      await c1.call('edit', { provider: A, url: 'https://updated.invalid/v1' });
      const h = await host.call('refresh');
      assert.equal(h.selected.codex, A); assert.equal(h.providers.find(p => p.id === A).needsApply, true);
      assert.equal(h.providers.find(p => p.id === A).baseUrl, 'https://updated.invalid/v1');
      assert.equal(await bytes('host'), aBytes); assert.equal(await bytes('container-one'), bBytes);
      await host.call('exit'); host = await start('host', 'three');
      const restored = await host.call('state'); assert.equal(restored.selected.codex, A); assert.equal(restored.providers.find(p => p.id === A).needsApply, true);
    });
    await test('shared dispatcher registration retains independent host/container routes without rewriting host settings', async () => {
      await host.call('network', { url: 'http://127.0.0.1:13001' });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'host/editor-settings.json'), 'utf8'))['settingsSync.ignoredSettings'], ['chatgpt.cliExecutable']);
      const hostBefore = fs.readFileSync(path.join(root, 'host/editor-settings.json'), 'utf8');
      await c1.call('network', { url: 'http://127.0.0.1:13002' }); await c2.call('network', { url: 'http://127.0.0.1:13003' });
      assert.equal(fs.readFileSync(path.join(root, 'host/editor-settings.json'), 'utf8'), hostBefore);
      assert.equal((await host.call('state')).network.tools.codex.config.url, 'http://127.0.0.1:13001');
      assert.equal((await c1.call('state')).network.tools.codex.config.url, 'http://127.0.0.1:13002');
      await c1.call('exit'); c1 = await start('container-one', 'three');
      assert.equal((await c1.call('state')).network.tools.codex.config.url, 'http://127.0.0.1:13002');
      await c1.call('restoreNetwork');
      assert.equal(fs.readFileSync(path.join(root, 'host/editor-settings.json'), 'utf8'), hostBefore);
      assert.equal(fs.existsSync(path.join(root, 'container-one/editor-settings.json')), false);
    });
    await test('Host official account and container API retain different auth caches through refresh', async () => {
      await host.call('official'); const hAuth = await auth('host');
      await c1.call('apply', { provider: B }); await host.call('refresh'); await c1.call('refresh');
      assert.equal((await host.call('state')).mode, 'official'); assert.equal((await c1.call('state')).mode, 'api');
      assert.equal(await auth('host'), hAuth); assert.notEqual(await auth('container-one'), hAuth);
    });
    await c1.call('official');
    const hostAuth = await auth('host'), containerAuth = await auth('container-one');
    await test('one mount shares account registry/history while each environment binds independently', async () => {
      await host.call('storage'); await c1.call('storage');
      const h = await host.call('state'), c = await c1.call('state');
      assert.equal(h.sessions.root, c.sessions.root); assert.equal(h.sessions.activeId, c.sessions.activeId);
      assert.equal(await auth('host'), hostAuth);
      assert.equal(await auth('container-one'), ''); // Fixed home clears auth instead of reusing another environment's cache.
      const registry = JSON.parse(await fsp.readFile(path.join(h.sessions.root, 'profiles.json'), 'utf8'));
      const first = registry.identities[0];
      await fsp.writeFile(path.join(root, 'host/.codex/sessions/shared.jsonl'), '{"fixture":"shared"}');
      assert.equal(await fsp.readFile(path.join(root, 'container-one/.codex/sessions/shared.jsonl'), 'utf8'), '{"fixture":"shared"}');
      await host.call('identity', { name: 'Host second account', kind: 'official' });
      assert.equal((await c1.call('state')).sessions.activeId, first.id);
      assert.equal((await c1.call('state')).sessions.identities.length, 2);
    });
    await test('only shared Provider/group/template definitions sync; environment states do not', () => {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'client-state/sync-keys.json'), 'utf8')), ['vscodemodelswitch.providers', 'vscodemodelswitch.organization.codex', 'vscodemodelswitch.organization.claude']);
    });
    await test('new container attaches existing history with no inherited official credential', async () => {
      const before = await c1.call('state');
      await c2.call('storage', { folder: before.sessions.root });
      const after = await c2.call('state');
      assert.equal(after.sessions.activeId, before.sessions.activeId);
      await assert.rejects(auth('container-two'), { code: 'ENOENT' }); // Absent home still uses the linked entry.
      assert.equal(await fsp.readFile(path.join(root, 'container-two/.codex/sessions/shared.jsonl'), 'utf8'), '{"fixture":"shared"}');
      assert.equal((await host.call('state')).sessions.activeId === after.sessions.activeId, false);
    });
    for (const w of [host, c1, c2]) await w.call('exit');
    let flow = await start('workflow'); await flow.call('official'); const originalAuth = await auth('workflow');
    await test('first mode change enrolls current home without overwriting existing official login', async () => {
      const enrolled = await flow.call('mode', { mode: 'api' });
      assert.equal(enrolled.sessions.restartRequired, true); assert.equal(enrolled.sessions.identities.length, 1);
      assert.equal(await auth('workflow'), originalAuth); await assert.rejects(flow.call('mode', { mode: 'api' }), /重载/);
    });
    await flow.call('exit'); flow = await start('workflow'); const officialId = (await flow.call('state')).sessions.activeId;
    let apiId;
    await test('mode action binds singleton API home and preserves official environment cache', async () => {
      const selected = await flow.call('mode', { mode: 'api' }); apiId = selected.sessions.activeId;
      assert.notEqual(apiId, officialId); assert.equal(selected.sessions.restartRequired, true);
      assert.equal(await auth('workflow'), '');
    });
    await flow.call('exit'); flow = await start('workflow');
    await test('after reload API Apply preserves shared index path and does not create permanent bak files', async () => {
      await flow.call('apply', { provider: B }); const state = await flow.call('state');
      assert.equal(state.mode, 'api'); assert.equal(state.sessions.activeId, apiId);
      assert.match(await bytes('workflow'), /sqlite_home/);
      await assert.rejects(fsp.stat(path.join(root, 'workflow/.codex/vscodemodelswitchbak')), { code: 'ENOENT' });
    });
    await test('cancelled Provider Apply preserves active selection and actual CLI files', async () => {
      const before = await flow.call('state'), config = await bytes('workflow');
      await assert.rejects(flow.call('cancelApply', { provider: A }), /已取消/);
      assert.equal((await flow.call('state')).selected.codex, before.selected.codex); assert.equal(await bytes('workflow'), config);
    });
    await test('returning to Official reuses that environment account cache after reload', async () => {
      await flow.call('mode', { mode: 'official' }); await flow.call('exit'); flow = await start('workflow');
      assert.equal((await flow.call('state')).sessions.activeId, officialId); assert.equal(await auth('workflow'), originalAuth);
      assert.equal((await flow.call('state')).mode, 'official');
    });
    await test('cancelled mode changes do not create a new API profile or change the binding', async () => {
      const before = await flow.call('state'); const config = await bytes('workflow');
      await assert.rejects(flow.call('cancelMode', { mode: 'api' }), /已取消/);
      const after = await flow.call('state'); assert.equal(after.sessions.activeId, before.sessions.activeId); assert.deepEqual(after.sessions.identities, before.sessions.identities); assert.equal(await bytes('workflow'), config);
    });
    await flow.call('exit');
    let audit = await start('audit');
    await test('default operation log lives in environment storage before data setup', async () => {
      const state = await audit.call('state'); assert.match(state.logDirectory, /logs$/); assert.equal(state.sessions.root, undefined);
      assert.match(await audit.call('logRecord', { marker: 'before-storage' }), /before-storage/);
    });
    await test('connecting storage moves operation history into the selected environment folder', async () => {
      const before = await audit.call('state');
      const state = await audit.call('storage', { folder: path.join(root, 'audit-mount') });
      assert.equal(state.logDirectory, path.join(state.sessions.root, 'environments', state.id, 'logs'));
      assert.notEqual(state.logDirectory, before.logDirectory);
      const text = await audit.call('logRecord', { marker: 'after-storage' }); assert.match(text, /before-storage/); assert.match(text, /after-storage/);
    });
    await audit.call('exit'); audit = await start('audit');
    await test('reconnect restores operation log location and prior records', async () => {
      assert.match((await audit.call('state')).logDirectory, /audit-mount/);
      assert.match(await audit.call('logRecord', { marker: 'after-reconnect' }), /before-storage/);
    });
    await test('cancelled first switch to API does not create an unused profile', async () => {
      const before = await audit.call('state'); assert.equal(before.sessions.identities.some(i => i.kind === 'api'), false);
      await assert.rejects(audit.call('cancelMode', { mode: 'api' }), /已取消/);
      assert.deepEqual((await audit.call('state')).sessions.identities, before.sessions.identities);
    });
    await test('binding persistence failure rolls back both runtime home and operation log location', async () => {
      const before = await audit.call('state'); const config = await bytes('audit'); const home = await fsp.realpath(path.join(root, 'audit/.codex'));
      await assert.rejects(audit.call('storage', { folder: path.join(root, 'audit-failed-mount'), failBinding: true }), /已恢复/);
      const after = await audit.call('state'); assert.equal(after.sessions.root, before.sessions.root); assert.equal(after.logDirectory, before.logDirectory);
      assert.equal(await fsp.realpath(path.join(root, 'audit/.codex')), home); assert.equal(await bytes('audit'), config);
      assert.match(await audit.call('logRecord', { marker: 'after-rollback' }), /before-storage/);
    });
    await audit.call('exit');
    await test('a transient startup logging failure does not permanently block later operations', async () => {
      const retry = await start('log-start-failure');
      assert.match(await retry.call('logRecord', { marker: 'retry-works' }), /retry-works/);
      await retry.call('exit');
    });
    await legacyTests(root, test);
    console.log('RESULT: ' + count + ' environment checks passed, 0 failed');
    console.log('RETAINED_FIXTURE: ' + root);
  } finally {
    for (const w of workers) w.kill();
    console.log('RETAINED_SANDBOX: ' + root);
  }
}

async function legacyTests(root, test) {
  const values = new Map([
    ['vscodemodelswitch.providers', [{ id: 'old-api', tool: 'codex', name: 'Old API', baseUrl: 'https://old.invalid', secretRef: 'original-shared-ref', modelPolicy: { type: 'toolDefault' } }]],
    ['vscodemodelswitch.currentProviderIds', { codex: 'old-api' }],
    ['vscodemodelswitch.toolEnabled', { claude: false }],
    ['vscodemodelswitch.networkProxy', { url: 'http://legacy.invalid:12000', noProxy: 'localhost', claude: true, codex: true }]
  ]);
  let home = path.join(root, 'legacy-home'), settingWrites = 0;
  const secrets = new Map([['original-shared-ref', 'synthetic-legacy-api-key'], ['vscodemodelswitch.networkProxy.backup', 'synthetic-original-backup']]);
  const globalState = { get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    async update(key, value) { values.set(key, structuredClone(value)); }, setKeysForSync() {} };
  const vscode = { env: {}, workspace: { getConfiguration(section) { return {
    get: (key, fallback) => section === 'vscodemodelswitch' ? ({ configTarget: 'sandbox', testHome: home })[key] ?? fallback : fallback,
    async update() { settingWrites++; }
  }; } } };
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  const { EnvironmentState } = require('../out/storage/environmentState');
  const { ProviderStore } = require('../out/storage/providerStore');
  const { NetworkProxyManager } = require('../out/network/manager');
  const { CodexProfiles } = require('../out/clients/codex/history/codexProfiles');
  const { SessionController } = require('../out/clients/codex/history/controller');
  const context = suffix => ({ globalState, globalStorageUri: { fsPath: path.join(root, 'legacy-environment-' + suffix) },
    secrets: { get: async key => secrets.get(key), store: async (key, v) => secrets.set(key, v) } });
  const ctx = context('first'), env = new EnvironmentState(ctx); await env.ready;
  const store = new ProviderStore(ctx, env);
  await test('Legacy migration retains shared Providers/keys and seeds selections/flags once', async () => {
    assert.equal(store.getCurrentProviderId('codex'), 'old-api'); assert.equal(store.getToolEnabled('claude'), false);
    assert.equal(store.getProviders()[0].secretRef, 'original-shared-ref'); assert.equal(secrets.get('original-shared-ref'), 'synthetic-legacy-api-key');
    await store.setCurrentProviderId('codex', undefined); await store.setToolEnabled('claude', true);
    values.set('vscodemodelswitch.currentProviderIds', { codex: 'someone-elses-provider' });
    values.set('vscodemodelswitch.toolEnabled', { claude: false, codex: false });
    const reconnect = new EnvironmentState(ctx); await reconnect.ready;
    const restored = new ProviderStore(ctx, reconnect);
    assert.equal(restored.getCurrentProviderId('codex'), undefined); assert.equal(restored.getToolEnabled('claude'), true); assert.equal(restored.getToolEnabled('codex'), true);
    assert.equal(reconnect.id, env.id);
  });
  await test('Ambiguous legacy network settings/backups are retained without adoption or editor writes', () => {
    const before = structuredClone(values.get('vscodemodelswitch.networkProxy'));
    const manager = new NetworkProxyManager(ctx, env);
    assert.deepEqual(manager.environment('codex'), {}); assert.equal(manager.state().tools.codex.config, undefined);
    assert.deepEqual(values.get('vscodemodelswitch.networkProxy'), before);
    assert.equal(secrets.get('vscodemodelswitch.networkProxy.backup'), 'synthetic-original-backup'); assert.equal(settingWrites, 0);
    manager.dispose();
  });
  await test('legacy shared identity setting is retained without automatic credential migration', async () => {
    values.set('vscodemodelswitch.codexIdentityStorage', path.join(root, 'old-private-library'));
    const first = new SessionController(ctx, env); await first.ready;
    assert.equal((await first.state()).root, undefined);
    assert.match((await first.state()).message, /旧版/);
    assert.equal(values.get('vscodemodelswitch.codexIdentityStorage'), path.join(root, 'old-private-library'));
  });
  Module._load = original;
}
