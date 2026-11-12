'use strict';
// Native binaries, synthetic homes/keys, loopback proxies. A deliberate 503 is
// enough to prove which proxy was contacted; this is not a chat-success test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const original = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
const { codexDispatcherScript } = require('../out/network/codexLauncher');
Module._load = original;
const codex = process.argv[2];
if (!codex) throw Error('Pass the native Codex executable path');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswitch-native-network-'));
  const requests = { a: [], b: [] }, servers = [];
  const listen = async label => {
    const server = http.createServer((req, res) => { requests[label].push({ method: req.method, url: req.url }); req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"type":"overloaded_error","message":"synthetic routing probe"}}'); });
    server.on('connect', (req, socket) => { requests[label].push({ method: 'CONNECT', url: req.url }); socket.end('HTTP/1.1 503 Synthetic Probe\r\nConnection: close\r\n\r\n'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); return 'http://127.0.0.1:' + server.address().port;
  };
  const a = await listen('a'), b = await listen('b');
  const envFor = async name => {
    const home = path.join(root, name); await fs.mkdir(home, { recursive: true });
    return { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, TMPDIR: root, CODEX_HOME: path.join(home, '.codex'),
      HTTP_PROXY: a, HTTPS_PROXY: a, http_proxy: a, https_proxy: a, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', ALL_PROXY: '', all_proxy: '',
      CODEX_DISABLE_ANALYTICS: '1' };
  };
  const runUntilRequest = (binary, args, env, targetLabel) => new Promise((resolve, reject) => {
    const baseline = requests[targetLabel].length, child = spawn(binary, args, { env, cwd: env.HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output = (output + bytes).slice(-4000); }); child.stderr.on('data', bytes => { output = (output + bytes).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 18000);
    const poll = setInterval(() => { if (requests[targetLabel].slice(baseline).some(r => r.url.includes('model.fixture.invalid'))) child.kill('SIGTERM'); }, 50);
    child.on('error', reject); child.on('close', () => { clearInterval(poll); clearTimeout(timer); const reached = requests[targetLabel].slice(baseline).some(r => r.url.includes('model.fixture.invalid')); if (reached) resolve(); else { fs.writeFile(path.join(env.HOME, 'probe-output.txt'), output).then(() => reject(Error('Native probe did not reach expected proxy; inspect isolated fixture ' + env.HOME))); } });
  });
  try {
    const ce = await envFor('codex'); await fs.mkdir(ce.CODEX_HOME);
    const wrapper = path.join(root, 'codex-route'); await fs.writeFile(wrapper, codexDispatcherScript(codex, { url: b, noProxy: 'localhost,127.0.0.1,::1', codex: true, claude: false }), { mode: 0o700 });
    await runUntilRequest(wrapper, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'fixture', '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture={name="fixture",base_url="https://model.fixture.invalid/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}', 'Reply OK'], ce, 'b');
    assert.equal(requests.a.filter(r => r.url.includes('model.fixture.invalid')).length, 0);
    assert.ok(requests.b.some(r => r.method === 'CONNECT' && r.url.includes('model.fixture.invalid')));
    console.log('PASS native Codex HTTPS child uses selected CONNECT proxy instead of inherited proxy');
    console.log('RESULT: 1 native Codex routing check passed; synthetic 503 only; retained fixture ' + root);
  } finally { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
