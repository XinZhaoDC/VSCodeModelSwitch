import { ToolId } from '../types';

export const SPEED_PROMPT_ID = 'forest-sync-120-words-v1';
export const SPEED_PROMPT = 'Write one plain English paragraph of about 120 words explaining how time synchronization helps a team of forest-mapping robots combine sensor observations. Do not use tools, browse, access files, or add a heading. Output only the paragraph.';
export const SPEED_MAX_AGE_MS = 15 * 60_000;

export interface SpeedTarget {
  tool: ToolId;
  mode: 'official' | 'api';
  providerId: string;
  providerName: string;
  model: string;
  configRevision: string;
}

export interface SpeedUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface SpeedMetrics {
  actualModel: string;
  initializationMs: number;
  ttftMs: number;
  totalMs: number;
  visibleTextTokens: number;
  tokenSource: 'local-o200k_base-estimate' | 'local-cl100k_base-estimate';
  endToEndTps: number;
  generationTps: number | null;
  timingSource: 'native-stream' | 'buffered-proxy';
  usage: SpeedUsage;
  serviceTier?: string;
}

export interface SpeedRound {
  index: number;
  startedAt: string;
  status: 'completed' | 'failed' | 'cancelled';
  metrics?: SpeedMetrics;
  error?: string;
}

export interface SpeedReport {
  schemaVersion: 1;
  clientVersion: string;
  id: string;
  startedAt: string;
  finishedAt: string;
  target: SpeedTarget;
  parameters: { promptId: string; effort: string; runs: 1 | 3; timeoutMs: number; maxOutputTokens: number | null };
  rounds: SpeedRound[];
  connection?: { mode: 'direct' | 'built-in-proxy' | 'codex-app-server'; protocol: string; proxyMaxAttempts?: number; proxyMaxOutputTokens?: number; proxyTimeoutMs?: number; proxyRebuildStream?: boolean; upstreamEffort?: string; proxyThinkingBudget?: number };
  summary: { attempted: number; succeeded: number; failed: number; cancelled: number; comparable: boolean; ttftMedianMs: number | null; endToEndMedianTps: number | null; generationMedianTps: number | null };
}

export interface SpeedCurrent {
  updatedAt: string;
  tools: Partial<Record<ToolId, SpeedTarget>>;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
