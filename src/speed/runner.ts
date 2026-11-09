import { randomUUID } from 'crypto';
import { SPEED_PROMPT_ID, SpeedMetrics, SpeedReport, SpeedTarget } from './types';

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** A failed request is retained and stops the batch; no failure-driven paid retries. */
export async function runSpeedBenchmark(target: SpeedTarget, runs: 1 | 3, measure: (signal: AbortSignal) => Promise<SpeedMetrics>, options: { signal?: AbortSignal; effort: string; timeoutMs: number; maxOutputTokens: number | null; progress?: (index: number) => void }): Promise<SpeedReport> {
  const report: SpeedReport = {
    schemaVersion: 1, clientVersion: '0.5.2', id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: '', target,
    parameters: { promptId: SPEED_PROMPT_ID, effort: options.effort, runs, timeoutMs: options.timeoutMs, maxOutputTokens: options.maxOutputTokens },
    rounds: [], summary: { attempted: 0, succeeded: 0, failed: 0, cancelled: 0, comparable: false, ttftMedianMs: null, endToEndMedianTps: null, generationMedianTps: null }
  };
  for (let index = 1; index <= runs; index++) {
    if (options.signal?.aborted) break;
    options.progress?.(index);
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const metrics = await measure(controller.signal);
      if (controller.signal.aborted) throw new Error('Request cancelled or timed out');
      report.rounds.push({ index, startedAt, status: 'completed', metrics });
    } catch (error) {
      const cancelled = options.signal?.aborted === true;
      const message = controller.signal.aborted ? cancelled ? 'Cancelled by user' : 'Request timed out' : error instanceof Error ? error.message : 'Benchmark failed';
      report.rounds.push({ index, startedAt, status: cancelled ? 'cancelled' : 'failed', error: message });
      break;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
    }
  }
  const successful = report.rounds.flatMap(round => round.metrics ? [round.metrics] : []);
  const comparable = successful.length > 0 && new Set(successful.map(value => JSON.stringify([value.actualModel, value.tokenSource, value.timingSource, value.serviceTier ?? 'unreported']))).size === 1;
  report.finishedAt = new Date().toISOString();
  report.summary = {
    attempted: report.rounds.length, succeeded: successful.length,
    failed: report.rounds.filter(round => round.status === 'failed').length,
    cancelled: report.rounds.filter(round => round.status === 'cancelled').length,
    comparable,
    ttftMedianMs: comparable ? median(successful.map(value => value.ttftMs)) : null,
    endToEndMedianTps: comparable ? median(successful.map(value => value.endToEndTps)) : null,
    generationMedianTps: comparable ? median(successful.flatMap(value => value.generationTps === null ? [] : [value.generationTps])) : null
  };
  return report;
}
