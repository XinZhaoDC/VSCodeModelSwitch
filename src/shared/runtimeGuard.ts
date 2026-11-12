import * as vscode from 'vscode';

/** Configuration changes require explicit consent, independent of Codex's
 * private runtime APIs. No process scan is presented as a busy/idle check. */
export async function confirmCodexChange(operation: string): Promise<boolean> {
  return confirmClientChange('Codex', operation);
}
export async function confirmClientChange(tool: string, operation: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    operation + '：此操作可能影响当前环境的 ' + tool + ' 扩展和 CLI。请先等待正在进行的任务结束。' +
    '插件不会自动检测或停止任务。已有客户端可能继续使用旧配置，完成后请按提示重载或重启。' +
    '若文件操作失败会尝试恢复；其他程序同时写入时，可能需要根据保留的恢复材料手动处理。',
    { modal: true }, { title: '确认执行' }, { title: '取消', isCloseAffordance: true }
  );
  return answer?.title === '确认执行';
}
