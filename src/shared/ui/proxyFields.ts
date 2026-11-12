import { ProxyConfig } from '../../types';
export function renderProxyFields(prefix: string): string {
  const id = (name: string) => `${prefix}Proxy${name}`;
  const numbers = [
    ['timeoutMs', 'Request timeout (ms)', 1000, 900000], ['maxAttempts', 'Maximum attempts', 1, 5],
    ['keepAliveMs', 'Keepalive interval (ms)', 100, 60000], ['maxHistoryChars', 'History character budget (0 = unlimited)', 0, ''],
    ['maxToolResultChars', 'Tool result characters (0 = unlimited)', 0, ''], ['maxOutputTokens', 'Output token cap (0 = client limit)', 0, ''],
    ['toolDescriptionChars', 'Tool description characters (0 = full)', 0, ''], ['extraThinkingBudget', 'Extra thinking tokens (0 = follow client)', 0, ''],
    ['maxThinkingBudget', 'Thinking token cap (0 = client limit)', 0, ''], ['webSearchResults', 'Web search result count', 1, 10],
    ['webFetchMaxChars', 'Web fetch characters (0 = unlimited)', 0, ''], ['maxWebIterations', 'Maximum web tool rounds', 1, 5]
  ];
  const flags = [
    ['rebuildStream', 'Rebuild the response stream'], ['toolInjection', 'Use text protocol for unmapped tools'],
    ['repairToolJson', 'Repair malformed tool JSON'], ['cacheSystemPrefix', 'Add a system cache breakpoint'],
    ['webTools', 'Let the proxy execute web search / fetch']
  ];
  return `<div id="${id('')}" class="proxySettings">
    <div class="field"><label for="${id('Mode')}">Connection mode</label><select id="${id('Mode')}"><option value="direct">Direct connection</option><option value="proxy">Built-in proxy</option></select></div>
    <div id="${id('Options')}" class="proxyOptions" hidden>
      <div id="${id('ApiFormatField')}" class="field" hidden><label for="${id('ApiFormat')}">Upstream API format</label><select id="${id('ApiFormat')}"><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages (translate Codex requests)</option></select><div class="small">Choose the API your provider serves. Changing the format restores that format's preset defaults. Anthropic translation needs full history and stream rebuilding; hosted OpenAI tools and encrypted OpenAI state require Responses.</div></div>
      <div class="field"><label for="${id('Preset')}">Compatibility preset</label><select id="${id('Preset')}"><option value="justdowork">justdowork</option><option value="custom">Custom upstream</option></select></div>
      <div class="small">Enter the real upstream URL and key above. The local endpoint is generated on Apply. Keep this VS Code window open while using the proxy.</div>
      <details><summary>Advanced proxy settings</summary><div class="field">
        <button id="${id('Reset')}" type="button">Restore preset defaults</button>
        <label for="${id('messagesPath')}">Upstream API path</label><input id="${id('messagesPath')}" type="text">
        <label for="${id('authMode')}">Upstream authentication</label><select id="${id('authMode')}"><option value="both">Bearer + x-api-key</option><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="custom">Custom header</option></select>
        <label for="${id('authHeader')}">Custom authentication header name (key comes from SecretStorage)</label><input id="${id('authHeader')}" type="text">
        ${['headers', 'parameters', 'nativeToolMap'].map(name => `<label for="${id(name)}">${name === 'headers' ? 'Additional headers (JSON, no credentials)' : name === 'parameters' ? 'Additional request parameters (JSON)' : 'Native tool name map (JSON)'}</label><textarea id="${id(name)}" spellcheck="false"></textarea>`).join('')}
        ${flags.map(([name, label]) => `<label class="check"><input id="${id(name)}" type="checkbox"> ${label}</label>`).join('')}
        ${numbers.map(([name, label, min, max]) => `<label for="${id(String(name))}">${label}</label><input id="${id(String(name))}" type="number" min="${min}" ${max !== '' ? `max="${max}"` : ''} step="1">`).join('')}
        <div id="${id('ResponsesNote')}" class="small" hidden>Responses uses reasoning.effort (for example {"reasoning":{"effort":"high"}} in additional parameters), not numeric thinking budgets. System caching sets a stable prompt_cache_key; the upstream decides whether to cache. Native function and custom tools, images and encrypted reasoning retain their Responses formats.</div>
        <div class="small">Overrides apply only to this provider. History/tool-output limits may omit context; omissions are marked. Stream rebuilding is required for tool mapping and proxy web tools.</div>
      </div></details>
    </div>
  </div>`;
}
