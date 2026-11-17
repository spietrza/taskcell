import type { BoardTask, RunDetail, RunSummary } from './wire';

/** The factory's six stations, in order: the one vocabulary Board, Runs and Home share. */
export const STATIONS = ['card', 'spec', 'cell', 'gates', 'review', 'pr'] as const;
export type Station = (typeof STATIONS)[number];

export const STATION_LABEL: Record<Station, string> = {
  card: 'Card',
  spec: 'Spec',
  cell: 'Sealed cell',
  gates: 'Gates',
  review: 'Review',
  pr: 'Pull request',
};

/** Strip labels: the full label except the two that are long. */
export const STATION_SHORT: Record<Station, string> = { ...STATION_LABEL, cell: 'Cell', pr: 'PR' };

/** Which of the six stations a running card's pipeline stage marker sits on. */
function runningIndex(stage: string | undefined): number {
  if (stage === undefined) return 2;
  if (/spec/i.test(stage)) return 1;
  if (/conformance|proof|verify|gate/i.test(stage)) return 3;
  if (/review|adversary/i.test(stage)) return 4;
  return 2;
}

/** The station a run record's stage belongs to; undefined for a stage the line does not show (sandbox, simplifier). */
export function stationOfStage(stage: string | undefined): Station | undefined {
  if (stage === undefined) return undefined;
  if (/spec|plan|triage/i.test(stage)) return 'spec';
  if (/implement|repair|revis/i.test(stage)) return 'cell';
  if (/review|adversar|conformance/i.test(stage)) return 'review';
  return undefined;
}

/**
 * Where a card sits on the line: `at` is the station index (6 = past the line, done); `failed` marks that
 * station red. `prExists` moves a card in Review on to the pull request; `repairs > 0` lifts a running card to Gates.
 * A failed card with a `stage` (the hub board sets its failed run's stage) sits on that stage's station.
 */
export function stationOf(
  task: Pick<BoardTask, 'column' | 'stage'>,
  opts: { prExists?: boolean; repairs?: number } = {},
): { at: number; failed: boolean } {
  switch (task.column) {
    case 'queued': return { at: 0, failed: false };
    case 'claimed': return { at: 1, failed: false };
    case 'running': return { at: (opts.repairs ?? 0) > 0 ? Math.max(3, runningIndex(task.stage)) : runningIndex(task.stage), failed: false };
    case 'verify-failed': return { at: STATIONS.indexOf(stationOfStage(task.stage) ?? 'gates'), failed: true };
    case 'review': return { at: opts.prExists === true ? 5 : 4, failed: false };
    case 'done': return { at: STATIONS.length, failed: false };
  }
}

/** A finished run's result: the Runs row carries it (RunSummary); a run record is read into it by `detailOutcome`. */
export type RunOutcome = Pick<RunSummary, 'anyFailed' | 'prUrl' | 'prState' | 'cardDone' | 'stoppedBy' | 'failedStage' | 'verifyFailed'>;

/** A run record's outcome, as `listRuns` summarises it; `card` carries the hub's marks (its PR merged, its card done). */
export function detailOutcome(run: Pick<RunDetail, 'stages' | 'proof' | 'prUrl'>, card: Pick<RunSummary, 'prState' | 'cardDone'> = {}): RunOutcome {
  const failed = run.stages.map((s) => s.record).filter((r) => !r.completed);
  const failedStage = failed.find((r) => r.stage !== undefined)?.stage;
  return {
    anyFailed: failed.length > 0,
    ...(failed.length > 0 && failed.every((r) => r.stoppedBy === 'provider-limit') ? { stoppedBy: 'provider-limit' as const } : {}),
    ...(failedStage !== undefined ? { failedStage } : {}),
    ...(run.proof?.passed === false ? { verifyFailed: true as const } : {}),
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(card.prState !== undefined && run.prUrl !== undefined ? { prState: card.prState } : {}),
    ...(card.cardDone !== undefined ? { cardDone: card.cardDone } : {}),
  };
}

/**
 * The one mapping of a finished run onto the line, for the Board, the card panel, the Runs rows, the run page and Home:
 * a merged PR, or a passed run whose card is done without a PR (a local branch), is past the line; a failed verify marks Gates red; a failed stage marks its station red (a provider-limit
 * stop sits there, not failed); anything else, with or without a PR, waits on the PR station.
 */
export function runStationOf(run: RunOutcome): { at: number; failed: boolean } {
  const failed = run.anyFailed || run.verifyFailed === true;
  if (run.prState === 'merged' || (run.cardDone === true && !failed)) return { at: STATIONS.length, failed: false };
  const stageAt = STATIONS.indexOf(stationOfStage(run.failedStage) ?? 'cell');
  if (run.stoppedBy !== undefined) return { at: stageAt, failed: false };
  if (run.verifyFailed === true) return { at: 3, failed: true };
  if (run.anyFailed) return { at: stageAt, failed: true };
  return { at: 5, failed: false };
}

/** A card's place: a finished card (Review, failed, Done) by its newest run when one is known, else by its column. */
export function cardStationOf(
  task: Pick<BoardTask, 'column' | 'stage'>,
  run: RunOutcome | undefined,
  opts: { prExists?: boolean; repairs?: number } = {},
): { at: number; failed: boolean } {
  const finished = task.column === 'review' || task.column === 'verify-failed' || task.column === 'done';
  return finished && run !== undefined ? runStationOf(run) : stationOf(task, opts);
}
