import { EnvironmentState } from '../../../storage/environmentState';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { join, basename, dirname } from 'path';
import { CodexProfiles, CodexIdentity, IdentityKind, exists } from './codexProfiles';
import { backupHistory, restoreHistory, SessionSummary } from './codexHistory';
import { getToolHome } from '../../../utils/paths';
import { confirmCodexChange } from '../../../shared/runtimeGuard';

const ROOT = 'vscodemodelswitch.codexIdentityStorage';
export interface SessionState {
  root?: string; runtimeHome: string; identities: CodexIdentity[]; activeId?: string; viewId?: string;
  attached: boolean; legacy?: boolean; restartRequired?: boolean; sessions: SessionSummary[];
  message?: string; environment: string; environmentId: string;
}
export type SessionAction = 'configure' | 'add' | 'rename' | 'switch' | 'refresh' | 'backup' | 'restore' | 'reload' | 'openFolder' | 'exportProviders' | 'manageBackups' | 'deleteHistoryBackups' | 'help';

/** No migration, credential reuse or login is triggered by installation. */
export class SessionController {
  private restartRequired = false;
  private message?: string;
  private recoveryError?: string;
  activeId?: string;
  readonly ready: Promise<void>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly environmentState = new EnvironmentState(context),
    private readonly prepareStorage?: (root: string) => Promise<() => Promise<void>>) {
    this.ready = this.initialize();
  }
  private profiles(root = this.environmentState.get<string>(ROOT)): CodexProfiles | undefined {
    return root ? new CodexProfiles(root, getToolHome('codex'), this.environmentState.id) : undefined;
  }
  private async initialize(): Promise<void> {
    await this.environmentState.ready;
    // Old roots are discovered read-only; only the explicit Set up action migrates.
    if (!this.environmentState.get(ROOT)) {
      const old = this.context.globalState.get<string>(ROOT);
      if (old) this.message = '发现旧版共享目录设置。请点击“连接/迁入目录”；不会自动迁移或复用其他环境认证。';
    }
    const pending = this.environmentState.get<{ next: string; previous?: string }>(ROOT + '.pending');
    try {
      if (pending) {
        const next = this.profiles(pending.next)!;
        this.message = await next.recover();
        let attached = false; try { await next.assertAttached(); attached = true; } catch { /* Restored old binding. */ }
        await this.environmentState.update(ROOT, attached ? pending.next : pending.previous);
        await this.environmentState.update(ROOT + '.pending', undefined);
      }
      const profiles = this.profiles();
      if (profiles && (await profiles.read()).version === 2) this.message = await profiles.recover() ?? this.message;
    } catch (error) { this.recoveryError = this.message = error instanceof Error ? error.message : String(error); }
  }
  async state(): Promise<SessionState> {
    await this.ready;
    const p = this.profiles();
    const base: SessionState = { runtimeHome: getToolHome('codex'), identities: [], attached: false, sessions: [], message: this.message,
      restartRequired: this.restartRequired, environment: this.environmentState.label, environmentId: this.environmentState.id };
    if (!p) return base;
    try {
      const m = await p.read(); this.activeId = m.activeId;
      let attached = true; try { await p.assertAttached(m); } catch { attached = false; }
      return { ...base, root: p.root, identities: m.identities, activeId: m.activeId, attached, legacy: m.version === 1 };
    } catch { return { ...base, root: p.root, message: this.recoveryError ?? '数据目录不可用，请检查挂载后刷新状态或重新连接。' }; }
  }
  get recoveryBlocked(): boolean { return Boolean(this.recoveryError); }
  reportRecoveryFailure(error: unknown): void { this.recoveryError = this.message = error instanceof Error ? error.message : String(error); }
  assertReady(): void {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (process.platform === 'win32' && vscode.workspace.getConfiguration('chatgpt').get<boolean>('runCodexInWindowsSubsystemForLinux', false)) throw new Error('官方 Codex 当前运行于 WSL，请在对应 WSL 窗口运行 AgentDeck 后再绑定目录，避免修改错误的 Windows CODEX_HOME。');
    if (this.restartRequired) throw new Error('账号绑定已改变，请先重载窗口，让 Codex 重新读取目录。');
  }
  recoveryDirectory(): string { return this.profiles()?.recoveryDirectory ?? join(getToolHome('codex'), '.recovery', 'current'); }
  async refresh(): Promise<void> { await this.ready; await this.state(); }
  async confirmChange(operation: string): Promise<boolean> { await this.ready; this.assertReady(); await this.assertHomeOwner(); return confirmCodexChange(operation); }
  async ensureMode(kind: IdentityKind): Promise<void> {
    await this.ready; this.assertReady(); await this.assertHomeOwner();
    const p = this.profiles(); if (!p) return;
    const m = await p.read(); await p.assertAttached(m);
    if (m.identities.find(i => i.id === m.activeId)?.kind !== kind) throw new Error('请先切换到对应的官方账号或 API 档案并重载窗口。');
  }
  async prepareMode(kind: IdentityKind): Promise<void> {
    await this.ready; this.assertReady();
    const p = this.profiles(); if (!p) throw new Error('请先连接数据目录。');
    const m = await p.read();
    const candidates = m.identities.filter(i => i.kind === kind);
    let identity: CodexIdentity | undefined;
    let newName: string | undefined;
    if (candidates.length === 1) identity = candidates[0];
    else if (candidates.length > 1) identity = (await vscode.window.showQuickPick(candidates.map(identity => ({ label: identity.name, identity })), { title: '选择官方账号档案' }))?.identity;
    else {
      newName = kind === 'api' ? 'API 共享历史' : await vscode.window.showInputBox({ title: '官方账号名称（本地别名）', ignoreFocusOut: true });
    }
    if (!identity && !newName) throw new Error('已取消：未切换模式。');
    if (!await this.confirmChange('切换 Codex 登录模式')) throw new Error('已取消：未切换模式。');
    identity ??= await p.add(newName!, kind);
    if (identity.id !== m.activeId) await this.action('switch', identity.id, undefined, kind, true);
  }
  async action(action: SessionAction, id?: string, _file?: string, initialKind: IdentityKind = 'official', confirmed = false): Promise<void> {
    await this.ready;
    if (action === 'reload') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return; }
    if (action === 'refresh') { await this.refresh(); return; }
    if (action === 'configure') { await this.configure(initialKind); return; }
    const p = this.profiles(); if (!p) throw new Error('请先设置统一数据目录。');
    const m = await p.read();
    if (m.version !== 2) throw new Error('旧版目录保留。请先通过“连接/迁入目录”迁入新结构。');
    if (action === 'openFolder') { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p.root)); return; }
    if (action === 'add') {
      const name = await vscode.window.showInputBox({ title: '添加官方账号档案', prompt: '名称是本地别名。新环境仍需在官方 Codex 登录，历史按这个档案共享。', ignoreFocusOut: true });
      if (!name) throw new Error('已取消：未添加账号。');
      const identity = await p.add(name, 'official'); this.message = '已添加「' + identity.name + '」，点击该账号的“使用”完成绑定。';
      return;
    }
    const identity = m.identities.find(i => i.id === (id ?? m.activeId)); if (!identity) throw new Error('请选择账号档案。');
    if (action === 'rename') {
      const name = await vscode.window.showInputBox({ title: '修改账号别名', value: identity.name, ignoreFocusOut: true });
      if (!name) throw new Error('已取消：账号名称未更改。');
      await p.rename(identity.id, name); return;
    }
    if (action === 'switch') {
      if (identity.id === m.activeId && (await this.state()).attached) return;
      if (!confirmed && !await this.confirmChange('切换到 ' + identity.name)) throw new Error('已取消：账号绑定未更改。');
      await p.switchTo(identity.id); this.restartRequired = true; this.activeId = identity.id;
      this.message = '已绑定「' + identity.name + '」。重载窗口后使用该环境自己的登录缓存；新环境请在官方 Codex 登录。';
      return;
    }
    if (action === 'backup') {
      const target = await backupHistory(p.home(identity), join(p.root, 'backups'), identity.kind, identity.name);
      this.message = '历史备份已保存（不含认证与客户端配置）：' + target; return;
    }
    if (action === 'restore') {
      const folder = await pickFolder('选择包含 manifest.json 的历史备份目录'); if (!folder) throw new Error('已取消：未恢复备份。');
      if (!await this.confirmChange('将备份恢复为新档案（不覆盖现有历史）')) throw new Error('已取消：未恢复备份。');
      await restoreHistory(p, folder); this.message = '备份已恢复为独立档案。选择该档案并绑定后，在官方 Codex 查看。';
    }
  }
  private async configure(kind: IdentityKind): Promise<void> {
    this.assertReady();
    const folder = await pickFolder('选择数据文件夹（自动使用其 codex 子目录，也可直接选择 codex）'); if (!folder) throw new Error('已取消：数据目录未更改。');
    await assertOutsideRepository(folder);
    const root = basename(folder).toLowerCase() === 'codex' ? folder : join(folder, 'codex');
    const previous = this.environmentState.get<string>(ROOT);
    const p = new CodexProfiles(root, getToolHome('codex'), this.environmentState.id, () => this.environmentState.update(ROOT, root));
    let initialize = !await exists(join(root, 'profiles.json'));
    let identityId: string | undefined;
    let legacy: string | undefined;
    if (previous && previous !== root && await exists(join(previous, 'identities.json'))) legacy = previous;
    if (!legacy) {
      const oldRoot = this.context.globalState.get<string>(ROOT);
      if (oldRoot && oldRoot !== root) {
        try {
          const old = await new CodexProfiles(oldRoot, getToolHome('codex'), this.environmentState.id).read();
          const active = old.identities.find(i => i.id === old.activeId);
          if (old.version === 1 && active && (!old.environmentId || old.environmentId === this.environmentState.id) && await fs.realpath(getToolHome('codex')) === await fs.realpath(join(oldRoot, active.directory))) legacy = oldRoot;
        } catch { /* Never adopt an unavailable or foreign legacy credential directory. */ }
      }
    }
    if (!initialize) {
      const m = await p.read(); initialize = !m.identities.length;
      if (!initialize) {
        const selected = await vscode.window.showQuickPick(m.identities.map(identity => ({ label: identity.name, description: identity.kind === 'official' ? '共享历史；本环境独立登录' : '所有 API 供应商共用历史', identity })), { title: '将当前环境连接到哪个账号档案？不会覆盖或合并当前历史。' });
        if (!selected) throw new Error('已取消：数据目录未更改。'); identityId = selected.identity.id;
      }
    }
    if (legacy && initialize) {
      const choice = await vscode.window.showQuickPick([{ label: '迁入当前环境的旧版账号档案', migrate: true }, { label: '仅将当前 Codex 数据建立为新档案', migrate: false }], { title: '旧数据将保留，不自动合并到已有档案' });
      if (!choice) throw new Error('已取消：数据目录未更改。'); if (!choice.migrate) legacy = undefined;
    }
    if (!await this.confirmChange('连接/迁入 Codex 数据目录')) throw new Error('已取消：数据目录未更改。');
    const undoLogs = await this.prepareStorage?.(root);
    let pendingCleanup = false;
    try {
      await this.environmentState.update(ROOT + '.pending', { next: root, previous });
      if (legacy && initialize) await p.importLegacy(legacy);
      else if (initialize) await p.initialize(kind);
      else await p.attach(identityId);
      // onActivated already saved ROOT inside the filesystem transaction.
      // Clearing its discovery pointer is housekeeping after commit: failure
      // must not misreport the successful binding as rolled back.
      await this.environmentState.update(ROOT + '.pending', undefined).catch(() => { pendingCleanup = true; });
    } catch (error) {
      // The filesystem transaction restores on failure; a pending pointer allows
      // startup to locate recovery data even if the selected mount changed.
      await this.environmentState.update(ROOT, previous).catch(() => {});
      try { await undoLogs?.(); }
      catch { throw new Error('数据目录连接失败，日志位置恢复未完成。原日志和校验副本已保留，请检查数据目录与日志目录。'); }
      this.message = error instanceof Error ? error.message : String(error); throw error;
    }
    this.restartRequired = true;
    this.message = '数据目录已连接，原有数据已保留；已有档案不会自动合并当前历史。请重载窗口，再在官方 Codex Chats 验收历史。' + (pendingCleanup ? ' 恢复指针暂未清理，下次启动会再次核实绑定。' : '');
  }
  private async assertHomeOwner(): Promise<void> {
    const file = join(getToolHome('codex'), '.modelswitch-environment.json');
    const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    if (text && JSON.parse(text).environmentId !== this.environmentState.id) throw new Error('CODEX_HOME 指向另一个环境的私有配置目录。请为本环境设置独立 CODEX_HOME 入口，不会复用其他环境认证缓存。');
  }
}
async function pickFolder(title: string): Promise<string | undefined> { return (await vscode.window.showOpenDialog({ title, openLabel: '选择目录', canSelectFolders: true, canSelectFiles: false, canSelectMany: false }))?.[0]?.fsPath; }
async function assertOutsideRepository(folder: string): Promise<void> {
  let current = await fs.realpath(folder);
  for (;;) {
    if (await fs.lstat(join(current, '.git')).catch(() => undefined)) throw new Error('数据包含私有认证和配置，请选择 Git 仓库之外的目录。');
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
