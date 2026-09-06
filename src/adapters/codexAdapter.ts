import * as fs from 'fs/promises';
import { atomicWrite, backupFile, pathExists } from '../config/atomicWrite';
import { getTopLevelStringValue, setSectionValue, setTopLevelValue } from '../config/tomlEdit';
import { ResolvedProvider } from '../types';
import { resolveHomePath } from '../utils/paths';

export class CodexAdapter {
  async apply(resolved: ResolvedProvider): Promise<void> {
    if (!resolved.codex) {
      return;
    }

    const configPath = resolveHomePath('.codex', 'config.toml');
    const content = setSectionValue(resolved.codex.configText, 'model_providers.OpenAI', 'experimental_bearer_token', resolved.codex.key);

    await backupFile(configPath);
    await atomicWrite(configPath, content);
  }

  getConfigPath(): string {
    return resolveHomePath('.codex', 'config.toml');
  }

  async readActiveConfig(): Promise<{ baseUrl?: string; model?: string; providerId?: string; key?: string }> {
    const configPath = this.getConfigPath();
    if (!(await pathExists(configPath))) {
      return {};
    }

    const content = await fs.readFile(configPath, 'utf8');
    const providerId = getTopLevelStringValue(content, 'model_provider');
    const model = getTopLevelStringValue(content, 'model');
    const baseUrl = providerId ? getSectionStringValue(content, `model_providers.${providerId}`, 'base_url') : undefined;
    return {
      providerId,
      model,
      baseUrl,
      key: providerId ? getSectionStringValue(content, `model_providers.${providerId}`, 'experimental_bearer_token') : undefined
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
