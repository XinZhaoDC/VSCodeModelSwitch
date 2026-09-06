import { ToolId } from '../types';

export const CLAUDE_TEMPLATE = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  },
  "model": "",
  "effortLevel": ""
}`;

export const CODEX_TEMPLATE = `model_provider = "OpenAI"
model = ""
#review_model = ""
model_context_window=1000000
model_auto_compact_token_limit=900000
#model_reasoning_effort = ""
disable_response_storage = true
#model_catalog_json = "~/.codex/codex-models.json"
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = ""
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = ""
http_headers = { "x-openai-actor-authorization" = "local-image-extension" }

[features]
goals = true
`;

export function defaultTemplate(tool: ToolId): string {
  return tool === 'claude' ? CLAUDE_TEMPLATE : CODEX_TEMPLATE;
}

export function buildTemplate(tool: ToolId, baseUrl: string, model: string): string {
  if (tool === 'claude') {
    const parsed = JSON.parse(CLAUDE_TEMPLATE) as Record<string, unknown>;
    const env = parsed.env as Record<string, unknown>;
    env.ANTHROPIC_BASE_URL = baseUrl;
    parsed.model = model;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  let text = CODEX_TEMPLATE;
  text = setTomlTopLevelValue(text, 'model', model);
  return setTomlSectionValue(text, 'model_providers.OpenAI', 'base_url', baseUrl);
}

export function setConfigModel(tool: ToolId, text: string, model: string): string {
  if (tool === 'claude') {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    parsed.model = model;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  return setTomlTopLevelValue(text, 'model', model);
}

export function redactConfigText(tool: ToolId, text: string): string {
  if (tool === 'claude') {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const env = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env as Record<string, unknown> : {};
    env.ANTHROPIC_AUTH_TOKEN = '';
    parsed.env = env;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  return setTomlSectionValue(text, 'model_providers.OpenAI', 'experimental_bearer_token', '');
}

export function extractConfigValues(tool: ToolId, text: string): { baseUrl: string; model: string; key: string } {
  if (tool === 'claude') {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const env = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env as Record<string, unknown> : {};
    return {
      baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      key: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : ''
    };
  }
  const baseUrl = getTomlSectionValue(text, 'model_providers.OpenAI', 'base_url');
  const key = getTomlSectionValue(text, 'model_providers.OpenAI', 'experimental_bearer_token');
  return { baseUrl, model: getTomlTopLevelValue(text, 'model'), key };
}

export function validateConfigText(tool: ToolId, text: string): void {
  if (!text.trim()) throw new Error('Configuration cannot be empty');
  if (tool === 'claude') {
    assertNoDuplicateJsonKeys(text);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) throw new Error('Claude env object is required');
    return;
  }
  assertNoDuplicateTomlKeys(text);
  if (getTomlTopLevelValue(text, 'model_provider') !== 'OpenAI') throw new Error('Codex model_provider must be OpenAI');
  if (!getTomlSectionValue(text, 'model_providers.OpenAI', 'base_url')) throw new Error('Codex base_url is required');
}

function setTomlSectionValue(content: string, section: string, key: string, value: string): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const sectionStart = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (sectionStart < 0) throw new Error(`Codex section [${section}] is required`);
  const next = lines.findIndex((line, index) => index > sectionStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  const end = next < 0 ? lines.length : next;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = sectionStart + 1; index < end; index += 1) {
    if (pattern.test(lines[index])) {
      lines[index] = `${key} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      return lines.join('\n').replace(/\n+$/, '') + '\n';
    }
  }
  lines.splice(end, 0, `${key} = "${value}"`);
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

function setTomlTopLevelValue(content: string, key: string, value: string): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const sectionStart = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const end = sectionStart < 0 ? lines.length : sectionStart;
  for (let index = 0; index < end; index += 1) {
    if (pattern.test(lines[index])) {
      lines[index] = `${key} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      return lines.join('\n').replace(/\n+$/, '') + '\n';
    }
  }
  lines.splice(end, 0, `${key} = "${value}"`);
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

function getTomlTopLevelValue(content: string, key: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const line = lines.find((item) => !/^\s*\[/.test(item) && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(item));
  return line ? parseTomlValue(line.slice(line.indexOf('=') + 1)) : '';
}

function getTomlSectionValue(content: string, section: string, key: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return '';
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) break;
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[index])) return parseTomlValue(lines[index].slice(lines[index].indexOf('=') + 1));
  }
  return '';
}

function parseTomlValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function assertNoDuplicateTomlKeys(content: string): void {
  const seen = new Set<string>();
  let section = '';
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      const marker = `section:${section}`;
      if (seen.has(marker)) throw new Error(`Duplicate TOML field: [${section}]`);
      seen.add(marker);
      continue;
    }
    const key = line.match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1];
    if (key) {
      const marker = `${section}:${key}`;
      if (seen.has(marker)) throw new Error(`Duplicate TOML field: ${marker}`);
      seen.add(marker);
    }
  }
}

function assertNoDuplicateJsonKeys(text: string): void {
  const stack: Array<Set<string>> = [];
  let inString = false;
  let escaped = false;
  let expectingKey = false;
  let candidate = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; if (expectingKey) { candidate = candidate; } }
      else if (expectingKey) candidate += char;
      continue;
    }
    if (char === '"') { inString = true; candidate = ''; expectingKey = stack.length > 0; continue; }
    if (char === '{') { stack.push(new Set()); expectingKey = true; continue; }
    if (char === '}') { stack.pop(); expectingKey = false; continue; }
    if (char === ':' && stack.length && candidate) {
      const keys = stack[stack.length - 1];
      if (keys.has(candidate)) throw new Error(`Duplicate JSON field: ${candidate}`);
      keys.add(candidate); expectingKey = false; candidate = '';
    }
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
