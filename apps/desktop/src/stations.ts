import type { BoardTask, RunSummary } from './wire';

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

/**
 * Where a card sits on the line: `at` is the station index (6 = past the line, done); `failed` marks that
 * station red. `prExists` moves a card in Review on to the pull request; `repairs > 0` lifts a running card to Gates.
 */
export function stationOf(
  task: Pick<BoardTask, 'column' | 'stage'>,
  opts: { prExists?: boolean; repairs?: number } = {},
): { at: number; failed: boolean } {
  switch (task.column) {
    case 'queued': return { at: 0, failed: false };
    case 'claimed': return { at: 1, failed: false };
    case 'running': return { at: (opts.repairs ?? 0) > 0 ? Math.max(3, runningIndex(task.stage)) : runningIndex(task.stage), failed: false };
    case 'verify-failed': return { at: 3, failed: true };
    case 'review': return { at: opts.prExists === true ? 5 : 4, failed: false };
    case 'done': return { at: STATIONS.length, failed: false };
  }
}

/**
 * Where a finished run left its card: merged is past the line, an open PR sits on PR, a failure (or a provider-limit
 * stop, not a failure) on the station of its last stage, and a pass without a PR on Review.
 */
export function runStationOf(run: Pick<RunSummary, 'stages' | 'anyFailed' | 'prUrl' | 'prState' | 'stoppedBy'>): { at: number; failed: boolean } {
  if (run.prState === 'merged') return { at: STATIONS.length, failed: false };
  if (run.prUrl !== undefined) return { at: 5, failed: false };
  if (run.anyFailed || run.stoppedBy !== undefined) return { at: runningIndex(run.stages.at(-1)), failed: run.stoppedBy === undefined };
  return { at: 4, failed: false };
}
