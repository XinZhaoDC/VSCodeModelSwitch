import * as fs from 'fs/promises';
import { join, delimiter } from 'path';
import * as vscode from 'vscode';
import { FileRecovery } from '../config/recovery';
import { NetworkProxyConfig, proxyEnvironment } from './transport';

// Application registration is a common command name; its script and route are
// local to each Linux extension host. No original extension file is replaced.
export const CODEX_DISPATCH = 'vscodemodelswitch-codex';
const MARKER = '# VSCodeModelSwitch generated Codex network dispatcher v1';
export async function codexDispatcherPath(): Promise<{ shim: string; binary: string }> {
  if (process.platform !== 'linux') throw new Error('Codex 独立网络启动入口目前仅支持 Linux；Windows/WSL 原生启动尚待实现。');
  const extension = vscode.extensions?.getExtension('openai.chatgpt');
  if (!extension) throw new Error('请先在当前环境安装官方 Codex 扩展。');
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  if (!arch) throw new Error('当前 Codex 架构尚不支持。');
  const directory = join(extension.extensionUri.fsPath, 'bin', 'linux-' + arch);
  const binary = join(directory, 'codex'), shim = join(directory, CODEX_DISPATCH);
  await fs.access(binary, fs.constants.X_OK);
  for (const parent of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const other = join(parent, CODEX_DISPATCH);
    if (other !== shim && await fs.lstat(other).catch(() => undefined)) throw new Error('PATH 中已有同名 Codex 启动命令，请先处理命令冲突。');
  }
  return { shim, binary };
}
export async function writeCodexDispatcher(tx: FileRecovery, config?: NetworkProxyConfig, verifyExisting = false): Promise<string> {
  const { shim, binary } = await codexDispatcherPath();
  const previous = await fs.readFile(shim, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return ''; });
  if (previous && !previous.includes(MARKER)) throw new Error('Codex 启动入口被其他文件占用，不会覆盖。');
  const desired = codexDispatcherScript(binary, config);
  if (previous && verifyExisting && previous !== desired) throw new Error('Codex 启动入口在外部被更改，请核对后重新应用。');
  if (previous === desired) { await fs.access(shim, fs.constants.X_OK); return shim; }
  await tx.write(shim, desired); await fs.chmod(shim, 0o700); return shim;
}
export function codexDispatcherScript(binary: string, config?: NetworkProxyConfig): string {
  const env: Record<string, string> = config ? { ...proxyEnvironment(config), ALL_PROXY: '', all_proxy: '' } : {};
  return '#!/bin/sh\n' + MARKER + '\n' + Object.entries(env).map(([key, value]) => 'export ' + key + '=' + quote(value)).join('\n') + '\nexec ' + quote(binary) + ' "$@"\n';
}
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
