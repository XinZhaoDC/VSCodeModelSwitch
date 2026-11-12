'use strict';
// Exercise user-visible controls through the actual webview script and host
// message bridge. Data, credentials and controller effects are synthetic.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { sidebarFixture } = require('./sidebar-fixture');
const original = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? { env: { language: 'en' }, window: { showErrorMessage() { throw Error('Unexpected popup'); } } } : original.call(this, name, ...args); };
const { SidebarViewProvider } = require('../out/ui/sidebarView');
const provider = id => ({ id, name: id, tool: 'codex', codexMode: 'api', baseUrl: 'https://fixture.invalid/v1', modelPolicy: { type: 'fixed', model: 'fixture-model' }, hasKey: true, configMode: 'generated', usageEnabled: false, proxy: { mode: 'direct' } });
const state = {
  providers: [provider('api-a'), provider('api-b')], currentProviderIds: { codex: 'api-a' }, apiStatuses: [{ tool: 'codex', mode: 'official', status: 'signedIn' }], codexMode: 'official',
  toolEnabled: { codex: true, claude: true }, storageSizes: {}, configPaths: { codex: '/synthetic/.codex/config.toml' }, status: { kind: 'ready' }, globalCliSync: true, configTarget: 'real',
  sessions: { root: '/synthetic/shared/codex', runtimeHome: '/synthetic/.codex', attached: true, environmentId: 'env-a', activeId: 'official-a', identities: [{ id: 'official-a', kind: 'official', name: 'Account A' }, { id: 'official-b', kind: 'official', name: 'Account B' }, { id: 'api', kind: 'api', name: 'API' }] }
};
const config = { url: 'http://127.0.0.1:12000', noProxy: 'localhost,127.0.0.1,::1', note: 'old note', codex: true, claude: false };
async function main() {
  let passed = 0, failed = 0;
  const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } };
  const ui = sidebarFixture(new SidebarViewProvider({}, {}).getHtml()), e = id => ui.elements.get(id);
  const finish = value => { ui.fire({ type: 'state', state: value }); ui.fire({ type: 'busy', busy: false }); };
  async function click(id, expected, value = state) {
    finish(value); const element = e(id); assert.ok(element && !element.disabled, id + ' is usable'); assert.ok(element.listeners.click, id + ' has a click action');
    const old = ui.messages.length; element.listeners.click(); assert.equal(ui.messages.length, old + 1, id + ' emits exactly one action');
    const message = ui.messages.at(-1); for (const [k, v] of Object.entries(expected)) assert.deepEqual(message[k], v);
    let called;
    const controller = { recordOperation: async () => {}, getSidebarState: async () => value };
    if (expected.type === 'sessionAction') controller.sessionActionFromSidebar = async (...args) => { called = args; };
    else if (expected.type === 'logAction') controller.logActionFromSidebar = async (...args) => { called = args; };
    else return message;
    const host = new SidebarViewProvider({}, controller), replies = []; host.view = { webview: { postMessage: async m => replies.push(m) } }; await host.handleMessage(message);
    assert.equal(called?.[0], expected.action); assert.ok(replies.some(m => m.type === 'operationFeedback' && m.status === 'succeeded'));
    return message;
  }
  await test('overview keeps runtime config and storage panel shows the separate shared root', () => { finish(state); assert.match(e('codexOverviewFacts').textContent, /synthetic\/\.codex\/config.toml/); assert.match(e('sessionStorage').textContent, /synthetic\/shared\/codex/); });
  for (const [id, action] of [['sessionStorageButton', 'configure'], ['addIdentityButton', 'add'], ['openDataFolderButton', 'openFolder'], ['backupSessionsButton', 'backup'], ['manageBackupsButton', 'manageBackups'], ['deleteHistoryBackupsButton', 'deleteHistoryBackups'], ['storageHelpButton', 'help'], ['exportProvidersButton', 'exportProviders']]) await test(id + ' reaches its own storage/account action', () => click(id, { type: 'sessionAction', action }));
  for (const [id, action] of [['viewOperationLogButton', 'view'], ['openOperationLogButton', 'folder'], ['exportOperationLogButton', 'export']]) await test(id + ' reaches its own log action', () => click(id, { type: 'logAction', action }));
  await test('current official account diagnostics request current info and three generation rounds', async () => { await click('officialInfoButton', { type: 'officialInfo' }); await click('standardOfficialSpeedButton', { type: 'speedTest', runs: 3 }); });
  await test('account switching sends the selected stable profile id and not its alias', () => {
    finish(state); const row = e('officialAccountsList').children.find(n => n.dataset.identityId === 'official-b'); row.querySelectorAll('button')[0].listeners.click();
    assert.equal(ui.messages.at(-1).action, 'switch'); assert.equal(ui.messages.at(-1).identityId, 'official-b');
  });
  await test('API provider diagnostic/model actions retain their own provider identity', () => {
    const api = { ...state, codexMode: 'api', sessions: { ...state.sessions, activeId: 'api' } };
    for (const [label, type] of [['检查连接与额度', 'testProviderNetwork'], ['刷新模型列表', 'refreshProviderModels'], ['选择模型', 'updateProviderModel'], ['验证所选模型', 'verifyProviderModel'], ['测试生成与速度', 'speedTest']]) {
      finish(api); const card = [...e('codexProviders').querySelectorAll('[data-provider-id]')].find(n => n.dataset.providerId === 'api-b'); const button = card.querySelectorAll('button').find(n => n.textContent === label);
      assert.ok(button && !button.disabled, label + ' is usable'); button.listeners.click(); assert.equal(ui.messages.at(-1).type, type); assert.equal(ui.messages.at(-1).providerId, 'api-b');
      if (type === 'speedTest') assert.equal(ui.messages.at(-1).runs, 3);
    }
  });
  await test('changing only a network note immediately enables saving the change', () => {
    finish({ ...state, networkProxy: { tools: { codex: { config, managed: true } } } }); assert.equal(e('applyNetworkProxyButton').disabled, true);
    e('networkNote').value = 'new note'; e('networkNote').listeners.input(); assert.equal(e('applyNetworkProxyButton').disabled, false);
    e('applyNetworkProxyButton').listeners.click(); assert.equal(ui.messages.at(-1).config.note, 'new note');
  });
  await test('network tests show an explicit untested state after a fresh activation', () => {
    const fresh = sidebarFixture(new SidebarViewProvider({}, {}).getHtml()); fresh.fire({ type: 'state', state }); fresh.fire({ type: 'busy', busy: false });
    assert.match(fresh.elements.get('networkProxyTest').textContent, /尚未测试/);
  });
  await test('editing one tool network draft and changing pages does not apply or leak it to the other tool', () => {
    finish(state); e('networkProxyUrl').value = 'http://127.0.0.1:12345'; e('networkProxyUrl').listeners.input(); const before = ui.messages.length;
    e('claudePageTab').listeners.click(); assert.notEqual(e('networkProxyUrl').value, 'http://127.0.0.1:12345'); e('codexPageTab').listeners.click();
    assert.equal(e('networkProxyUrl').value, 'http://127.0.0.1:12345'); assert.equal(ui.messages.length, before);
  });
  console.log('RESULT: ' + passed + ' workflow checks passed, ' + failed + ' failed'); if (failed) process.exitCode = 1;
}
main().finally(() => { Module._load = original; }).catch(e => { console.error(e); process.exitCode = 1; });
