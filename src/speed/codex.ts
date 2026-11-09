import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { StringDecoder } from 'string_decoder';
import { SpeedMeasurement } from './measurement';
import { count, record, SPEED_PROMPT, SpeedMetrics, SpeedUsage } from './types';

/** Official Codex requests use the documented app-server protocol, never copied login tokens. */
export async function measureOfficialCodex(executable: string, model: string, effort: string, signal: AbortSignal, codexHome?: string, proxyEnv: Record<string, string> = {}): Promise<SpeedMetrics> {
  signal.throwIfAborted();
  const opening = performance.now();
  const cwd = await fs.mkdtemp(join(tmpdir(), 'vscodemodelswitch-speed-'));
  const env = { ...process.env, ...proxyEnv };
  if (codexHome) env.CODEX_HOME = codexHome;
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const disabled = ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'apps', 'connectors', 'plugins', 'remote_plugin', 'hooks', 'codex_hooks', 'plugin_hooks', 'multi_agent', 'multi_agent_v2', 'collab', 'js_repl', 'code_mode', 'code_mode_only', 'computer_use', 'browser_use', 'image_generation', 'memory_tool', 'memories', 'shell_snapshot', 'tool_search', 'tool_suggest'];
  const overrides = ['model_provider="openai"', 'approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"', 'project_doc_max_bytes=0', 'notify=[]', `features={${disabled.map(key => key + '=false').join(',')}}`];
  const isScript = /\.[cm]?js$/i.test(executable);
  const child: ChildProcessWithoutNullStreams = spawn(isScript ? process.execPath : executable,
    [...(isScript ? [executable] : []), 'app-server', '--listen', 'stdio://', ...overrides.flatMap(value => ['-c', value])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let next = 0, buffer = '', closed = false;
  const decoder = new StringDecoder('utf8');
  let notification: ((method: string, params: Record<string, unknown>) => void) | undefined;
  let failTurn: ((error: Error) => void) | undefined;
  const fail = (error: Error) => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear(); failTurn?.(error);
  };
  child.stderr.resume(); // Never expose account/configuration text from the subprocess.
  child.on('error', () => fail(new Error('Unable to start Codex; configure codexExecutablePath')));
  child.on('exit', () => fail(new Error('Codex app-server exited')));
  child.stdin.on('error', () => fail(new Error('Codex connection closed')));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = record(JSON.parse(line)); } catch { fail(new Error('Invalid Codex protocol response')); return; }
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const request = pending.get(message.id)!; pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error('Codex rejected an app-server request; check login, model and CLI compatibility'));
        else request.resolve(message.result);
      } else if (typeof message.method === 'string' && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Benchmark does not allow tool or approval requests' } }) + '\n');
        fail(new Error('Codex requested a tool or approval during text benchmark'));
      } else if (typeof message.method === 'string') notification?.(message.method, record(message.params));
    }
  });
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed || signal.aborted) { reject(new Error('Codex request cancelled')); return; }
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex protocol request timed out')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const cancel = () => { fail(new Error('Codex request cancelled')); child.kill(); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    await request('initialize', { clientInfo: { name: 'vscodemodelswitch_speed', title: 'VSCodeModelSwitch Speed', version: '0.5.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const auth = record(await request('account/read', { refreshToken: false }));
    if (record(auth.account).type !== 'chatgpt') throw new Error('Codex speed test requires an existing ChatGPT login');
    const config = record(record(await request('config/read', { includeLayers: false })).config);
    const servers = record(config.mcp_servers);
    const response = record(await request('thread/start', {
      cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', modelProvider: 'openai',
      ...(model !== 'auto' ? { model } : {}),
      baseInstructions: 'You are participating in a short text-generation benchmark. Output plain text only. Never use tools, access files, browse, run commands or delegate.',
      config: { mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false, required: false }])) }
    }));
    const thread = record(response.thread);
    if (typeof thread.id !== 'string') throw new Error('Codex did not return a thread');
    let actualModel = typeof response.model === 'string' ? response.model : model;
    const serviceTier = typeof response.serviceTier === 'string' ? response.serviceTier : undefined;
    const meter = new SpeedMeasurement(), usage: SpeedUsage = {};
    const initializedMs = performance.now() - opening;
    const started = performance.now();
    const finished = new Promise<number>((resolve, reject) => {
      failTurn = reject;
      notification = (method, params) => {
        if (params.threadId && params.threadId !== thread.id) return;
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') meter.add(params.delta, performance.now() - started);
        if (method === 'model/rerouted' && typeof params.toModel === 'string') actualModel = params.toModel;
        if (method === 'thread/tokenUsage/updated') {
          const values = record(record(params.tokenUsage).last);
          for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) { const value = count(values[key]); if (value !== undefined) usage[key] = value; }
          const reasoning = count(values.reasoningOutputTokens); if (reasoning !== undefined) usage.reasoningTokens = reasoning;
        }
        if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch'].includes(String(record(params.item).type))) reject(new Error('Tool call is not a text benchmark sample'));
        if (method === 'turn/completed') {
          if (record(params.turn).status === 'completed') resolve(performance.now() - started);
          else reject(new Error('Codex benchmark turn failed or was incomplete'));
        }
      };
    });
    void finished.catch(() => {});
    await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: SPEED_PROMPT }], effort });
    const duration = await finished;
    return meter.finish(actualModel, duration, initializedMs, usage, 'native-stream', serviceTier);
  } finally {
    signal.removeEventListener('abort', cancel);
    notification = undefined; failTurn = undefined;
    fail(new Error('Codex benchmark closed'));
    child.stdin.end(); child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
