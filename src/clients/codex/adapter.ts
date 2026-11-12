import * as fs from 'fs/promises';
import { pathExists } from '../../config/atomicWrite';
import { FileRecovery } from '../../config/recovery';
import { validateConfigText } from '../../config/templates';
import { getTopLevelStringValue, setSectionValue, setTopLevelValue } from '../../config/tomlEdit';
import { CodexMode, ResolvedProvider } from '../../types';
import { getToolHome } from '../../utils/paths';
import { join } from 'path';

export class CodexAdapter {
  constructor(private readonly recoveryDirectory = () => join(getToolHome('codex'), '.recovery', 'current')) {}
  async recoverPending(): Promise<string | undefined> { return FileRecovery.recover(this.recoveryDirectory()); }
  async apply(resolved: ResolvedProvider): Promise<void> {
    if (!resolved.codex) {
      return;
    }

    if (resolved.codex.mode === 'official') {
      await this.applyOfficialMode();
      return;
    }
    if ((await this.readActiveConfig()).officialLoggedIn) throw new Error('Switch to the managed API identity before applying API settings. The current official login was kept.');
    const configPath = this.getConfigPath();
    const authPath = this.getAuthPath();
    let content = setTopLevelValue(setSectionValue(resolved.codex.configText, 'model_providers.OpenAI', 'experimental_bearer_token', resolved.codex.key), 'cli_auth_credentials_store', 'file');
    const previous = await fs.readFile(configPath, 'utf8').catch(() => '');
    const sqlite = getTopLevelStringValue(previous, 'sqlite_home');
    if (sqlite) content = setTopLevelValue(content, 'sqlite_home', sqlite);
    validateConfigText('codex', content);

    await FileRecovery.run(this.recoveryDirectory(), async tx => {
      await tx.write(configPath, content);
      await tx.write(authPath, '');
    });
  }

  getConfigPath(): string {
    return join(getToolHome('codex'), 'config.toml');
  }

  getAuthPath(): string { return join(getToolHome('codex'), 'auth.json'); }

  async applyOfficialMode(): Promise<void> {
    const configPath = this.getConfigPath();
    let config = await fs.readFile(configPath, 'utf8').catch(() => '');
    const selected = getTopLevelStringValue(config, 'model_provider');
    if (selected && selected !== 'openai') config = setTopLevelValue(config, 'model_provider', 'openai');
    await FileRecovery.run(this.recoveryDirectory(), tx => tx.write(configPath, setTopLevelValue(config, 'cli_auth_credentials_store', 'file')));
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
