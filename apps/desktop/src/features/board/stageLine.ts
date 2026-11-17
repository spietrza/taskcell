import type { BoardTask, RunDetail } from '../../wire';
import { STATIONS, STATION_LABEL, stationOf, type Station } from '../../stations';
import { stationOfStage } from './stationNotes';

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
 * The one mapping from the hub's states (queued, claimed, running, verify-failed, review, done) to
 * the six-stage line. `prExists` moves a card in Review on to the pull request stage.
 */
export function stageLine(
  task: Pick<BoardTask, 'column' | 'stage'>,
  opts: { prExists?: boolean; repairs?: number; maxRepairs?: number } = {},
): StageStep[] {
  // `at` is the current stage; stages before it are done, after it waiting.
  const { at, failed } = stationOf(task, opts);
  const repairs = opts.repairs ?? 0;
  const cap = opts.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  return STATIONS.map((key, i): StageStep => {
    const status: StageStatus = i < at ? 'done' : i > at ? 'waiting' : failed ? 'failed' : 'current';
    const step: StageStep = { key, label: STATION_LABEL[key], status };
    if (key === 'gates' && repairs > 0 && status === 'current') step.note = `repair ${Math.min(repairs, cap)} of ${cap}`;
    return step;
  });
}

/**
 * A finished run's six stations, from its record alone: merged = past the line; a failed gate or stage marks
 * its station red; an open PR waits on you; a run that opened no PR leaves the PR station waiting.
 */
export function runStations(run: Pick<RunDetail, 'stages' | 'proof' | 'prUrl'>, merged: boolean): StageStep[] {
  const failedStage = run.stages.find((s) => !s.record.completed)?.record.stage;
  const failedAt = run.proof?.passed === false ? 3 : failedStage !== undefined ? STATIONS.indexOf(stationOfStage(failedStage) ?? 'cell') : undefined;
  const at = merged ? STATIONS.length : failedAt ?? 5;
  return STATIONS.map((key, i): StageStep => {
    const status: StageStatus = i < at ? 'done' : i > at ? 'waiting' : failedAt !== undefined && !merged ? 'failed' : run.prUrl === undefined ? 'waiting' : 'current';
    return { key, label: STATION_LABEL[key], status };
  });
}
