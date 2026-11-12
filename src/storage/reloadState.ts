import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { EnvironmentState } from './environmentState';

export interface ReloadNotice { tool: 'codex' | 'claude'; section: 'network' | 'mode' | 'storage' | 'providers'; reason: string; required: boolean; at: number; activation: string }
/** Required reload notices survive webview close and extension restart until a
 * different activation has checked the current files and binding. */
export class ReloadState {
  readonly activation = randomUUID();
  constructor(private readonly environment: EnvironmentState) {}
  entries(): ReloadNotice[] { return this.environment.get<ReloadNotice[]>('reloadNotices', []).filter(n => n.required || Date.now() - n.at < 60000); }
  async add(tool: ReloadNotice['tool'], section: ReloadNotice['section'], reason: string, required: boolean): Promise<void> {
    await this.environment.update('reloadNotices', [...this.entries().filter(n => n.tool !== tool || n.section !== section), { tool, section, reason, required, at: Date.now(), activation: this.activation }]);
    if (required) void vscode.window.showInformationMessage(reason + '。是否立即重新加载窗口？', '立即重新加载', '稍后').then(answer => {
      if (answer === '立即重新加载') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }
  async acknowledgeStartup(valid: (notice: ReloadNotice) => boolean): Promise<void> {
    const entries = this.entries();
    await this.environment.update('reloadNotices', entries.filter(n => n.activation === this.activation || !valid(n)));
  }
}
