import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { join, dirname, basename } from 'path';

/** A top-of-window picker: open documents, never replace the workspace or rely
 * on a remote operating system's desktop file manager. Symlink dirs excluded. */
export async function browseFiles(start: string, title: string, suffix?: RegExp): Promise<boolean> {
  let directory = start;
  for (;;) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const choices = entries.filter(e => e.isDirectory() || e.isFile() && (!suffix || suffix.test(e.name))).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(e => ({ label: (e.isDirectory() ? '$(folder) ' : '$(file) ') + e.name, path: join(directory, e.name), folder: e.isDirectory() }));
    if (dirname(directory) !== directory) choices.unshift({ label: '$(arrow-up) ..', path: dirname(directory), folder: true });
    const selected = await vscode.window.showQuickPick(choices, { title: title + ' · ' + directory, placeHolder: basename(directory), matchOnDescription: true });
    if (!selected) return false;
    if (selected.folder) { directory = selected.path; continue; }
    const stat = await fs.lstat(selected.path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('文件已变化，请重新选择。');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(selected.path)), { preview: false }); return true;
  }
}
