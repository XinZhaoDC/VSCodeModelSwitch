'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const original = Module._load;
let savePath, openPath, selection, opened;
const vscode = { env: { language: 'zh-CN' }, window: {
  showSaveDialog: async () => ({ fsPath: savePath }), showOpenDialog: async () => [{ fsPath: openPath }], showInformationMessage: async () => undefined,
  showQuickPick: async choices => typeof selection === 'function' ? selection(choices) : selection,
  showTextDocument: async document => { opened = document; }
}, Uri: { file: fsPath => ({ fsPath }) }, workspace: { openTextDocument: async uri => uri }, commands: { executeCommand() { throw Error('Do not launch OS manager or replace workspace'); } } };
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
const { historyBackups, removeHistoryBackup } = require('../out/storage/historyBackups');
const { backupHistory } = require('../out/clients/codex/history/codexHistory');
const { browseFiles } = require('../out/ui/fileBrowser');
const { VSModelSwitchApp } = require('../out/app');
const { ReloadState } = require('../out/storage/reloadState');
const { readOfficialCodexInfo } = require('../out/clients/codex/diagnostics/info');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswitch-management-')), home = path.join(root, 'history'), backupRoot = path.join(root, 'backups');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(home, 'sessions', 'conversation.jsonl'), '{"message":"synthetic first"}\n');
  await fs.writeFile(path.join(home, 'auth.json'), 'synthetic-auth-excluded'); await fs.writeFile(path.join(home, 'config.toml'), 'synthetic-config-excluded');
  let count = 0; const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  let first, second;
  await test('history backups create independent full snapshots and exclude auth/client config', async () => {
    first = await backupHistory(home, backupRoot, 'official', 'Account A'); await fs.appendFile(path.join(home, 'sessions/conversation.jsonl'), '{"message":"synthetic second"}\n');
    second = await backupHistory(home, backupRoot, 'official', 'Account A'); assert.notEqual(first, second);
    assert.doesNotMatch(await fs.readFile(path.join(first, 'sessions/conversation.jsonl'), 'utf8'), /second/); assert.match(await fs.readFile(path.join(second, 'sessions/conversation.jsonl'), 'utf8'), /second/);
    assert.ok(!(await fs.readdir(first)).includes('auth.json')); assert.ok(!(await fs.readdir(first)).includes('config.toml'));
  });
  await test('backup browser exposes time/name/size and rejects outside paths and changed selections', async () => {
    const snapshots = await historyBackups(backupRoot); assert.equal(snapshots.length, 2); assert.ok(snapshots.every(b => b.complete && b.bytes > 0 && b.name === 'Account A' && b.createdAt));
    await assert.rejects(removeHistoryBackup(backupRoot, { ...snapshots[0], directory: home }));
    const selected = snapshots.find(b => b.directory === first); await fs.appendFile(path.join(first, 'manifest.json'), ' '); await assert.rejects(removeHistoryBackup(backupRoot, selected));
    const renewed = (await historyBackups(backupRoot)).find(b => b.directory === first); await removeHistoryBackup(backupRoot, renewed); await fs.access(second); await fs.access(home);
  });
  await test('directory symlinks are excluded from backup deletion candidates', async () => {
    await fs.symlink(home, path.join(backupRoot, 'codex-history-11111111-1111-1111-1111-111111111111')); assert.equal((await historyBackups(backupRoot)).length, 1);
  });
  const api = { id: 'api', name: 'API', tool: 'codex', codexMode: 'api', baseUrl: 'https://example.invalid/v1', secretRef: 'synthetic-reference', modelPolicy: { type: 'fixed', model: 'fixture' }, configText: 'model_provider="OpenAI"\n[model_providers.OpenAI]\nexperimental_bearer_token="synthetic-export-key"\nbase_url="https://example.invalid/v1"\n', usageQuery: { enabled: true, preset: 'custom' }, proxy: { mode: 'proxy', preset: 'custom', apiFormat: 'responses', overrides: { timeoutMs: 12345 } }, createdAt: '2026-01-01', updatedAt: '2026-01-02' };
  const cc = { ...api, id: 'cc', name: 'CC', tool: 'claude' }; let providers = [api, cc];
  const app = Object.create(VSModelSwitchApp.prototype);
  app.store = { getProviders: () => providers, getProvidersByTool: tool => providers.filter(p => p.tool === tool), getProvider: id => providers.find(p => p.id === id), saveProviders: async value => { providers = value; }, setCurrentProviderId() { throw Error('Import must not change active selections'); } };
  const shared = new Map(), local = new Map();
  const storage = map => ({ get: (k, fallback) => map.get(k) ?? fallback, update: async (k, v) => map.set(k, structuredClone(v)) });
  const { ProviderOrganizationStore } = require('../out/shared/providers/organization');
  app.codexOrganization = new ProviderOrganizationStore('codex', storage(shared), storage(local), () => providers);
  app.sessionController = { state: async () => ({ root, legacy: false }) }; app.refreshStatus = () => {};
  await test('save-as and data-folder exports have identical full Codex-only content without stored keys', async () => {
    await app.exportCodexProviders(); const files = await fs.readdir(path.join(root, 'providers')); savePath = path.join(root, 'save-as.json'); await app.exportPublicConfig('codex');
    const a = JSON.parse(await fs.readFile(savePath)), b = JSON.parse(await fs.readFile(path.join(root, 'providers', files[0])));
    assert.deepEqual(a, b); assert.equal(a.providers.length, 1); assert.equal(a.providers[0].proxy.overrides.timeoutMs, 12345); assert.equal(a.providers[0].usageQuery.enabled, true);
    assert.ok(!JSON.stringify(a).includes('synthetic-export-key')); assert.equal(a.currentProviderIds, undefined);
  });
  await test('Codex-only replace import keeps Claude definitions and active selections untouched', async () => {
    openPath = savePath; selection = { value: 'replace' }; const before = structuredClone(cc); await app.importPublicConfig('codex'); assert.deepEqual(providers.find(p => p.id === 'cc'), before); assert.equal(providers.filter(p => p.tool === 'codex').length, 1);
  });
  await test('file browser opens chosen documents in VS Code and treats cancellation neutrally', async () => {
    selection = choices => choices.find(p => p.path === path.join(root, 'save-as.json'));
    assert.equal(await browseFiles(root, 'Browse'), true); assert.equal(opened.fsPath, savePath); await app.sessionActionFromSidebar('openFolder'); assert.equal(opened.fsPath, savePath); selection = undefined; assert.equal(await browseFiles(root, 'Browse'), false);
  });
  await test('required reload clears only after a new activation validates configuration', async () => {
    const state = new Map(); const environment = { get: (k, fallback) => state.get(k) ?? fallback, update: async (k, v) => state.set(k, v) };
    const first = new ReloadState(environment); await first.add('codex', 'mode', 'changed', true); await first.acknowledgeStartup(() => true); assert.equal(first.entries().length, 1);
    const second = new ReloadState(environment); await second.acknowledgeStartup(() => false); assert.equal(second.entries().length, 1); await second.acknowledgeStartup(() => true); assert.equal(second.entries().length, 0);
  });
  await test('official model/quota RPC returns only whitelisted data and never account identifiers', async () => {
    const server = path.join(root, 'rpc.cjs'); await fs.writeFile(server, `let buffer='';process.stdin.on('data',b=>{buffer+=b;for(;;){let end=buffer.indexOf('\\n');if(end<0)break;let m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{id:'fixture-model'}],account_id:'synthetic-private-id'}:m.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:25,windowDurationMins:300}},account_id:'synthetic-private-id'}:{}})+'\\n');}});`);
    const result = await readOfficialCodexInfo(server, root, {}); assert.deepEqual(result.models, ['fixture-model']); assert.equal(result.windows[0].usedPercent, 25); assert.ok(!JSON.stringify(result).includes('synthetic-private-id'));
  });
  await test('terminal launch uses each tool route without applying a provider or sharing other-tool variables', async () => {
    const opened = {}; app.lastEnv = { OPENAI_BASE_URL: 'http://codex.invalid', ANTHROPIC_BASE_URL: 'http://claude.invalid' };
    app.networkProxy = { environment: tool => ({ HTTPS_PROXY: tool === 'codex' ? 'http://127.0.0.1:15001' : 'http://127.0.0.1:15002' }) };
    app.terminalManager = { openCodex: env => { opened.codex = env; }, openClaude: env => { opened.claude = env; } };
    app.applyProvider = () => { throw Error('Opening a terminal must not Apply'); }; app.sessionController.assertReady = () => {};
    await app.openClaudeTerminal(); await app.openCodexTerminal(); assert.equal(opened.claude.HTTPS_PROXY, 'http://127.0.0.1:15002'); assert.equal(opened.codex.HTTPS_PROXY, 'http://127.0.0.1:15001');
    assert.equal(opened.claude.OPENAI_BASE_URL, undefined); assert.equal(opened.codex.ANTHROPIC_BASE_URL, undefined);
  });
  console.log('RESULT: ' + count + ' management/reload checks passed; retained fixture ' + root);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
