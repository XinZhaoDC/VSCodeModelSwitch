import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export function getEffectiveHome(): string {
  const configuration = vscode.workspace.getConfiguration('vscodemodelswitch');
  const target = configuration.get<string>('configTarget', 'real');
  if (target === 'real') {
    return os.homedir();
  }

  const configured = configuration
    .get<string>('testHome', '')
    .trim();
  return configured || defaultSandboxHome();
}

export function resolveHomePath(...segments: string[]): string {
  return path.join(getEffectiveHome(), ...segments);
}

export function getToolHome(tool: 'codex' | 'claude'): string {
  const sandbox = vscode.workspace.getConfiguration('vscodemodelswitch').get<string>('configTarget', 'real') !== 'real';
  const override = process.env[tool === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
  return !sandbox && override ? path.resolve(override) : resolveHomePath('.' + tool);
}

function defaultSandboxHome(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    return path.join(workspaceFolder, '.vscodemodelswitch-home');
  }
  return path.join(os.homedir(), '.vscodemodelswitch-home');
}
