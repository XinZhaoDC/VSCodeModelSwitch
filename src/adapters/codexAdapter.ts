import * as fs from 'fs/promises';
import { atomicWrite, backupFile, pathExists } from '../config/atomicWrite';
import { getTopLevelStringValue, setSectionValue } from '../config/tomlEdit';
import { CodexMode, ResolvedProvider } from '../types';
import { resolveHomePath } from '../utils/paths';

export class CodexAdapter {
  async apply(resolved: ResolvedProvider): Promise<void> {
    if (!resolved.codex) {
      return;
    }

    if (resolved.codex.mode === 'official') {
      await this.applyOfficialMode();
      return;
    }
    const configPath = this.getConfigPath();
    const authPath = this.getAuthPath();
    const content = setSectionValue(resolved.codex.configText, 'model_providers.OpenAI', 'experimental_bearer_token', resolved.codex.key);

    await backupFile(configPath);
    await backupFile(authPath);
    // API mode starts from a clean Codex auth state. The API config is written
    // after both files have been cleared so an old official login cannot leak
    // into API mode.
    await atomicWrite(configPath, '');
    await atomicWrite(authPath, '');
    await atomicWrite(configPath, content);
  }

  getConfigPath(): string {
    return resolveHomePath('.codex', 'config.toml');
  }

  getAuthPath(): string { return resolveHomePath('.codex', 'auth.json'); }

  async applyOfficialMode(): Promise<void> {
    const configPath = this.getConfigPath();
    const authPath = this.getAuthPath();
    await backupFile(configPath);
    await backupFile(authPath);
    await atomicWrite(configPath, '');
    await atomicWrite(authPath, '');
  }

  async readMode(): Promise<CodexMode | 'unknown'> {
    return (await this.readActiveConfig()).mode;
  }

  async readActiveConfig(): Promise<{ baseUrl?: string; model?: string; providerId?: string; key?: string; mode: CodexMode | 'unknown'; officialLoggedIn: boolean }> {
    const read = async (file: string) => await pathExists(file) ? fs.readFile(file, 'utf8') : '';
    const [content, authText] = await Promise.all([read(this.getConfigPath()), read(this.getAuthPath())]);
    let auth: { auth_mode?: string; OPENAI_API_KEY?: string; tokens?: { access_token?: string; id_token?: string } } = {};
    let invalidAuth = false;
    if (authText.trim()) {
      try {
        const value = JSON.parse(authText);
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalidAuth = true;
        else auth = value;
      } catch { invalidAuth = true; }
    }
    const providerId = getTopLevelStringValue(content, 'model_provider');
    const model = getTopLevelStringValue(content, 'model');
    const baseUrl = providerId ? getSectionStringValue(content, `model_providers.${providerId}`, 'base_url') : undefined;
    const key = providerId ? getSectionStringValue(content, `model_providers.${providerId}`, 'experimental_bearer_token') : undefined;
    const hasOfficialTokens = [auth.tokens?.access_token, auth.tokens?.id_token].some(value => typeof value === 'string' && Boolean(value.trim()));
    const hasApiKey = typeof auth.OPENAI_API_KEY === 'string' && Boolean(auth.OPENAI_API_KEY.trim());
    // A selected custom endpoint remains API mode even if its key is missing.
    // Official login and ordinary TOML settings do not need a saved provider.
    const customProvider = Boolean(providerId && providerId !== 'openai');
    const mode = baseUrl || customProvider || hasApiKey ? 'api' : invalidAuth ? 'unknown' : 'official';
    return {
      providerId,
      model,
      baseUrl,
      key,
      mode,
      officialLoggedIn: mode === 'official' && hasOfficialTokens
    };
  }
}

function getSectionStringValue(content: string, section: string, key: string): string | undefined {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$`);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);
  const sectionStart = lines.findIndex((line) => sectionPattern.test(line));
  if (sectionStart < 0) {
    return undefined;
  }

  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      return undefined;
    }
    const match = lines[index].match(keyPattern);
    if (match) {
      return parseTomlString(match[1]);
    }
  }
  return undefined;
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
