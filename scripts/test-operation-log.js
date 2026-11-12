'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OperationLog, operationFailure } = require('../out/storage/operationLog');
(async () => {
  const root = await fs.mkdtemp(path.join(process.env.VSCODEMODELSWITCH_TEST_HOME || os.tmpdir(), 'operation-logs-'));
  let count = 0; const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  const source = path.join(root, 'default'), destination = path.join(root, 'data/codex/environments/env-a/logs');
  let saved, failPersist = false;
  const log = new OperationLog(source, 'env-a', 'fixture', async directory => { if (failPersist) throw Error('synthetic persistence failure'); saved = directory; });
  const event = { id: 'test-1', action: 'ready', status: 'started', target: 'codex:overview' };
  await test('default logs exist before a user selects any data directory', async () => {
    await log.write(event); assert.match(await log.text(), /"action":"ready"/);
  });
  await test('only allowlisted metadata is saved, without credentials, response bodies or chat', async () => {
    const error = Object.assign(Error('Server said synthetic-token and chat content'), { code: 'ECONNREFUSED' });
    await log.write({ ...event, status: 'failed', ...operationFailure(error), key: 'synthetic-token', prompt: 'private chat', response: { auth: 'secret' } });
    const text = await log.text(); assert.doesNotMatch(text, /synthetic-token|private chat|Server said|"response"|"key"/); assert.match(text, /ECONNREFUSED/);
  });
  await test('history is copied and verified before publishing a new path, then removed from old path', async () => {
    const before = await log.text(); await log.move(destination);
    assert.equal(log.directory, destination); assert.equal(saved, destination); assert.equal(await log.text(), before); assert.deepEqual(await fs.readdir(source), []);
    await log.write({ ...event, status: 'succeeded' }); assert.match(await log.text(), /succeeded/);
  });
  await test('a conflicting destination never overwrites source or existing destination', async () => {
    const conflict = path.join(root, 'conflict'); await fs.mkdir(conflict);
    const file = (await fs.readdir(destination))[0]; await fs.writeFile(path.join(conflict, file), 'existing unrelated bytes');
    const before = await log.text(); await assert.rejects(log.move(conflict), /校验失败/);
    assert.equal(log.directory, destination); assert.equal(await log.text(), before); assert.equal(await fs.readFile(path.join(conflict, file), 'utf8'), 'existing unrelated bytes');
  });
  await test('failed path persistence retains the complete original logs and active location', async () => {
    const before = await log.text(); failPersist = true;
    await assert.rejects(log.move(path.join(root, 'persist-failed')), /persistence/); failPersist = false;
    assert.equal(log.directory, destination); assert.equal(await log.text(), before);
  });
  await test('unwritable target leaves logs usable and source intact', async () => {
    const file = path.join(root, 'not-a-directory'); await fs.writeFile(file, 'fixture');
    const before = await log.text(); await assert.rejects(log.move(path.join(file, 'logs'))); await log.write({ ...event, id: 'after-failure' }); assert.ok((await log.text()).includes(before.trim()));
  });
  await test('refresh reconciles late append-only writes from another window without losing history', async () => {
    const first = new OperationLog(path.join(root, 'multi-source'), 'env-a', 'fixture');
    await first.write({ ...event, id: 'before-move' });
    const second = new OperationLog(first.directory, 'env-a', 'fixture');
    const originalSource = first.directory;
    await second.move(path.join(root, 'multi-target'));
    // The original writer was still at its old path and recreates its own file.
    await first.write({ ...event, id: 'late-write' });
    await first.move(second.directory);
    const text = await first.text(); assert.match(text, /before-move/); assert.match(text, /late-write/);
    assert.deepEqual(await fs.readdir(originalSource), []);
  });
  await test('same-folder symlink does not delete the only copy', async () => {
    const alias = path.join(root, 'alias'); await fs.symlink(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await log.text(); await log.move(alias); assert.equal(await log.text(), before);
  });
  await test('another instance can reload persisted location without mixing environments', async () => {
    const reloaded = new OperationLog(saved, 'env-a', 'fixture'); assert.match(await reloaded.text(), /test-1/);
    const other = new OperationLog(path.join(root, 'env-b/logs'), 'env-b', 'fixture'); assert.equal(await other.text(), '');
  });
  await test('bounded rotation retains recent events', async () => {
    const bounded = new OperationLog(path.join(root, 'bounded'), 'env-a', 'fixture', undefined, { fileBytes: 400, totalBytes: 1000 });
    for (let i = 0; i < 30; i++) await bounded.write({ ...event, id: 'event-' + i });
    const files = await fs.readdir(bounded.directory); const size = (await Promise.all(files.map(f => fs.stat(path.join(bounded.directory, f))))).reduce((n, st) => n + st.size, 0);
    assert.ok(size <= 1000); assert.match(await bounded.text(), /event-29/); assert.doesNotMatch(await bounded.text(), /"id":"event-0"/);
  });
  await test('delete affects only owned operation logs, preserving config, chat and recovery files', async () => {
    for (const name of ['auth.json', 'config.toml', 'rollout.jsonl', 'journal.json', 'user.log']) await fs.writeFile(path.join(destination, name), 'do-not-delete');
    assert.ok(await log.clear() > 0); assert.equal(await log.text(), '');
    assert.deepEqual((await fs.readdir(destination)).sort(), ['auth.json', 'config.toml', 'journal.json', 'rollout.jsonl', 'user.log'].sort());
    await log.write({ ...event, id: 'deleted', status: 'succeeded' }); assert.match(await log.text(), /deleted/);
  });
  await test('rollback results are distinguishable without persisting the exception message', () => {
    assert.equal(operationFailure(Error('操作失败，已恢复到本次操作前的状态。')).recovery, 'restored');
    assert.equal(operationFailure(Error('操作失败，回滚未完成')).recovery, 'manual');
  });
  console.log('RESULT: ' + count + ' operation log checks passed, 0 failed'); console.log('RETAINED_FIXTURE: ' + root);
})().catch(error => { console.error(error); process.exitCode = 1; });
