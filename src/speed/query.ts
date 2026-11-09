import { SpeedStore, sameSpeedTarget, speedResultStatus } from './store';
import { SPEED_MAX_AGE_MS } from './types';

/** Read-only executable: never starts the extension, Codex, a server, or a model request. */
export async function querySpeed(args: string[], providedStore?: SpeedStore): Promise<unknown> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--tool', '--provider-id', '--model', '--directory'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: query.js --tool codex|claude [--provider-id ID] [--model MODEL] [--directory PATH]');
    options[args[index]] = args[index + 1];
  }
  const tool = options['--tool'];
  if (tool !== 'codex' && tool !== 'claude') throw new Error('--tool codex|claude is required');
  const store = providedStore ?? new SpeedStore(options['--directory']);
  const current = await store.readCurrent();
  const target = current?.tools[tool];
  const explicit = Boolean(options['--provider-id']);
  const report = (await store.readAll()).find(item => item.target.tool === tool
    && (explicit ? item.target.providerId === options['--provider-id'] : target && sameSpeedTarget(item.target, target))
    && (!options['--model'] || item.rounds.some(round => round.metrics?.actualModel === options['--model'])));
  if (!report) return { status: 'unavailable', tool, currentTarget: target, reason: 'No benchmark for this target. Run Quick Speed Test or Standard Speed Test in VSCodeModelSwitch.' };
  const now = Date.now();
  const contextFresh = Boolean(current && now - Date.parse(current.updatedAt) <= SPEED_MAX_AGE_MS);
  return {
    status: !explicit && !contextFresh ? 'context-stale' : speedResultStatus(report, now),
    measurementStatus: speedResultStatus(report, now), scope: explicit ? 'explicit-provider-history' : 'last-known-plugin-target',
    currentContextFresh: contextFresh,
    ageSeconds: Math.max(0, Math.floor((now - Date.parse(report.finishedAt)) / 1000)),
    note: 'Stored active benchmark, not live monitoring of this conversation. Rates use local visible-text token estimates; initial batch excluded from generation rate. Missing generation rate means insufficient native streaming data.', report
  };
}

if (require.main === module) {
  void querySpeed(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2))).catch(() => {
    console.error('Unable to read speed results. Usage: query.js --tool codex|claude [--provider-id ID] [--model MODEL]'); process.exitCode = 1;
  });
}
