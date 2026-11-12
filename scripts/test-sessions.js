'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CodexProfiles } = require('../out/clients/codex/history/codexProfiles');
const { listSessions, backupHistory, restoreHistory } = require('../out/clients/codex/history/codexHistory');
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
async function write(home, file, text) { const target = path.join(home, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); }
const rollout = id => JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/fixture', model_provider: 'openai' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic ' + id } }) + '\n';
async function main() {
  const temp = await fs.mkdtemp(path.join(process.env.VSCODEMODELSWITCH_TEST_HOME || os.tmpdir(), 'shared-codex-')); console.log('RETAINED_FIXTURE: ' + temp);
  const root = path.join(temp, 'ai_client_data/codex'), runtimeA = path.join(temp, 'container-a/custom-codex-home'), runtimeB = path.join(temp, 'host/custom-home');
  const a = new CodexProfiles(root, runtimeA, 'env-a'), b = new CodexProfiles(root, runtimeB, 'env-b');
  await write(runtimeA, 'auth.json', '{"tokens":{"access_token":"synthetic-a"}}');
  await write(runtimeA, 'config.toml', 'model = "fixture-a"\n');
  await write(runtimeA, 'sessions/2026/11/10/rollout-old.jsonl', rollout('old'));
  await write(runtimeA, 'state_5.sqlite', 'opaque-fixture-index');
  await test('enrollment preserves original data and creates documented portable layout', async () => {
    await a.initialize('official'); await a.assertAttached();
    for (const name of ['readme.md', 'profiles', 'providers', 'environments', 'backups']) assert.ok(await fs.stat(path.join(root, name)));
    assert.equal((await fs.lstat(runtimeA)).isSymbolicLink(), false);
    assert.ok((await fs.readdir(runtimeA)).some(n => n.startsWith('sessions.before-vscodemodelswitch-')));
    assert.ok((await fs.readdir(a.environmentDirectory)).some(n => n.startsWith('original-home-')));
  });
  const first = (await a.read()).identities[0]; let second, api;
  await test('another environment connects the same history without inheriting auth or config', async () => {
    await b.attach(first.id); await b.assertAttached();
    assert.equal((await b.read()).activeId, first.id);
    await assert.rejects(fs.readFile(path.join(runtimeB, 'auth.json')), { code: 'ENOENT' });
    assert.doesNotMatch(await fs.readFile(path.join(runtimeB, 'config.toml'), 'utf8'), /fixture-a/);
    assert.match(await fs.readFile(path.join(runtimeA, 'auth.json'), 'utf8'), /synthetic-a/);
    assert.equal(await fs.realpath(path.join(runtimeA, 'sessions')), await fs.realpath(path.join(runtimeB, 'sessions')));
  });
  await test('new chat writes directly into shared storage and is visible through both runtime paths', async () => {
    await write(runtimeB, 'sessions/2026/11/10/rollout-new.jsonl', rollout('new'));
    assert.equal(await fs.readFile(path.join(runtimeA, 'sessions/2026/11/10/rollout-new.jsonl'), 'utf8'), rollout('new'));
    assert.deepEqual(new Set((await listSessions(a.home(first))).map(s => s.id)), new Set(['old', 'new']));
    await assert.rejects(fs.readFile(path.join(a.home(first), 'auth.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(a.sqliteHome(first), 'state_5.sqlite'), 'utf8'), 'opaque-fixture-index');
  });
  await test('same-account refreshed authentication remains private to each environment', async () => {
    await write(runtimeB, 'auth.json', '{"tokens":{"access_token":"synthetic-b"}}');
    await write(runtimeB, 'config.toml', (await fs.readFile(path.join(runtimeB, 'config.toml'), 'utf8')) + 'model = "fixture-b"\n');
    second = await a.add('Account B', 'official'); await a.switchTo(second.id);
    await write(runtimeA, 'auth.json', '{"tokens":{"access_token":"synthetic-a-second"}}');
    assert.equal((await b.read()).activeId, first.id);
    await a.switchTo(first.id); await a.assertAttached();
    assert.match(await fs.readFile(path.join(runtimeA, 'auth.json'), 'utf8'), /synthetic-a"/);
    assert.match(await fs.readFile(path.join(runtimeB, 'auth.json'), 'utf8'), /synthetic-b/);
    assert.match(await fs.readFile(path.join(runtimeA, 'config.toml'), 'utf8'), /fixture-a/);
    assert.match(await fs.readFile(path.join(runtimeB, 'config.toml'), 'utf8'), /fixture-b/);
  });
  await test('official account B is isolated and every API provider uses one shared API history', async () => {
    await a.switchTo(second.id); assert.equal((await listSessions(a.home(second))).length, 0);
    api = await a.add('API history', 'api'); assert.equal((await b.add('Different provider', 'api')).id, api.id);
    await a.switchTo(api.id); await write(runtimeA, 'sessions/rollout-api.jsonl', rollout('api'));
    await b.switchTo(api.id); assert.equal(await fs.readFile(path.join(runtimeB, 'sessions/rollout-api.jsonl'), 'utf8'), rollout('api'));
    await assert.rejects(fs.readFile(path.join(runtimeB, 'auth.json')), { code: 'ENOENT' });
  });
  await test('reconnection restores environment selection while a new environment starts unbound', async () => {
    const reconnected = new CodexProfiles(root, runtimeA, 'env-a'); await reconnected.assertAttached(); assert.equal((await reconnected.read()).activeId, api.id);
    const fresh = new CodexProfiles(root, path.join(temp, 'new/.codex'), 'new-env'); assert.equal((await fresh.read()).activeId, '');
    await fresh.attach(first.id); await assert.rejects(fs.readFile(path.join(fresh.runtimeHome, 'auth.json')), { code: 'ENOENT' });
  });
  await test('renaming shared account keeps stable identity and does not change bindings', async () => {
    await a.rename(first.id, 'Renamed Account'); assert.equal((await b.read()).identities.find(i => i.id === first.id).name, 'Renamed Account');
    assert.equal((await b.read()).activeId, api.id);
  });
  let backup;
  await test('manual backup includes SQLite directory and rollouts but excludes every auth/config', async () => {
    backup = await backupHistory(a.home(first), path.join(root, 'backups'), 'official', first.name);
    const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
    assert.ok(manifest.files.some(f => f.file === 'sqlite/state_5.sqlite'));
    assert.ok(manifest.files.some(f => f.file.includes('rollout-new')));
    assert.ok(!manifest.files.some(f => /auth|config/.test(f.file)));
  });
  await test('restore creates inactive history and leaves current selection/data untouched', async () => {
    const id = await restoreHistory(a, backup), manifest = await a.read();
    assert.equal(manifest.activeId, api.id); const restored = manifest.identities.find(i => i.id === id);
    assert.equal((await listSessions(a.home(restored))).length, 2); await assert.rejects(fs.readFile(path.join(a.home(restored), 'auth.json')), { code: 'ENOENT' });
  });
  await test('tampered backups and credential-file injection are rejected before publishing an identity', async () => {
    const target = path.join(temp, 'tampered'); await fs.cp(backup, target, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
    await fs.writeFile(path.join(target, manifest.files[0].file), 'tampered');
    await assert.rejects(restoreHistory(a, target), /checksum/);
    manifest.files.push({ file: 'auth.json', sha256: 'a'.repeat(64) });
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(restoreHistory(a, target), /non-history/);
  });
  await test('broken directory link is reported rather than silently creating a second history', async () => {
    await fs.unlink(path.join(runtimeA, 'sessions')); await fs.mkdir(path.join(runtimeA, 'sessions'));
    await assert.rejects(a.assertAttached(), /链接已失效/);
    await a.attach(api.id); await a.assertAttached();
    assert.equal(await fs.realpath(path.join(runtimeA, 'sessions')), await fs.realpath(path.join(a.home(api), 'sessions')));
  });
  await test('legacy migration retains every original and only imports its owning environment caches', async () => {
    const source = path.join(temp, 'legacy'), target = new CodexProfiles(path.join(temp, 'migrated/codex'), path.join(temp, 'legacy-runtime'), 'env-a');
    const identity = { id: 'old-a', name: 'Legacy A', kind: 'official', directory: 'home-old-a' };
    await write(source, 'identities.json', JSON.stringify({ version: 1, environmentId: 'env-a', activeId: 'old-a', identities: [identity] }));
    await write(path.join(source, identity.directory), 'auth.json', 'synthetic-legacy');
    await write(path.join(source, identity.directory), 'sessions/rollout.jsonl', rollout('legacy'));
    await target.importLegacy(source); await target.assertAttached();
    assert.equal(await fs.readFile(path.join(target.runtimeHome, 'auth.json'), 'utf8'), 'synthetic-legacy');
    assert.equal(await fs.readFile(path.join(source, identity.directory, 'auth.json'), 'utf8'), 'synthetic-legacy');
    const foreign = new CodexProfiles(path.join(temp, 'foreign'), path.join(temp, 'foreign-home'), 'env-b');
    await assert.rejects(foreign.importLegacy(source), /不会读取其他环境/);
    await assert.rejects(target.importLegacy(source), /不自动合并/);
  });
  console.log('RESULT: ' + count + ' storage checks passed, 0 failed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
