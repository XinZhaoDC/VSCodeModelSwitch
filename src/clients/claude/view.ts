export function claudeProvidersHtml(): string { return `    <section id="claudeSection" class="section">
      <div class="sectionHeader">
        <div class="sectionTitle">
          <h2>Claude Code Providers</h2>
          <button id="collapseClaudeButton" title="Collapse Claude tool" aria-label="Collapse Claude tool">▾</button>
        </div>
        <label class="toolSwitch"><input id="claudeEnabled" type="checkbox" checked> Enabled</label>
        <button id="viewClaudeConfigButton">Applied Config</button>
      </div>
      <div id="claudeToolPanel" class="panel">
        <div id="claudeProviders" class="providerList"></div>
        <div class="actions four">
          <button id="openClaudeButton">Terminal</button>
          <button id="refreshClaudeModelsButton">Refresh Claude Models</button>
          <button id="testClaudeNetworkButton">Network & Usage</button>
          <button id="deleteClaudeBackupsButton">Delete Backups</button>
        </div>
        <div id="claudePath" class="small"></div>
      </div>
    </section>`; }
export function claudePageScript(): string { return `
  class ClaudePage {
    constructor() { this.id = 'claude'; this.draft = undefined; }
    leave() { this.draft = captureProviderDraft(); }
    enter() { restoreProviderDraft(this.draft); }
    layout() {
      el.codexSection.hidden = true; el.claudeSection.hidden = false;
      document.getElementById('codexConfigEditorDetails').hidden = true; document.getElementById('configEditorHeading').hidden = false;
      const body = document.getElementById('configEditorBody'); body.className = 'panel'; if (body.parentElement !== el.configEditor) el.configEditor.appendChild(body);
      document.querySelector('.shell').classList.remove('codexPage'); document.getElementById('overviewTitle').hidden = true; document.getElementById('overviewDetails').open = true;
      document.getElementById('networkProxyPanel').className = 'panel'; document.querySelector('.networkBody').className = 'networkBody';
      setToolChoices([['claude', 'Claude Code'], ['codex', 'Codex']]); el.tool.value = 'claude'; el.tool.disabled = true;
      const add = document.getElementById('addProviderSection'); document.getElementById('codexAddProviderDetails').hidden = true;
      document.getElementById('addProviderHeading').hidden = false; if (el.form.parentElement !== add) add.appendChild(el.form);
      const config = document.getElementById('configurationSection'); config.hidden = false;
      if (add.parentElement !== document.querySelector('.shell')) document.querySelector('.shell').insertBefore(add, config);
      for (const button of [el.exportButton, el.importButton, el.clearLogButton]) document.getElementById('configurationActions').appendChild(button);
      el.exportButton.textContent = 'Export'; el.importButton.textContent = 'Import'; el.clearLogButton.textContent = 'Delete Log'; el.clearLogButton.className = 'danger';
      document.getElementById('codexProviderGroupField').hidden = true;
      document.getElementById('codexRequestDetails').hidden = true; document.getElementById('codexUsageDetails').hidden = true;
      if (document.getElementById('editProxy').parentElement !== body) body.appendChild(document.getElementById('editProxy'));
      for (const node of [document.getElementById('usageEnabledLabel'), el.usageFields]) if (node.parentElement !== body) body.appendChild(node);
    }
    render() {
      renderProviderList('claude', el.claudeProviders, state.toolEnabled.claude);
    }
  }
`; }
