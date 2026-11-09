import { getEncoding } from 'js-tiktoken';
import { SpeedMetrics, SpeedUsage } from './types';

/** Client-observed visible text only. Full-text BPE estimates never claim a provider's true tokenizer. */
export class SpeedMeasurement {
  private text = '';
  private firstText = '';
  private firstMs?: number;
  private lastMs = 0;

  add(text: string, elapsedMs: number): void {
    if (!text) return;
    if (this.firstMs === undefined && !text.trim()) { this.text += text; return; }
    if (this.firstMs === undefined) {
      this.firstMs = elapsedMs;
      this.firstText = this.text + text;
    } else if (elapsedMs === this.firstMs) this.firstText += text;
    this.text += text;
    this.lastMs = elapsedMs;
  }

  finish(actualModel: string, totalMs: number, initializationMs: number, usage: SpeedUsage = {}, timingSource: SpeedMetrics['timingSource'] = 'native-stream', serviceTier?: string): SpeedMetrics {
    if (this.firstMs === undefined || !this.text.trim()) throw new Error('No visible text received');
    // New/unknown OpenAI models use the documented local estimate, not an asserted model mapping.
    const encoding = /^(?:gpt-[5-9]|o[1-9])/.test(actualModel) ? 'o200k_base' : 'cl100k_base';
    const tokenizer = getEncoding(encoding);
    const total = tokenizer.encode(this.text, [], []).length;
    const first = tokenizer.encode(this.firstText, [], []).length;
    const remaining = Math.max(0, total - first);
    const duration = this.lastMs - this.firstMs;
    return {
      actualModel, initializationMs, ttftMs: this.firstMs, totalMs, visibleTextTokens: total,
      tokenSource: `local-${encoding}-estimate`,
      endToEndTps: totalMs > 0 ? total * 1000 / totalMs : 0,
      generationTps: timingSource === 'native-stream' && remaining > 0 && duration >= 1 ? remaining * 1000 / duration : null,
      timingSource, usage, serviceTier
    };
  }
}
