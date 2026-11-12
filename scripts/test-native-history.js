'use strict';
// Optional read-only native app-server smoke: entirely synthetic homes, no login
// and no model turn. The fixture provider points at an unused loopback port.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { CodexProfiles } = require('../out/clients/codex/history/codexProfiles');
const binary = process.env.VSCODEMODELSWITCH_NATIVE_CODEX;
async function main() {
  if (!binary) { console.log('SKIP native Codex binary not specified'); return; }
  const root = await fs.mkdtemp(path.join(process.env.VSCODEMODELSWITCH_TEST_HOME || os.tmpdir(), 'native-history-'));
  console.log('RETAINED_FIXTURE: ' + root);
  const a = new CodexProfiles(path.join(root, 'ai_client_data/codex'), path.join(root, 'a/home'), 'env-a');
  await fs.mkdir(a.runtimeHome, { recursive: true }); // Fixed directory, like a bind-mounted CODEX_HOME.
  await a.initialize('official'); const identity = (await a.read()).identities[0];
  const b = new CodexProfiles(a.root, path.join(root, 'b/home'), 'env-b'); await b.attach(identity.id);
  const id = randomUUID(), now = new Date().toISOString();
  const filename = path.join(a.runtimeHome, 'sessions', now.slice(0,4), now.slice(5,7), now.slice(8,10), 'rollout-' + now.slice(0,19).replace(/:/g, '-') + '-' + id + '.jsonl');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const rows = [
    { timestamp: now, type: 'session_meta', payload: { id, timestamp: now, cwd: path.join(root, 'project'), originator: 'codex_vscode', cli_version: '0.166.0', source: 'vscode', model_provider: 'openai' } },
    { timestamp: now, type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic cross-environment history', images: [], local_images: [], text_elements: [] } },
    { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic cross-environment history' }] } }
  ];
  await fs.writeFile(filename, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
  for (const [label, profile] of [['A', a], ['B', b]]) {
    if (label === 'B') { await fs.rename(a.runtimeHome, a.runtimeHome + '.stopped'); await fs.rename(a.environmentDirectory, a.environmentDirectory + '.stopped'); }
    const result = await list(profile, root);
    await fs.writeFile(path.join(root, 'native-' + label + '.json'), JSON.stringify(result, null, 2));
    assert.ok(result.data.some(t => t.id === id), label + ' lists synthetic history');
    const thread = result.data.find(t => t.id === id);
    assert.ok(thread.path && await fs.stat(thread.path));
    console.log('PASS native ' + label + ' lists and opens shared thread (previous environment removed for B)');
  }
  const apiIdentity = await a.add('API shared history', 'api');
  const apiA = new CodexProfiles(a.root, path.join(root, 'api-a/home'), 'api-a');
  const apiB = new CodexProfiles(a.root, path.join(root, 'api-b/home'), 'api-b');
  await fs.mkdir(apiA.runtimeHome, {recursive:true}); await apiA.attach(apiIdentity.id); await apiB.attach(apiIdentity.id);
  const {setTopLevelValue,setSectionValue} = require('../out/config/tomlEdit');
  const ids=[];
  for (const [label,profile] of [['API-A',apiA],['API-B',apiB]]) {
    const config=path.join(profile.runtimeHome,'config.toml');let text=await fs.readFile(config,'utf8');
    text=setTopLevelValue(text,'model_provider','OpenAI');
    for(const [key,value] of Object.entries({name:'API fixture',base_url:'http://127.0.0.1:1/'+label,wire_api:'responses',requires_openai_auth:false,experimental_bearer_token:'synthetic-'+label})) text=setSectionValue(text,'model_providers.OpenAI',key,value);
    await fs.writeFile(config,text,{mode:0o600});await fs.writeFile(path.join(profile.runtimeHome,'auth.json'),'');
    const threadId=randomUUID();ids.push(threadId);const contents=rows.map(r=>r.type==='session_meta'?{...r,payload:{...r.payload,id:threadId,model_provider:'OpenAI'}}:r);
    const folder=path.join(profile.runtimeHome,'sessions',now.slice(0,4),now.slice(5,7),now.slice(8,10)); await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'rollout-'+now.slice(0,19).replace(/:/g,'-')+'-'+threadId+'.jsonl'),contents.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  for(const [label,profile] of [['API-A',apiA],['API-B',apiB]]) {
    const result=await list(profile,root,true);await fs.writeFile(path.join(root,label+'-list.json'),JSON.stringify(result,null,2));assert.ok(ids.every(id=>result.data.some(t=>t.id===id)));assert.ok(!result.data.some(t=>t.id===id));
    console.log('PASS native '+label+' lists both API-source histories with the default provider filter; official history stays separate');
  }
}
async function list(profile, root, useDefaultProvider = false) {
  // Do not inherit account tokens, global auth settings or real user HOME.
  const child = spawn(binary, ['app-server'], { cwd: path.join(root, 'project'), env: {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'xdg'), CODEX_HOME: profile.runtimeHome,
    RUST_LOG: 'info', CODEX_DISABLE_ANALYTICS: '1'
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', errorText = ''; const pending = new Map();
  child.stderr.on('data', b => { errorText += b; });
  child.stdout.on('data', b => { buffer += b; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } } catch {} } });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error('Native timeout ' + method)); }, 8000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await send('initialize', { clientInfo: { name: 'modelswitch_fixture', version: '0.8.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    let result;
    for (let n = 0; n < 10; n++) { result = await send('thread/list', { limit: 100, ...(useDefaultProvider ? {} : { modelProviders: [] }) }); if (result.data?.length) break; await new Promise(r => setTimeout(r, 250)); }
    if (result.data?.length) for (const thread of useDefaultProvider ? result.data : result.data.slice(0, 1)) await send('thread/read', { threadId: thread.id, includeTurns: true });
    return result;
  } finally {
    child.stdin.end(); child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500).unref(); } });
    await fs.writeFile(path.join(root, 'native-' + profile.environmentId + '.stderr'), errorText);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
