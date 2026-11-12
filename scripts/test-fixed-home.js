'use strict';
// Synthetic Linux mount-point behavior; never mount, inspect or change a real home.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { CodexProfiles } = require('../out/clients/codex/history/codexProfiles');
const names = ['config.toml', 'auth.json', '.modelswitch-environment.json'];
async function write(file, content) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, content, { mode: 0o600 }); }
async function atomic(file, content) { await write(file + '.native-next', content); await fs.rename(file + '.native-next', file); }
async function files(home) { return Promise.all(names.map(n => fs.readFile(path.join(home, n), 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null; }))); }
if (process.argv[2] === '--crash') {
  const [root, runtime, env, id] = process.argv.slice(3);
  new CodexProfiles(root, runtime, env, async () => process.exit(17)).switchTo(id).catch(e => { console.error(e); process.exit(18); });
} else main().catch(e => { console.error(e); process.exitCode = 1; });
async function main() {
  if (process.platform !== 'linux') { console.log('SKIP Linux fixed-home checks'); return; }
  const temp = await fs.mkdtemp(path.join(process.env.VSCODEMODELSWITCH_TEST_HOME || os.tmpdir(), 'fixed-home-'));
  console.log('RETAINED_FIXTURE: ' + temp);
  const runtime = path.join(temp, 'container/.codex'), root = path.join(temp, 'data/codex');
  await write(path.join(runtime, 'auth.json'), 'synthetic-a');
  await write(path.join(runtime, 'config.toml'), 'model = "a-initial"\n');
  await write(path.join(runtime, 'sessions/original.jsonl'), 'synthetic original chat');
  const inode = (await fs.stat(runtime)).ino, rename = fs.rename;
  let rootRenameAttempts = 0, childBusy = false, count = 0;
  fs.rename = async (source, target) => {
    if (path.resolve(source) === runtime) { rootRenameAttempts++; throw Object.assign(Error('synthetic mounted root'), { code: 'EBUSY' }); }
    if (childBusy && path.resolve(source) === path.join(runtime, 'sessions')) throw Object.assign(Error('synthetic mounted child'), { code: 'EBUSY' });
    return rename(source, target);
  };
  const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  const a = new CodexProfiles(root, runtime, 'env-a'); let first, second, api;
  try {
    await test('EBUSY root stays in place and first enrollment preserves original files and history', async () => {
      await a.initialize('official'); await a.assertAttached(); first = (await a.read()).identities[0];
      assert.equal((await fs.stat(runtime)).ino, inode); assert.equal(rootRenameAttempts, 0);
      const original = (await fs.readdir(a.environmentDirectory)).find(n => n.startsWith('original-home-'));
      assert.equal(await fs.readFile(path.join(a.environmentDirectory, original, 'auth.json'), 'utf8'), 'synthetic-a');
      const history = (await fs.readdir(runtime)).find(n => n.startsWith('sessions.before-vscodemodelswitch-'));
      assert.equal(await fs.readFile(path.join(runtime, history, 'original.jsonl'), 'utf8'), 'synthetic original chat');
      await write(path.join(runtime, 'sessions/new.jsonl'), 'new direct chat');
      assert.equal(await fs.readFile(path.join(a.home(first), 'sessions/new.jsonl'), 'utf8'), 'new direct chat');
    });
    await test('native atomic refresh survives account switches without leaking into B or API', async () => {
      await atomic(path.join(runtime, 'auth.json'), 'synthetic-a-refreshed');
      await atomic(path.join(runtime, 'config.toml'), (await fs.readFile(path.join(runtime, 'config.toml'), 'utf8')) + 'model = "a-refreshed"\n');
      second = await a.add('B', 'official'); api = await a.add('API', 'api');
      await a.switchTo(second.id); assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), '');
      assert.doesNotMatch(await fs.readFile(path.join(runtime, 'config.toml'), 'utf8'), /a-refreshed/);
      await atomic(path.join(runtime, 'auth.json'), 'synthetic-b');
      await a.switchTo(api.id); assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), '');
      await a.switchTo(first.id); assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), 'synthetic-a-refreshed');
      assert.match(await fs.readFile(path.join(runtime, 'config.toml'), 'utf8'), /a-refreshed/);
      await a.attach(first.id); assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), 'synthetic-a-refreshed');
      await a.switchTo(second.id); assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), 'synthetic-b');
      await a.switchTo(first.id);
    });
    await test('explicit logout never resurrects cached credentials', async () => {
      await fs.unlink(path.join(runtime, 'auth.json')); await a.switchTo(second.id); await a.switchTo(first.id);
      assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), '');
      await atomic(path.join(runtime, 'auth.json'), 'synthetic-a-new-login');
    });
    await test('new environment shares rollouts but cannot inherit private credentials or model', async () => {
      const b = new CodexProfiles(root, path.join(temp, 'other/.codex'), 'env-b'); await fs.mkdir(b.runtimeHome, { recursive: true });
      await b.attach(first.id); await b.assertAttached();
      assert.equal(await fs.readFile(path.join(b.runtimeHome, 'auth.json'), 'utf8'), '');
      assert.doesNotMatch(await fs.readFile(path.join(b.runtimeHome, 'config.toml'), 'utf8'), /a-refreshed/);
      assert.equal(await fs.readFile(path.join(b.runtimeHome, 'sessions/new.jsonl'), 'utf8'), 'new direct chat');
      assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), 'synthetic-a-new-login');
    });
    await test('cross-library binding saves the previous environment cache and restores it on return', async () => {
      const c = new CodexProfiles(path.join(temp, 'other-data/codex'), runtime, 'env-a'); await c.bindEnvironment();
      const target = await c.add('Other library', 'official'); await c.attach(target.id);
      assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), '');
      assert.equal(await fs.readFile(path.join(a.localHome(first), 'auth.json'), 'utf8'), 'synthetic-a-new-login');
      await a.attach(first.id); await a.assertAttached(); assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), 'synthetic-a-new-login');
    });
    await test('late binding failure restores runtime files, links, active selection and previous cache', async () => {
      await atomic(path.join(runtime, 'auth.json'), 'synthetic-a-live');
      const before = await files(runtime), cached = await files(a.localHome(first)), binding = JSON.stringify(await a.read());
      const failing = new CodexProfiles(root, runtime, 'env-a', async () => { throw Error('injected activation failure'); });
      await assert.rejects(failing.switchTo(second.id), /已恢复.*injected activation failure/);
      assert.deepEqual(await files(runtime), before); assert.deepEqual(await files(a.localHome(first)), cached);
      assert.equal(JSON.stringify(await a.read()), binding); await a.assertAttached();
      await assert.rejects(fs.stat(a.recoveryDirectory), { code: 'ENOENT' });
    });
    await test('process crash recovery restores private state without rewinding new chats', async () => {
      const before = await files(runtime), cached = await files(a.localHome(first));
      assert.equal(await crash(root, runtime, 'env-a', second.id), 17);
      await write(path.join(a.home(second), 'sessions/during-crash.jsonl'), 'new chat retained');
      assert.match(await a.recover(), /意外退出/); await a.assertAttached();
      assert.deepEqual(await files(runtime), before); assert.deepEqual(await files(a.localHome(first)), cached);
      assert.equal(await fs.readFile(path.join(a.home(second), 'sessions/during-crash.jsonl'), 'utf8'), 'new chat retained');
    });
    await test('external changes after crash are preserved and recovery can be retried explicitly', async () => {
      assert.equal(await crash(root, runtime, 'env-a', second.id), 17);
      const interim = await fs.readFile(path.join(runtime, 'auth.json'), 'utf8');
      await atomic(path.join(runtime, 'auth.json'), 'external-edit'); await assert.rejects(a.recover(), /冲突/);
      assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), 'external-edit'); assert.ok(await fs.stat(path.join(a.recoveryDirectory, 'journal.json')));
      await atomic(path.join(runtime, 'auth.json'), interim); await a.recover(); await a.assertAttached();
    });
    await test('independently busy history child gives an explicit error and rolls back all private changes', async () => {
      await fs.unlink(path.join(runtime, 'sessions')); await fs.mkdir(path.join(runtime, 'sessions'));
      await write(path.join(runtime, 'sessions/independent.jsonl'), 'keep child');
      const before = await files(runtime), cached = await files(a.localHome(first)); childBusy = true;
      try { await assert.rejects(a.attach(first.id), /已恢复.*子目录的挂载/); } finally { childBusy = false; }
      assert.deepEqual(await files(runtime), before); assert.deepEqual(await files(a.localHome(first)), cached);
      assert.equal(await fs.readFile(path.join(runtime, 'sessions/independent.jsonl'), 'utf8'), 'keep child');
      await a.attach(first.id); await a.assertAttached();
    });
    await test('foreign environment markers are rejected before private caches or registry are created', async () => {
      const foreign = new CodexProfiles(path.join(temp, 'foreign-data/codex'), runtime, 'foreign-env');
      await assert.rejects(foreign.initialize('official'), /另一个环境/);
      await assert.rejects(fs.stat(foreign.root), { code: 'ENOENT' });
      assert.equal((await fs.stat(runtime)).ino, inode); assert.equal(rootRenameAttempts, 0); await a.assertAttached();
    });
    await test('retry connects an already prepared profile after a failed first enrollment without clearing data', async () => {
      const retryHome = path.join(temp, 'retry/.codex'), retryRoot = path.join(temp, 'retry-data/codex');
      await write(path.join(retryHome, 'auth.json'), 'synthetic-retry');
      await write(path.join(retryHome, 'sessions/retry.jsonl'), 'prepared chat');
      const failed = new CodexProfiles(retryRoot, retryHome, 'env-retry', async () => { throw Error('first enrollment failed'); });
      await assert.rejects(failed.initialize('official'), /已恢复/);
      const prepared = await failed.read(); assert.equal(prepared.identities.length, 1); assert.equal(prepared.activeId, '');
      const cachedMarker = path.join(failed.localHome(prepared.identities[0]), '.modelswitch-environment.json');
      await write(cachedMarker, JSON.stringify({ version: 2, environmentId: 'env-retry', profileId: prepared.identities[0].id })); // 0.9.4 prepared cache.
      const retry = new CodexProfiles(retryRoot, retryHome, 'env-retry');
      await retry.attach(prepared.identities[0].id); await retry.assertAttached();
      assert.equal(await fs.readFile(path.join(retryHome, 'auth.json'), 'utf8'), 'synthetic-retry');
      assert.equal(await fs.readFile(path.join(retryHome, 'sessions/retry.jsonl'), 'utf8'), 'prepared chat');
    });
  } finally { fs.rename = rename; }
  console.log('RESULT: ' + count + ' fixed-home checks passed, 0 failed');
}
function crash(...args) { return new Promise((resolve, reject) => { const child = fork(__filename, ['--crash', ...args], { stdio: 'inherit' }); child.once('error', reject); child.once('exit', resolve); }); }
