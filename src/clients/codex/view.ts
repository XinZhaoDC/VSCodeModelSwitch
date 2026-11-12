import { renderProxyFields } from '../../shared/ui/proxyFields';

export function codexProvidersHtml(): string { return `    <section id="codexSection" class="section moduleWrap">
      <details id="codexProvidersDetails" class="submodule" data-fold="providers" open>
        <summary><h3>API 供应商 / API providers</h3></summary>
        <div id="codexToolPanel" class="panel moduleBody">
          <div id="codexApiReadOnly" class="small"></div>
          <div class="actions"><button id="codexCreateGroup">新建群组</button></div><p class="usageNote">ⓘ 注：群组和供应商用拖动手柄排序；禁用项目自动下沉，禁用状态只影响当前环境。移动只改变归属，不套用模板。</p><div id="codexProviders" class="providerList"></div>
          <div class="actions"><button id="refreshCodexModelsButton" hidden>Refresh Codex Models</button><button id="testCodexNetworkButton">批量诊断供应商 / Diagnose providers</button></div>
          ${organizationEditorsHtml()}
        </div>
      </details>
    </section>`; }
function organizationEditorsHtml(): string { return `
  <section id="codexGroupEditor" hidden><details class="submodule" open><summary><h4>群组设置</h4></summary><div class="moduleBody">
    <div id="codexGroupEditorName" class="small"></div>
    <p class="usageNote">ⓘ 注：保存只更新群组模板，不改成员或当前 Codex。供应商需明确载入、保存并应用；网络预设只在本环境引用。</p>
    <label for="codexGroupBaseUrl">默认 API 地址（可留空）</label><input id="codexGroupBaseUrl" type="text">
    <label for="codexGroupRequestTemplate">已保存的请求处理模板</label><select id="codexGroupRequestTemplate"></select><button id="codexGroupLoadTemplate">载入模板到草稿</button>
    ${renderProxyFields('group')}
    <label for="codexGroupNetworkPreset">本环境网络预设（可不指定）</label><select id="codexGroupNetworkPreset"></select>
    <div class="actions"><button id="codexSaveGroup" class="primary">保存群组设置</button><button id="codexCloseGroup">关闭</button></div>
    <label for="codexGroupTemplateName">另存为请求处理模板</label><input id="codexGroupTemplateName" type="text"><button id="codexSaveGroupAsTemplate">保存为新模板</button>
  </div></details></section>
  <details id="codexRequestTemplates" class="submodule" data-fold="request-templates"><summary><h4>请求处理模板库</h4></summary><div class="moduleBody">
    <p class="usageNote">ⓘ 注：多个群组可载入同一模板。修改或删除模板库条目不会改写已载入的群组、供应商或运行配置；模板不保存密钥和 VPN 地址。</p>
    <label for="codexTemplateSelect">选择模板</label><select id="codexTemplateSelect"></select><button id="codexLoadTemplate">载入所选模板</button><button id="codexNewTemplate">新建模板</button>
    <label for="codexTemplateName">模板名称</label><input id="codexTemplateName" type="text">
    ${renderProxyFields('template')}
    <div class="actions"><button id="codexSaveTemplate" class="primary">保存模板</button><button id="codexDeleteTemplate" class="danger">删除所选模板</button></div>
  </div></details>`; }

