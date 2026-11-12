import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface OfficialCodexInfo { models: string[]; windows: Array<{ usedPercent: number; minutes?: number; resetsAt?: number }>; unavailable: string[]; checkedAt: string }
/** Read-only native RPC. Never read or return auth.json, account identifiers or
 * raw auth responses. No chat is created and no model generation is requested. */
export async function readOfficialCodexInfo(executable: string, home: string, proxy: Record<string, string>): Promise<OfficialCodexInfo> {
  const isScript = /\.[cm]?js$/i.test(executable); const env: NodeJS.ProcessEnv = { ...process.env, ...proxy, CODEX_HOME: home };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(isScript ? process.execPath : executable, [...(isScript ? [executable] : []), 'app-server', '--listen', 'stdio://'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let next = 0, buffer = ''; const decoder = new StringDecoder('utf8');
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 后台未能完成查询，请检查当前客户端和登录状态。')); } pending.clear(); };
  child.on('error', fail); child.on('close', fail);
  child.stdout.on('data', bytes => {
    buffer += decoder.write(bytes);
    if (buffer.length > 2 * 1024 * 1024) { fail(); child.kill(); return; }
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const message = JSON.parse(line), p = pending.get(message.id); if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error('当前客户端暂不支持此查询。')) : p.resolve(message.result); } } catch { /* Non-protocol output is not exposed. */ }
    }
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 信息查询超时。')); }, 5000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'vscodemodelswitch', version: '0.9.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const [models, limits] = await Promise.allSettled([call('model/list', {}), call('account/rateLimits/read', {})]);
    const result: OfficialCodexInfo = { models: [], windows: [], unavailable: [], checkedAt: new Date().toISOString() };
    if (models.status === 'fulfilled') result.models = (models.value?.data ?? []).map((m: any) => m.model ?? m.id).filter((m: unknown) => typeof m === 'string').slice(0, 200);
    else result.unavailable.push('模型列表暂不可用');
    if (limits.status === 'fulfilled') {
      const data = limits.value ?? {}, buckets: any[] = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) : [data.rateLimits];
      for (const bucket of buckets) for (const period of [bucket?.primary, bucket?.secondary]) {
        if (typeof period?.usedPercent === 'number') result.windows.push({ usedPercent: period.usedPercent, minutes: period.windowDurationMins, resetsAt: period.resetsAt });
      }
      if (!result.windows.length) result.unavailable.push('当前账号未返回额度窗口');
    } else result.unavailable.push('额度查询暂不可用');
    return result;
  } finally { fail(); child.stdin.destroy(); child.kill(); }
}
