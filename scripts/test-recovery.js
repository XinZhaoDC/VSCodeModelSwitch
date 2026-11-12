'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { FileRecovery } = require('../out/config/recovery');
if (process.argv[2] === '--crash') {
  const [directory, file, link, destination] = process.argv.slice(3);
  FileRecovery.run(directory, async tx => { await tx.write(file, 'changed'); if (link) await tx.link(link, destination); process.exit(17); }).catch(e => { console.error(e); process.exit(18); });
} else main().catch(e => { console.error(e); process.exitCode = 1; });
async function main() {
  const root = await fs.mkdtemp(path.join(process.env.VSCODEMODELSWITCH_TEST_HOME || os.tmpdir(), 'recovery-')); console.log('RETAINED_FIXTURE: ' + root);
  let count = 0; const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  const file = path.join(root, 'config.toml'), auth = path.join(root, 'auth.json'), recovery = path.join(root, '.recovery/current');
  await fs.writeFile(file, 'original');
  await test('multi-file failure restores originals and restores original absence', async () => {
    await assert.rejects(FileRecovery.run(recovery, async tx => { await tx.write(file, 'changed'); await tx.write(auth, 'synthetic'); throw Error('injected second-phase failure'); }), /已恢复/);
    assert.equal(await fs.readFile(file, 'utf8'), 'original'); await assert.rejects(fs.stat(auth), { code: 'ENOENT' });
    await assert.rejects(fs.stat(recovery), { code: 'ENOENT' });
  });
  await test('success commits both files and removes temporary recovery material', async () => {
    await FileRecovery.run(recovery, async tx => { await tx.write(file, 'committed'); await tx.write(auth, 'synthetic'); });
    assert.equal(await fs.readFile(file, 'utf8'), 'committed'); await assert.rejects(fs.stat(recovery), { code: 'ENOENT' });
    assert.equal((await fs.stat(auth)).mode & 0o777, 0o600);
  });
  const original = path.join(root, 'runtime'), destination = path.join(root, 'new-home'); await fs.mkdir(original); await fs.mkdir(destination); await fs.writeFile(path.join(original, 'marker'), 'old');
  await test('directory-binding failure restores original directory and current files', async () => {
    await assert.rejects(FileRecovery.run(recovery, async tx => { await tx.write(file, 'half-applied'); await tx.link(original, destination); throw Error('injected binding failure'); }), /已恢复/);
    assert.equal(await fs.readFile(path.join(original, 'marker'), 'utf8'), 'old'); assert.equal(await fs.readFile(file, 'utf8'), 'committed');
  });
  await test('crashed process recovery restores multi-file state and directory link', async () => {
    const exit = await crash(recovery, file, original, destination); assert.equal(exit, 17);
    assert.match(await FileRecovery.recover(recovery), /意外退出/);
    assert.equal(await fs.readFile(file, 'utf8'), 'committed'); assert.equal(await fs.readFile(path.join(original, 'marker'), 'utf8'), 'old');
  });
  await test('external modification is never overwritten and recovery material remains', async () => {
    await crash(recovery, file); await fs.writeFile(file, 'external-edit');
    await assert.rejects(FileRecovery.recover(recovery), /冲突/);
    assert.equal(await fs.readFile(file, 'utf8'), 'external-edit'); assert.ok(await fs.stat(path.join(recovery, 'journal.json')));
    await fs.writeFile(file, 'changed'); await FileRecovery.recover(recovery); assert.equal(await fs.readFile(file, 'utf8'), 'committed');
  });
  await test('a live transaction cannot be recovered or entered by another operation', async () => {
    await FileRecovery.run(recovery, async tx => { await tx.write(file, 'live'); await assert.rejects(FileRecovery.recover(recovery), /尚未结束/); });
    assert.equal(await fs.readFile(file, 'utf8'), 'live');
  });
  await test('first successful directory enrollment retains original user data', async () => {
    await FileRecovery.run(recovery, tx => tx.link(original, destination));
    assert.equal(await fs.realpath(original), destination);
    const retained = (await fs.readdir(root)).find(n => n.startsWith('runtime.before-vscodemodelswitch-'));
    assert.equal(await fs.readFile(path.join(root, retained, 'marker'), 'utf8'), 'old');
  });
  console.log('RESULT: ' + count + ' recovery checks passed, 0 failed');
}
function crash(...args) { return new Promise((resolve, reject) => { const child = fork(__filename, ['--crash', ...args], { stdio: 'inherit' }); child.once('error', reject); child.once('exit', resolve); }); }
