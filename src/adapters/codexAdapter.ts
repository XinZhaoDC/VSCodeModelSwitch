import * as fs from 'fs/promises';
import { atomicWrite, backupFile, pathExists } from '../config/atomicWrite';
import { getTopLevelStringValue, setSectionValue, setTopLevelValue } from '../config/tomlEdit';
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
    const configPath = this.getConfigPath();
    const authPath = this.getAuthPath();
    const config = await pathExists(configPath) ? await fs.readFile(configPath, 'utf8') : '';
    const auth = await pathExists(authPath) ? await fs.readFile(authPath, 'utf8') : '';
    const provider = getTopLevelStringValue(config, 'model_provider');
    const key = provider ? getSectionStringValue(config, `model_providers.${provider}`, 'experimental_bearer_token') : undefined;
    const base = provider ? getSectionStringValue(config, `model_providers.${provider}`, 'base_url') : undefined;
    if (key && base) return 'api';
    if (!config.trim() && !auth.trim()) return 'official';
    return 'unknown';
  }

  async readActiveConfig(): Promise<{ baseUrl?: string; model?: string; providerId?: string; key?: string; mode?: CodexMode | 'unknown' }> {
    const configPath = this.getConfigPath();
    if (!(await pathExists(configPath))) {
      return { mode: await this.readMode() };
    }

    const content = await fs.readFile(configPath, 'utf8');
    const providerId = getTopLevelStringValue(content, 'model_provider');
    const model = getTopLevelStringValue(content, 'model');
    const baseUrl = providerId ? getSectionStringValue(content, `model_providers.${providerId}`, 'base_url') : undefined;
    return {
      providerId,
      model,
      baseUrl,
      key: providerId ? getSectionStringValue(content, `model_providers.${providerId}`, 'experimental_bearer_token') : undefined,
      mode: await this.readMode()
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
