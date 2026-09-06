import * as vscode from 'vscode';
import { ResolvedProvider } from '../types';

export class EnvManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  apply(resolved: ResolvedProvider): Record<string, string> {
    const collection = this.context.environmentVariableCollection;
    collection.persistent = false;

    const env: Record<string, string> = {};
    if (resolved.claude) {
      collection.delete('ANTHROPIC_BASE_URL');
      collection.delete('ANTHROPIC_AUTH_TOKEN');
      env.ANTHROPIC_BASE_URL = resolved.claude.baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = resolved.claude.key;
    }
    if (resolved.codex) {
      collection.delete('OPENAI_BASE_URL');
      collection.delete('OPENAI_API_KEY');
      env.OPENAI_BASE_URL = resolved.codex.baseUrl;
      env.OPENAI_API_KEY = resolved.codex.key;
    }

    for (const [key, value] of Object.entries(env)) {
      collection.replace(key, value);
    }

    return env;
  }

}
