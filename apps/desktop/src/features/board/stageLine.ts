import type { BoardTask, RunDetail } from '../../wire';
import { STATIONS, STATION_LABEL, stationOf, type Station } from '../../stations';

export type StageStatus = 'done' | 'current' | 'waiting' | 'failed';
export interface StageStep {
  key: Station;
  label: string;
  status: StageStatus;
  /** Short calm remark, e.g. "repair 1 of 2". */
  note?: string;
}

/** The factory's default number of gate repairs (`--max-repair-iterations`), for records that predate the run carrying its own cap. */
const DEFAULT_MAX_REPAIRS = 2;

/** The run's own repair cap (`--max-repair-iterations`), else the default. */
export function repairCap(run?: Pick<RunDetail, 'stages'>): number {
  return run?.stages.find((s) => s.record.maxRepairIterations !== undefined)?.record.maxRepairIterations ?? DEFAULT_MAX_REPAIRS;
}

/** Gate repairs so far: gate repairs fold into the implementer record as extra attempts (`attempts`). */
export function repairAttempts(run?: Pick<RunDetail, 'stages'>): number {
  const attempts = run?.stages.find((s) => s.record.stage === 'implementer')?.record.attempts ?? 1;
  return Math.max(0, attempts - 1);
}

/**
 * The six stations for a place on the line (`stationOf`, `runStationOf`, `cardStationOf`): stations before `at` are done,
 * after it waiting; `at` itself is current, or failed. `repairs` notes the gate repairs on a current Gates station.
 */
export function stepsAt(place: { at: number; failed: boolean }, opts: { repairs?: number; maxRepairs?: number } = {}): StageStep[] {
  const { at, failed } = place;
  const repairs = opts.repairs ?? 0;
  const cap = opts.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  return STATIONS.map((key, i): StageStep => {
    const status: StageStatus = i < at ? 'done' : i > at ? 'waiting' : failed ? 'failed' : 'current';
    const step: StageStep = { key, label: STATION_LABEL[key], status };
    if (key === 'gates' && repairs > 0 && status === 'current') step.note = `repair ${Math.min(repairs, cap)} of ${cap}`;
    return step;
  });
}

/** A card's six stations from its column (queued, claimed, running, verify-failed, review, done); `prExists` moves Review on to the PR. */
export function stageLine(
  task: Pick<BoardTask, 'column' | 'stage'>,
  opts: { prExists?: boolean; repairs?: number; maxRepairs?: number } = {},
): StageStep[] {
  return stepsAt(stationOf(task, opts), opts);
}

/**
 * A live run's six stations: `stage` = the running stage (else the last finished one), whose station is current;
 * none yet = the card was just claimed. `failed` marks the current station red (the run errored).
 */
export function liveStations(stage: string | undefined, failed = false): StageStep[] {
  const steps = stageLine(stage === undefined ? { column: 'claimed' } : { column: 'running', stage });
  return failed ? steps.map((s) => (s.status === 'current' ? { ...s, status: 'failed' } : s)) : steps;
}

/** The stage a live run's stations follow: the running one, else the last finished; the gate step (`tests`) as `gates` so stationOf reads it. */
export function liveStage(stages: { name: string; phase: string }[]): string | undefined {
  const at = stages.find((s) => s.phase === 'running') ?? [...stages].reverse().find((s) => s.phase !== 'pending');
  return at?.name === 'tests' ? 'gates' : at?.name;
}
