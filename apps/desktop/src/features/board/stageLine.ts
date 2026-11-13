import type { BoardTask, RunDetail } from '../../wire';

const STAGE_KEYS = ['card', 'spec', 'cell', 'gates', 'review', 'pr'] as const;
type StageKey = (typeof STAGE_KEYS)[number];
export type StageStatus = 'done' | 'current' | 'waiting' | 'failed';
export interface StageStep {
  key: StageKey;
  label: string;
  status: StageStatus;
  /** Short calm remark, e.g. "repair 1 of 2". */
  note?: string;
}

/** The factory's default number of gate repairs (`--max-repair-iterations`); the run record does not carry an override. */
const DEFAULT_MAX_REPAIRS = 2;

const LABEL: Record<StageKey, string> = {
  card: 'Card',
  spec: 'Spec',
  cell: 'Sealed cell',
  gates: 'Gates',
  review: 'Review',
  pr: 'Pull request',
};

/** Which of the six stages a running card's pipeline stage marker sits on. */
function runningIndex(stage: string | undefined): number {
  if (stage === undefined) return 2;
  if (/spec/i.test(stage)) return 1;
  if (/conformance|proof|verify|gate/i.test(stage)) return 3;
  if (/review|adversary/i.test(stage)) return 4;
  return 2;
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
  opts: { prExists?: boolean; repairs?: number } = {},
): StageStep[] {
  // `at` is the current stage; stages before it are done, after it waiting.
  let at: number;
  let failed = false;
  switch (task.column) {
    case 'queued': at = 0; break;
    case 'claimed': at = 1; break;
    case 'running': at = (opts.repairs ?? 0) > 0 ? Math.max(3, runningIndex(task.stage)) : runningIndex(task.stage); break;
    case 'verify-failed': at = 3; failed = true; break;
    case 'review': at = opts.prExists === true ? 5 : 4; break;
    case 'done': at = STAGE_KEYS.length; break;
  }
  const repairs = opts.repairs ?? 0;
  return STAGE_KEYS.map((key, i): StageStep => {
    const status: StageStatus = i < at ? 'done' : i > at ? 'waiting' : failed ? 'failed' : 'current';
    const step: StageStep = { key, label: LABEL[key], status };
    if (key === 'gates' && repairs > 0 && status === 'current') step.note = `repair ${Math.min(repairs, DEFAULT_MAX_REPAIRS)} of ${DEFAULT_MAX_REPAIRS}`;
    return step;
  });
}