export function codexPageScript(): string { return `
  function captureProviderDraft() {
    return { fields: [...el.form.querySelectorAll('input, select, textarea')].map(n => ({ id: n.id, value: n.value, checked: n.checked })), models: fetchedModels };
  }
  function restoreProviderDraft(draft) {
    if (!draft) {
      for (const id of ['providerName', 'baseUrl', 'apiKey', 'modelSelect', 'addConfigText']) document.getElementById(id).value = '';
      el.applyNow.checked = false; el.addMode.value = 'fields'; updateAddMode(); return;
    }
    for (const field of draft.fields) { const node = document.getElementById(field.id); if (node) { node.value = field.value; node.checked = field.checked; } }
    fetchedModels = draft.models || []; renderModelOptions(); updateProxyVisibility('add', activeTool); updateAddMode();
  }
  class CodexPage {
    constructor() {
      this.id = 'codex'; this.groupNodes = new Map(); this.editGroupId = ''; this.templateId = ''; this.templateSource = ''; this.pendingGroup = '';
      this.remembered = vscode.getState()?.lastGroupsByEnvironment || {};
      const node = id => document.getElementById(id);
      const bind = (id, fn) => node(id).addEventListener('click', () => { try { fn(); } catch (error) { showLocalFeedback(id === 'codexLoadGroupDefaults' ? 'add' : id.includes('Group') && id !== 'codexCreateGroup' && id !== 'codexAddGroup' ? 'group-editor' : 'templates', error.message, true); } });
      bind('codexCreateGroup', () => this.send({ action: 'createGroup' }));
      bind('codexAddGroup', () => this.send({ action: 'createGroup' }));
      node('codexProviderGroup').addEventListener('change', () => {
        this.remembered[state.sessions?.environmentId || 'local'] = node('codexProviderGroup').value;
        vscode.setState?.({ ...(vscode.getState?.() || {}), lastGroupsByEnvironment: this.remembered }); updateAddMode();
      });
      bind('codexLoadGroupDefaults', () => {
        const group = this.organization().groups.find(g => g.id === node('codexProviderGroup').value);
        if (!group?.defaults) throw Error('该群组尚未保存模板。');
        if (group.defaults.baseUrl) {
          if (el.addMode.value === 'text') {
            const lines = (el.addConfigText.value || defaultTemplate('codex')).split(String.fromCharCode(10));
            const header = lines.findIndex(line => line.trim() === '[model_providers.OpenAI]');
            if (header < 0) throw Error('完整配置草稿缺少 [model_providers.OpenAI]，请检查后再载入地址；草稿未更改。');
            let index = header + 1; while (index < lines.length && !lines[index].trim().startsWith('[') && lines[index].split('=')[0].trim() !== 'base_url') index++;
            const replacement = 'base_url = ' + JSON.stringify(group.defaults.baseUrl);
            if (index < lines.length && lines[index].split('=')[0].trim() === 'base_url') lines[index] = replacement; else lines.splice(header + 1, 0, replacement);
            el.addConfigText.value = lines.join(String.fromCharCode(10));
          }
          el.baseUrl.value = group.defaults.baseUrl;
        }
        setProxyConfig('add', group.defaults.proxy); resetModels(); showLocalFeedback('add', '群组模板已填入草稿，请检查后保存。', false);
      });
      bind('codexSaveGroup', () => this.send({ action: 'saveGroup', groupId: this.editGroupId, defaults: { baseUrl: node('codexGroupBaseUrl').value, proxy: getProxyConfig('group'), templateName: this.templateSource }, networkPresetName: node('codexGroupNetworkPreset').value }));
      bind('codexCloseGroup', () => { node('codexGroupEditor').hidden = true; this.editGroupId = ''; });
      bind('codexGroupLoadTemplate', () => { const t = this.organization().templates.find(t => t.id === node('codexGroupRequestTemplate').value); if (!t) throw Error('请先选择模板。'); setProxyConfig('group', t.proxy); this.templateSource = t.name; showLocalFeedback('group-editor', '模板已载入群组草稿，保存后才更新群组模板。', false); });
      bind('codexSaveGroupAsTemplate', () => this.send({ action: 'saveTemplate', groupId: this.editGroupId, name: node('codexGroupTemplateName').value, proxy: getProxyConfig('group') }));
      bind('codexLoadTemplate', () => { const t = this.organization().templates.find(t => t.id === node('codexTemplateSelect').value); if (!t) throw Error('请先选择模板。'); this.templateId = t.id; node('codexTemplateName').value = t.name; setProxyConfig('template', t.proxy); });
      bind('codexNewTemplate', () => { this.templateId = ''; node('codexTemplateName').value = ''; node('codexTemplateSelect').value = ''; setProxyConfig('template'); });
      bind('codexSaveTemplate', () => this.send({ action: 'saveTemplate', templateId: this.templateId || undefined, name: node('codexTemplateName').value, proxy: getProxyConfig('template') }));
      node('codexTemplateSelect').addEventListener('change', () => { node('codexDeleteTemplate').disabled = busy || !codexApiEditable() || !node('codexTemplateSelect').value; });
      bind('codexDeleteTemplate', () => this.send({ action: 'deleteTemplate', templateId: node('codexTemplateSelect').value }));
    }
    organization() { return state.codexOrganization || { groups: [{ id: 'independent', name: '独立供应商' }], templates: [], memberships: {}, providerOrder: [], disabledGroups: [], disabledProviders: [], groupNetworkPresets: {} }; }
    leave() { this.draft = captureProviderDraft(); }
    enter() { restoreProviderDraft(this.draft); }
    send(input) { post({ type: 'organizationAction', input }); }
    receive(message) {
      if (message.createdGroupId) this.pendingGroup = message.createdGroupId;
      if (message.inputAction === 'deleteTemplate') { this.templateId = ''; document.getElementById('codexTemplateName').value = ''; setProxyConfig('template'); }
      if (message.savedTemplateId && !message.sourceGroupId) { this.templateId = message.savedTemplateId; document.getElementById('codexTemplateSelect').value = message.savedTemplateId; }
    }
    options(id, entries, placeholder) {
      const select = document.getElementById(id), old = select.value; select.textContent = '';
      if (placeholder !== undefined) { const o = document.createElement('option'); o.value = ''; o.textContent = placeholder; select.appendChild(o); }
      for (const entry of entries) { const o = document.createElement('option'); o.value = entry.id; o.textContent = entry.name; select.appendChild(o); }
      select.value = old;
    }
    openGroup(group) {
      this.editGroupId = group.id; this.templateSource = group.defaults?.templateName || '';
      const panel = document.getElementById('codexGroupEditor'); panel.hidden = false;
      document.getElementById('codexGroupEditorName').textContent = group.name;
      document.getElementById('codexGroupBaseUrl').value = group.defaults?.baseUrl || '';
      document.getElementById('codexGroupNetworkPreset').value = this.organization().groupNetworkPresets[group.id] || '';
      document.getElementById('codexGroupTemplateName').value = '';
      setProxyConfig('group', group.defaults?.proxy);
      const owner = this.groupNodes.get(group.id); if (owner) { if (owner.body.children.length) owner.body.insertBefore(panel, owner.body.children[0]); else owner.body.appendChild(panel); }
    }
    layout() {
      el.codexSection.hidden = false; el.claudeSection.hidden = true;
      el.configEditor.hidden = el.configEditor.hidden || !codexApiEditable();
      const details = document.getElementById('codexConfigEditorDetails'), body = document.getElementById('configEditorBody');
      details.hidden = false; document.getElementById('configEditorHeading').hidden = true;
      body.className = 'moduleBody'; if (body.parentElement !== details) details.appendChild(body);
      document.querySelector('.shell').classList.add('codexPage'); document.getElementById('overviewTitle').hidden = false;
      document.getElementById('networkProxyPanel').className = 'module'; document.querySelector('.networkBody').className = 'networkBody moduleBody';
      setToolChoices([['codex', 'Codex']]);
      el.tool.value = 'codex'; el.tool.disabled = busy;
      const add = document.getElementById('addProviderSection'); document.getElementById('codexAddProviderDetails').hidden = false;
      document.getElementById('addProviderHeading').hidden = true;
      const formHost = document.getElementById('codexAddProviderBody'); if (el.form.parentElement !== formHost) formHost.appendChild(el.form);
      document.getElementById('configurationSection').hidden = true;
      if (el.codexSection.parentElement !== document.getElementById('codexAccountsBody')) document.getElementById('codexAccountsBody').appendChild(el.codexSection);
      if (add.parentElement !== el.codexToolPanel) el.codexToolPanel.appendChild(add);
      for (const button of [el.exportButton, el.importButton]) document.getElementById('codexPublicConfigActions').appendChild(button);
      document.getElementById('codexLogActions').appendChild(el.clearLogButton);
      el.exportButton.textContent = '另存为供应商配置'; el.importButton.textContent = '导入供应商配置'; el.clearLogButton.textContent = '删除日志'; el.clearLogButton.className = 'danger';
      document.getElementById('codexProviderGroupField').hidden = false;
      document.getElementById('codexRequestDetails').hidden = false; document.getElementById('codexUsageDetails').hidden = false;
      const request = document.getElementById('codexRequestBody'), usage = document.getElementById('codexUsageBody');
      if (document.getElementById('editProxy').parentElement !== request) request.appendChild(document.getElementById('editProxy'));
      for (const node of [document.getElementById('usageEnabledLabel'), el.usageFields]) if (node.parentElement !== usage) usage.appendChild(node);
    }
    render() {
      const org = this.organization(), usable = !busy && state.toolEnabled.codex && codexApiEditable();
      this.options('codexProviderGroup', org.groups.map(g => ({ ...g, name: g.name + (org.disabledGroups.includes(g.id) ? '（已禁用，可添加）' : '') })));
      const select = document.getElementById('codexProviderGroup');
      const environment = state.sessions?.environmentId || 'local';
      const preferred = this.pendingGroup || (this.selectedEnvironment !== environment ? this.remembered[environment] : select.value);
      if (preferred && org.groups.some(g => g.id === preferred)) { select.value = preferred; if (this.pendingGroup) { this.remembered[environment] = preferred; vscode.setState?.({ ...(vscode.getState?.() || {}), lastGroupsByEnvironment: this.remembered }); } this.pendingGroup = ''; }
      this.selectedEnvironment = environment;
      this.options('codexTemplateSelect', org.templates, '选择已保存模板');
      this.options('codexGroupRequestTemplate', org.templates, '选择模板');
      this.options('codexGroupNetworkPreset', (state.networkPresets?.codex || []).map(p => ({ id: p.name, name: p.name })), '不指定网络预设');
      for (const id of ['codexCreateGroup', 'codexAddGroup', 'codexLoadGroupDefaults']) document.getElementById(id).disabled = !usable;
      for (const panelId of ['codexRequestTemplates', 'codexGroupEditor']) {
        const panel = document.getElementById(panelId), locked = !usable || panelId === 'codexGroupEditor' && org.disabledGroups.includes(this.editGroupId);
        for (const control of panel.querySelectorAll('input, select, textarea, button')) control.disabled = locked;
      }
      document.getElementById('codexDeleteTemplate').disabled = !usable || !document.getElementById('codexTemplateSelect').value;
      renderProviderList('codex', el.codexProviders, state.toolEnabled.codex);
      const groups = [...org.groups.filter(g => !org.disabledGroups.includes(g.id)), ...org.groups.filter(g => org.disabledGroups.includes(g.id))];
      for (const [id, cached] of this.groupNodes) if (!groups.some(g => g.id === id)) { cached.node.remove(); this.groupNodes.delete(id); }
      for (const group of groups) {
        let cached = this.groupNodes.get(group.id);
        if (!cached) {
          const details = document.createElement('details'); details.className = 'submodule providerGroup'; details.dataset.groupId = group.id; details.dataset.fold = 'group:' + group.id;
          details.open = foldsByEnvironment[state.sessions?.environmentId]?.[details.dataset.fold] !== false;
          const summary = document.createElement('summary'), title = document.createElement('span'), controls = document.createElement('div'), body = document.createElement('div');
          controls.className = 'actions groupActions'; body.className = 'moduleBody groupProviders'; summary.append(title, controls); details.append(summary, body);
          details.addEventListener('dragover', event => event.preventDefault());
          details.addEventListener('drop', event => {
            event.preventDefault(); event.stopPropagation?.(); if (busy || !state.toolEnabled.codex || !codexApiEditable()) return;
            const providerId = event.dataTransfer.getData('application/agentdeck-provider'), sourceGroup = event.dataTransfer.getData('application/agentdeck-group');
            if (providerId) this.send({ action: 'moveProvider', providerId, groupId: group.id });
            else if (sourceGroup && sourceGroup !== group.id) this.send({ action: 'moveGroup', groupId: sourceGroup, beforeGroupId: group.id });
          });
          cached = { node: details, title, controls, body }; this.groupNodes.set(group.id, cached);
        }
        const disabled = org.disabledGroups.includes(group.id), providers = state.providers.filter(p => p.tool === 'codex' && p.codexMode !== 'official' && (p.groupId || org.memberships[p.id] || 'independent') === group.id);
        const current = state.codexMode === 'api' && providers.some(p => p.id === state.currentProviderIds.codex);
        cached.title.textContent = group.name + ' · ' + providers.length + ' 个供应商' + (disabled ? ' · 已禁用' : '') + (disabled && current ? ' · 当前配置仍在使用' : '');
        cached.node.classList.toggle('organizationDisabled', disabled); cached.controls.textContent = '';
        const button = (label, action, allowed = true) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.disabled = !usable || !allowed; b.addEventListener('click', event => { event?.preventDefault?.(); event?.stopPropagation?.(); action(); }); cached.controls.appendChild(b); return b; };
        const drag = button('↕ 拖动群组', () => {}, true); drag.draggable = usable; drag.className = 'dragHandle';
        drag.addEventListener('dragstart', event => { event.stopPropagation?.(); event.dataTransfer.setData('application/agentdeck-group', group.id); });
        button(disabled ? '恢复群组' : '禁用群组', () => this.send({ action: 'toggleGroup', groupId: group.id, enabled: disabled }));
        button('群组设置', () => this.openGroup(group), !disabled);
        button('改名', () => this.send({ action: 'renameGroup', groupId: group.id }), !disabled && group.id !== 'independent');
        button('载入本组网络预设', () => this.send({ action: 'networkDraft', groupId: group.id }), !disabled && Boolean(org.groupNetworkPresets[group.id]));
        if (disabled) { for (const b of [...cached.controls.children]) if (b.textContent !== '恢复群组' && b !== drag) b.remove(); }
        const ordered = [...providers].sort((a, b) => {
          const aOff = org.disabledProviders.includes(a.id), bOff = org.disabledProviders.includes(b.id);
          if (aOff !== bOff) return Number(aOff) - Number(bOff);
          const rank = id => { const i = org.providerOrder.indexOf(id); return i < 0 ? org.providerOrder.length + state.providers.findIndex(p => p.id === id) : i; }; return rank(a.id) - rank(b.id);
        });
        for (const provider of ordered) { const card = providerNodes.get('codex:' + provider.id)?.node; if (card) cached.body.appendChild(card); }
        for (const empty of cached.body.querySelectorAll('.groupEmpty')) empty.remove();
        if (!providers.length) { const empty = document.createElement('div'); empty.className = 'small groupEmpty'; empty.textContent = '空群组：可拖入供应商，或在添加供应商时选择本群组。'; cached.body.appendChild(empty); }
        el.codexProviders.appendChild(cached.node);
      }
      if (!el.configEditor.hidden && configEditorTool === 'codex') { const card = providerNodes.get('codex:' + configEditorProviderId)?.node; if (card) card.after(el.configEditor); }
    }
  }
`; }
