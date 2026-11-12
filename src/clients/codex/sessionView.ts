export function sessionPanelHtml(): string {
  return `<div id="claudeSessionsLater" class="panel small" hidden>Claude Code 会话管理将在后续版本提供。</div>
  <section class="section moduleWrap" id="codexAccountsSection"><details class="module" data-fold="accounts-api" open><summary><h2>账号与 API / Accounts &amp; API</h2></summary><div id="codexAccountsBody" class="moduleBody">
    <p class="moduleIntro">选择登录方式，再管理对应账号或供应商。另一种方式的配置保留并以只读显示。</p>
    <section id="sessionPanel"><details class="submodule" data-fold="mode" open><summary><h3 id="sessionPanelTitle">登录方式 / Sign-in mode</h3></summary><div id="codexSessionControls" class="moduleBody">
      <div id="codexCurrentMode" class="modeBadge" role="status" aria-live="polite">读取当前模式…</div><div id="codexModeDetail" class="small"></div>
      <div class="modeActions"><button id="codexOfficialMode" type="button">官方账号 / Official account</button><button id="codexApiMode" type="button">API 模式 / API</button></div>
      <div id="codexModeNext" class="workflowHint"></div><button id="reloadIdentityButton" class="primary" hidden>重新加载窗口 / Reload window</button>
    </div></details></section>
    <section id="officialAccountsSection"><details class="submodule" data-fold="accounts" open><summary><h3>官方账号 / Official accounts</h3></summary><div class="moduleBody">
      <p class="moduleIntro">为每个官方账号保存独立历史档案。请先连接数据目录；登录缓存仅在当前环境复用。</p>
      <div id="officialReadOnly" class="small"></div><div id="officialAccountsList" class="providerList"></div><button id="addIdentityButton">添加官方账号 / Add account</button>
      <details class="submodule" data-fold="official-diagnostics"><summary><h4>当前账号诊断 / Current account diagnostics</h4></summary><div class="moduleBody">
        <div class="actions"><button id="standardOfficialSpeedButton">测试生成与速度 / Test generation and speed</button><button id="quickOfficialSpeedButton" hidden>Quick Speed Test</button><button id="officialInfoButton">模型与额度 / Models and limits</button></div>
        <p class="usageNote">ⓘ 注：生成测试执行三次短请求，消耗当前账号额度；报告首轮结果及三轮中位数。模型与额度读取不切换账号。</p>
        <div id="officialInfoResult" class="small"></div><div id="officialSpeedResult" class="diagnosticResults"></div>
      </div></details>
      <p class="usageNote">ⓘ 注：账号名称是本地档案别名，请在官方 Codex 确认登录对应账号。</p>
    </div></details></section>
  </div></details></section>`;
}
export function storagePanelHtml(): string {
  return `<section class="section moduleWrap" id="codexDataSection"><details class="module" data-fold="storage" open><summary><h2>数据与存储 / Data &amp; storage</h2></summary><div class="moduleBody">
    <p class="moduleIntro">连接本机或挂载的数据目录，让同一账号在不同环境的 Codex Chats 中使用相同历史。认证与客户端配置按环境保存。</p>
    <div id="sessionStorage" class="small"></div><div id="identityStatus" class="small"></div>
    <div class="actions"><button id="sessionStorageButton">连接数据目录 / Connect storage</button><button id="openDataFolderButton">浏览数据文件 / Browse data</button></div>
    <details id="codexBackupSection" class="submodule" data-fold="backup"><summary><h3>历史备份 / History backups</h3></summary><div class="moduleBody">
      <p class="usageNote">ⓘ 注：每次创建独立完整快照，旧备份保留；包含聊天与索引，不含登录凭据、客户端配置或项目源码。备份时请暂停写入聊天。</p>
      <div id="historyBackupPath" class="small"></div>
      <div class="actions"><button id="backupSessionsButton">备份当前历史 / Back up history</button><button id="manageBackupsButton">浏览历史备份 / Browse backups</button></div>
      <button id="deleteHistoryBackupsButton" class="danger">删除历史备份… / Delete backups…</button>
    </div></details>
    <details id="codexConfigTransferSection" class="submodule" data-fold="config-transfer"><summary><h3>供应商配置 / Provider configuration</h3></summary><div class="moduleBody">
      <p class="usageNote">ⓘ 注：保存 Codex API 供应商的地址、模型和配置选项，不保存聊天或已存储的密钥。两个保存按钮内容相同，仅位置不同；导入不自动应用。</p>
      <div id="providerExportPath" class="small"></div><div id="codexPublicConfigActions" class="actions"></div><button id="exportProvidersButton">保存到数据目录 / Save to data folder</button>
    </div></details>
    <details id="codexLogSection" class="submodule" data-fold="logs"><summary><h3>操作日志 / Operation logs</h3></summary><div class="moduleBody">
      <p class="usageNote">ⓘ 注：未连接数据目录时使用插件默认日志路径；连接目录时搬迁已有日志。日志按环境保存，不记录认证或聊天正文。</p>
      <div id="operationLogPath" class="small"></div><div id="codexLogActions" class="actions"><button id="viewOperationLogButton">查看当前日志 / View current log</button><button id="openOperationLogButton">浏览日志 / Browse logs</button><button id="exportOperationLogButton">导出诊断日志 / Export logs</button></div>
    </div></details>
    <details class="submodule" data-fold="storage-help"><summary><h3>目录说明 / Folder guide</h3></summary><div class="moduleBody">
      <p class="usageNote">ⓘ 注：文件夹名称由你决定。插件在所选位置使用 codex 子目录，也支持直接选择该子目录。profiles 保存共享历史；environments 保存各环境配置和认证；backups 保存手动历史快照；providers 保存可选的供应商导出。</p>
      <div id="storageReadmePath" class="small"></div><button id="storageHelpButton">打开目录说明 / Open folder guide</button>
    </div></details><div id="sessionMessage" class="small"></div>
  </div></details></section>`;
}
export function sessionPanelScript(): string {
  return `
    const sessionsEl = Object.fromEntries(['sessionPanelTitle', 'claudeSessionsLater', 'codexSessionControls', 'officialAccountsSection', 'officialAccountsList', 'officialReadOnly', 'codexDataSection', 'sessionStorage', 'identityStatus', 'sessionMessage', 'sessionStorageButton', 'addIdentityButton', 'openDataFolderButton', 'backupSessionsButton', 'manageBackupsButton', 'deleteHistoryBackupsButton', 'storageHelpButton', 'exportProvidersButton', 'reloadIdentityButton', 'codexModeNext'].map(id => [id, document.getElementById(id)]));
    function sessionAction(action, identityId) {
      if (busy) return;
      post({ type: 'sessionAction', action, identityId });
    }
    for (const [id, action] of [['sessionStorageButton', 'configure'], ['addIdentityButton', 'add'], ['openDataFolderButton', 'openFolder'], ['backupSessionsButton', 'backup'], ['manageBackupsButton', 'manageBackups'], ['deleteHistoryBackupsButton', 'deleteHistoryBackups'], ['storageHelpButton', 'help'], ['exportProvidersButton', 'exportProviders'], ['reloadIdentityButton', 'reload']]) sessionsEl[id].addEventListener('click', () => { if (!sessionsEl[id].disabled) sessionAction(action); });
    function activeCodexIdentity() { const s = state.sessions; return s?.identities?.find(identity => identity.id === s.activeId); }
    function codexIdentityReady(kind) {
      const s = state.sessions;
      return !s?.restartRequired && !s?.legacy && (!s?.root || s.attached && activeCodexIdentity()?.kind === kind);
    }
    function codexApiEditable() { return codexIdentityReady('api') && (activeCodexIdentity()?.kind === 'api' || state.codexMode === 'api'); }
    function renderSessions() {
      const s = state.sessions || { identities: [], attached: false };
      const active = activeCodexIdentity();
      const pending = Boolean(s.restartRequired);
      const kind = active?.kind || state.codexMode;
      const official = kind === 'official'; const api = kind === 'api';
      const apiSetup = active?.kind === 'api' && state.codexMode !== 'api';
      const locked = busy || !state.toolEnabled.codex || pending;
      const status = state.apiStatuses?.find(row => row.tool === 'codex');
      document.getElementById('codexAccountsSection').hidden = activeTool !== 'codex';
      document.getElementById('sessionPanel').hidden = activeTool !== 'codex';
      sessionsEl.claudeSessionsLater.hidden = activeTool !== 'claude';
      sessionsEl.codexSessionControls.hidden = activeTool !== 'codex';
      sessionsEl.officialAccountsSection.hidden = activeTool !== 'codex';
      sessionsEl.codexDataSection.hidden = activeTool !== 'codex';
      el.codexCurrentMode.textContent = pending ? '◷ 绑定已更改 · 待重载' : apiSetup ? '◷ API 共享历史已启用 · 待应用供应商' : official ? '● 官方账号 / Official account' : api ? '● API 模式 / API' : '○ 模式待确认';
      el.codexCurrentMode.className = 'modeBadge ' + (pending || apiSetup ? 'warning' : official ? 'official' : api ? 'api' : 'warning');
      el.codexModeDetail.dataset.rawValue = 'true';
      el.codexModeDetail.textContent = pending ? ui('重载窗口让 Codex 读取新的配置与目录。', 'Reload the window so Codex reads the new configuration and folders.')
        : apiSetup ? ui('下一步：在 API 供应商中选择并应用。官方认证未带入此 API 档案。', 'Next: apply a provider below. Official credentials are not reused in this API profile.')
        : official ? ui('当前档案：', 'Current profile: ') + (active?.name || ui('尚未管理', 'Unmanaged')) + (status?.status === 'signedIn' ? ui('；本环境已登录。', '; signed in here.') : ui('；请在官方 Codex 中确认登录。', '; confirm sign-in in Codex.'))
        : api ? ui('当前档案：API 共享历史。所有 API 供应商共用；应用只更改当前环境的配置。', 'All API providers share one API history; applying changes only this environment.') : ui('点击全局刷新状态重新读取。', 'Refresh status to read the current configuration.');
      el.codexOfficialMode.textContent = official ? '✓ 官方账号 / Official' : '切换到官方账号 / Official';
      el.codexApiMode.textContent = api ? '✓ API 模式 / API' : '切换到 API / API';
      el.codexOfficialMode.className = official ? 'modeCurrent official' : 'primary';
      el.codexApiMode.className = api ? 'modeCurrent api' : 'primary';
      el.codexOfficialMode.disabled = locked || s.legacy || official;
      el.codexApiMode.disabled = locked || s.legacy || api;
      sessionsEl.codexModeNext.textContent = pending ? '下一步：重载窗口，再打开官方 Codex。'
        : !s.root ? '先在“数据与存储”连接目录；切换到 API 时自动建立或使用唯一的 API 共享历史，官方账号历史分别保留。'
        : s.legacy ? '旧版目录仍保留，请通过“连接/迁入目录”升级存储结构。'
        : !s.attached ? '目录绑定异常，请检查挂载并重新连接。'
        : api ? '在下方选择 API 供应商并应用；历史在官方 Codex Chats 查看。' : '选择下方账号切换；聊天在官方 Codex Chats 查看。';
      sessionsEl.officialReadOnly.textContent = !s.root ? '先在数据与存储连接目录，才能添加多个官方账号。' : api ? '当前为 API 模式，此区域只读。通过上方模式按钮切回官方账号。' : '';
      sessionsEl.officialAccountsSection.classList.toggle('toolDisabled', api);
      sessionsEl.officialAccountsList.textContent = '';
      const accounts = (s.identities || []).filter(i => i.kind === 'official');
      if (!accounts.length) { const empty = document.createElement('div'); empty.className = 'small'; empty.textContent = '尚未添加官方账号档案。'; sessionsEl.officialAccountsList.appendChild(empty); }
      for (const identity of accounts) {
        const row = document.createElement('div'); row.dataset.identityId = identity.id; row.className = 'provider' + (identity.id === s.activeId ? ' active' : '');
        const title = document.createElement('div'); title.dataset.rawValue = 'true'; title.textContent = identity.name + (identity.id === s.activeId ? ' · ' + uiText('当前 / Active') : ''); row.appendChild(title);
        const actions = document.createElement('div'); actions.className = 'actions';
        for (const [label, action] of [[identity.id === s.activeId ? '✓ 当前账号' : '使用 / Use', 'switch'], ['改名 / Rename', 'rename']]) {
          const button = document.createElement('button'); button.textContent = label; button.disabled = locked || api || s.legacy || action === 'switch' && identity.id === s.activeId && s.attached;
          button.addEventListener('click', () => sessionAction(action, identity.id)); actions.appendChild(button);
        }
        row.appendChild(actions); sessionsEl.officialAccountsList.appendChild(row);
      }
      sessionsEl.addIdentityButton.disabled = locked || api || !s.root || s.legacy;
      document.getElementById('operationLogPath').textContent = '当前日志目录：' + (state.logDirectory || '读取中');
      sessionsEl.sessionStorage.textContent = '统一数据目录：' + (s.root || '未设置') + ' · CODEX_HOME：' + (s.runtimeHome || '未知');
      sessionsEl.identityStatus.textContent = s.legacy ? '旧版结构，等待显式迁入。' : s.attached ? '历史目录与索引已连接；配置及认证按环境隔离。' : '尚未连接账号历史。';
      sessionsEl.sessionMessage.textContent = s.message || '';
      sessionsEl.sessionStorageButton.disabled = locked;
      sessionsEl.openDataFolderButton.disabled = busy || !s.root;
      for (const id of ['backupSessionsButton', 'manageBackupsButton', 'deleteHistoryBackupsButton', 'storageHelpButton', 'exportProvidersButton']) sessionsEl[id].disabled = busy || pending || !s.root || s.legacy || !s.attached;
      sessionsEl.reloadIdentityButton.hidden = !pending; sessionsEl.reloadIdentityButton.disabled = busy;
    }
  `;
}
