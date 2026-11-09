import * as fs from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { SPEED_MAX_AGE_MS, SpeedCurrent, SpeedReport, SpeedTarget } from './types';

export function speedDirectory(): string { return join(homedir(), '.vscodemodelswitch', 'speed'); }
export function sameSpeedTarget(a: SpeedTarget, b: SpeedTarget): boolean {
  return a.tool === b.tool && a.mode === b.mode && a.providerId === b.providerId && a.model === b.model && a.configRevision === b.configRevision;
}

/** Immutable report files avoid lost history across extension windows. No credentials or text payloads. */
export class SpeedStore {
  constructor(readonly directory = speedDirectory()) {}
  async save(report: SpeedReport): Promise<void> {
    const directory = join(this.directory, 'reports');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, report.id + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o664 });
  }
  async readAll(): Promise<SpeedReport[]> {
    const directory = join(this.directory, 'reports');
    let files: string[];
    try { files = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const reports = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
      const value = JSON.parse(await fs.readFile(join(directory, file), 'utf8')) as SpeedReport;
      return value.schemaVersion === 1 && Array.isArray(value.rounds) ? value : undefined;
    }));
    return reports.filter((value): value is SpeedReport => Boolean(value)).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }
  async latest(target: SpeedTarget): Promise<SpeedReport | undefined> { return (await this.readAll()).find(report => sameSpeedTarget(report.target, target)); }
  async writeCurrent(current: SpeedCurrent): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, 'current.' + randomUUID() + '.tmp');
    await fs.writeFile(temporary, JSON.stringify(current, null, 2) + '\n', { mode: 0o664 });
    await fs.rename(temporary, join(this.directory, 'current.json'));
  }
  async readCurrent(): Promise<SpeedCurrent | undefined> {
    try { return JSON.parse(await fs.readFile(join(this.directory, 'current.json'), 'utf8')) as SpeedCurrent; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}

export function speedResultStatus(report: SpeedReport, now = Date.now()): 'fresh' | 'stale' | 'failed' | 'cancelled' | 'mixed' {
  if (report.rounds.some(round => round.status === 'cancelled')) return 'cancelled';
  if (report.summary.succeeded !== report.parameters.runs) return 'failed';
  if (!report.summary.comparable) return 'mixed';
  return now - Date.parse(report.finishedAt) > SPEED_MAX_AGE_MS ? 'stale' : 'fresh';
}
