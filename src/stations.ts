// The line's stations and the live-run mapping, shared by the hub (src/hub/card-view.ts decides where a card sits) and the
// desktop and mobile clients (copied to packages/hub-client/src by `pnpm gen:wire`; pure: no DOM, Tauri or Node).
import type { BoardTask, CardPlace } from './wire.js';

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

/** A place on the line (the wire's `CardPlace`): `at` is the station index, 6 past the line. */
export type Place = CardPlace;

/**
 * Where a card sits by its column alone (the hub's card view falls back to it when no finished run is known; the clients use it for a live run).
 * `prExists` moves a card in Review on to the pull request; `repairs > 0` lifts a running card to Gates.
 * A failed card with a `stage` (the hub board sets its failed run's stage) sits on that stage's station; one whose
 * agent stopped to ask (`asked`) waits there, not failed.
 */
export function stationOf(
  task: Pick<BoardTask, 'column' | 'stage' | 'asked'>,
  opts: { prExists?: boolean; repairs?: number } = {},
): CardPlace {
  switch (task.column) {
    case 'queued': return { at: 0, failed: false };
    case 'claimed': return { at: 1, failed: false };
    case 'running': return { at: (opts.repairs ?? 0) > 0 ? Math.max(3, runningIndex(task.stage)) : runningIndex(task.stage), failed: false };
    case 'verify-failed': return { at: STATIONS.indexOf(stationOfStage(task.stage) ?? 'gates'), failed: task.asked !== true };
    case 'review': return { at: opts.prExists === true ? 5 : 4, failed: false };
    case 'done': return { at: STATIONS.length, failed: false };
  }
}
