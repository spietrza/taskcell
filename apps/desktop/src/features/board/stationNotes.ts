import type { AppConfig, BoardTask, RunDetail, RunRecord } from '../../wire';
import type { Station } from '../../stations';
import { stationSummary } from '../line/stationSummary';
import { fmtDuration } from '../inspector/runStages';
import type { StageStep } from './stageLine';

/** The station a run record's stage belongs to; undefined for a stage the line does not show (sandbox, simplifier). */
export function stationOfStage(stage: string | undefined): Station | undefined {
  if (stage === undefined) return undefined;
  if (/spec|plan|triage/i.test(stage)) return 'spec';
  if (/implement|repair|revis/i.test(stage)) return 'cell';
  if (/review|adversar|conformance/i.test(stage)) return 'review';
  return undefined;
}

const join = (...parts: (string | undefined | false)[]): string => parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

/** `model · 1m 20s` for the records of one station: the last record's model, the summed duration. */
function recordLine(records: RunRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  const ms = records.reduce((n, r) => n + (r.durationMs ?? 0), 0);
  return join(records.at(-1)?.model, ms > 0 && fmtDuration(ms));
}

export interface NoteContext {
  task: Pick<BoardTask, 'column' | 'stage' | 'waiting'>;
  /** The project's Line config; absent while it loads or when it cannot be read. */
  cfg?: AppConfig;
  /** The card's latest finished run. Ignored while the card runs: that record is an older run's. */
  detail?: RunDetail;
  prUrl?: string;
}

/**
 * The one line under a station: what the run record says it did (done), what happens now (current), or what
 * the Line config says will happen (waiting). Empty when nothing is known: never a guess.
 */
export function stationNote(step: Pick<StageStep, 'key' | 'status' | 'note'>, ctx: NoteContext): string {
  const { task, cfg, prUrl } = ctx;
  const live = task.column === 'running' || task.column === 'claimed';
  const detail = live ? undefined : ctx.detail;
  const records = (detail?.stages ?? []).map((s) => s.record).filter((r) => stationOfStage(r.stage) === step.key);
  const planned = cfg === undefined ? '' : stationSummary(step.key, cfg).join(' · ');

  if (step.status === 'waiting') return planned;
  if (step.status === 'failed') return join(detail?.proof?.passed === false ? 'tests failed' : 'failed', step.note);
  if (step.status === 'current') {
    switch (step.key) {
      case 'card': return task.waiting === true ? 'waiting for a cell' : join('not started', planned);
      case 'spec': return task.column === 'claimed' ? 'claimed, spec next' : 'writing the spec';
      case 'cell': return join('building now', task.stage);
      case 'gates': return join(`running ${cfg?.verifyCmd || 'verify'}`, step.note);
      case 'review': return task.column === 'running' ? 'second AI reading the diff' : join('review pending', recordLine(records));
      case 'pr': return 'you sign off';
    }
  }
  // done
  switch (step.key) {
    case 'card': return 'picked up';
    case 'spec': return recordLine(records) ?? '';
    case 'cell': return recordLine(records) ?? '';
    case 'gates': return detail?.proof === undefined ? '' : detail.proof.passed ? 'tests passed' : 'tests failed';
    case 'review': {
      const verdict = records.find((r) => r.verdict !== undefined)?.verdict;
      return join(verdict === 'pass' ? 'passed' : verdict === 'changes' ? 'changes requested' : verdict, recordLine(records));
    }
    case 'pr': {
      const n = prUrl === undefined ? undefined : /(\d+)\/?$/.exec(prUrl)?.[1];
      return join(task.column === 'done' ? 'merged' : 'opened', n !== undefined && `#${n}`);
    }
  }
}

/** The state word a screen reader and the track show: a current station on a card that is not running waits. */
export function stationState(step: Pick<StageStep, 'status'>, column: BoardTask['column']): 'done' | 'running' | 'failed' | 'waiting' {
  if (step.status === 'current') return column === 'running' || column === 'claimed' ? 'running' : 'waiting';
  return step.status;
}

/** `3 files · +40 −12` for a unified diff; undefined when there is no diff. */
export function diffStat(diff: string | undefined): string | undefined {
  if (diff === undefined || diff === '') return undefined;
  const lines = diff.split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git ')).length;
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return `${files} ${files === 1 ? 'file' : 'files'} · +${added} −${removed}`;
}
