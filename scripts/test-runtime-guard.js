'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const prompts = [], answers = [];
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { env: { language: 'en' }, window: { showWarningMessage: async (...args) => { prompts.push(args); const answer = answers.shift(); return answer === undefined ? undefined : args.slice(2).find(item => item.title === answer) || { title: answer }; } }, extensions: { getExtension() { throw Error('Must not inspect extension task status'); } } };
  if (name === 'child_process') throw Error('Must not scan processes');
  return original.call(this, name, ...args);
};
const { confirmCodexChange } = require('../out/shared/runtimeGuard');
(async () => {
  let count = 0; const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  await test('dismissal cancels without any process or extension status inspection', async () => { assert.equal(await confirmCodexChange('切换账号'), false); answers.push('取消'); assert.equal(await confirmCodexChange('切换账号'), false); });
  await test('every impactful change receives one modal, including idle clients', async () => {
    const before = prompts.length; answers.push('确认执行'); assert.equal(await confirmCodexChange('应用 Provider'), true); assert.equal(prompts.length, before + 1);
  });
  await test('the dialog describes both extension and CLI impacts without claiming detection', () => {
    const [text, options, accept, cancel] = prompts.at(-1);
    assert.match(text, /Codex 扩展和 CLI/); assert.match(text, /不会自动检测或停止/); assert.match(text, /等待正在进行的任务结束/); assert.match(text, /手动处理/); assert.equal(options.modal, true); assert.equal(accept.title, '确认执行'); assert.equal(cancel.title, '取消'); assert.equal(cancel.isCloseAffordance, true); assert.doesNotMatch(text, /this changes|Wait for|Failed file/);
  });
  await test('old force/retry answers cannot authorize a change', async () => {
    for (const answer of ['强制更改', '确认强制更改', '重试检测']) { answers.push(answer); assert.equal(await confirmCodexChange('fixture'), false); }
  });
  console.log('RESULT: ' + count + ' operation confirmation checks passed, 0 failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
