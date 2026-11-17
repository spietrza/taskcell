import type { Proof, StageDetail } from '../../taskcell-output';
import { parseAgentStream } from './parseStream';

export type StagePhase = 'done' | 'failed' | 'running' | 'pending';
export interface PaneStage {
  name: string;
  phase: StagePhase;
  /** Finished stage: its duration. */
  ms?: number;
  /** The card's heading; the stage's name when absent. */
  label?: string;
  /** Index into the run's stage records, for a stage that has a transcript to pick. */
  src?: number;
  /** A gate step's outcome or the PR number, shown where a duration would be. */
  note?: string;
  /** The PR step links to the pull request. */
  href?: string;
  /** When the stage started (epoch ms): a running card ticks from it. */
  startedAt?: number;
  /** Finished stage: when it ended (epoch ms). */
  endedAt?: number;
}
export interface RunTimeline {
  /** The hub's id for the run: what Cancel needs. */
  runId?: string;
  stages: PaneStage[];
  startedAt?: number;
  endedAt?: number;
  terminal?: 'success' | 'no-changes' | 'secret-blocked' | 'error' | 'cancelled';
  message?: string;
}
export interface LoggedEvent {
  id: number;
  ts: string;
  event: string;
  data: unknown;
}

const STAGE_LABEL: Record<string, string> = { sandbox: 'Cell', implementer: 'Code', reviewer: 'Review', simplifier: 'Simplify', spec: 'Plan', planner: 'Plan' };
/** A stage's heading in words: `implementer` -> Code, any unknown name capitalized. */
export function stageLabel(name: string): string {
  return STAGE_LABEL[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** `75000` -> `1m 15s`; under a minute `42s`; an hour or more `1h 02m`. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Fold a run's persisted event log into its stage line. The stages are the ones `run-start` named, so a
 * flow with other stages shows those; a stage not started yet is pending. Duration = start to end event.
 */
export function foldRunEvents(events: LoggedEvent[]): RunTimeline {
  const t: RunTimeline = { stages: [] };
  for (const l of events) {
    const at = Date.parse(l.ts);
    const d = l.data as { runId?: string; event?: Record<string, unknown> } | null;
    const e = d?.event;
    if (!e || typeof e.type !== 'string') continue;
    if (t.runId === undefined && typeof d?.runId === 'string') t.runId = d.runId;
    t.startedAt ??= at;
    const i = Number(e.index);
    // The sandbox starts before the run does: its events precede `run-start` and are kept for it.
    const prev = t.stages[i] ?? (e.name === 'sandbox' && i === 0 ? { name: 'sandbox', phase: 'pending' as const } : undefined);
    switch (e.type) {
      case 'run-start': {
        const early = t.stages[0]?.name === 'sandbox' ? t.stages[0] : undefined;
        if (!early) t.startedAt = at;
        t.stages = (Array.isArray(e.stages) ? (e.stages as string[]) : []).map((name, n) => (n === 0 && early && name === 'sandbox' ? early : { name, phase: 'pending' as const }));
        break;
      }
      case 'stage-start':
        if (prev) t.stages[i] = { name: prev.name, phase: 'running', startedAt: at };
        break;
      case 'stage-end':
        if (prev) t.stages[i] = { name: prev.name, phase: e.outcome === 'completed' ? 'done' : 'failed', ...(prev.startedAt !== undefined ? { ms: at - prev.startedAt, startedAt: prev.startedAt } : {}), endedAt: at };
        break;
      case 'run-end':
        t.terminal = e.secretBlocked === true ? 'secret-blocked' : e.prUrl !== undefined ? 'success' : 'no-changes';
        t.endedAt = at;
        break;
      case 'run-error':
        t.terminal = 'error';
        if (typeof e.message === 'string') t.message = e.message;
        t.endedAt = at;
        break;
      case 'run-cancelled':
        t.terminal = 'cancelled';
        t.endedAt = at;
        break;
    }
  }
  return t;
}

/**
 * How long the tests ran, from the event log: the gate runs between the last implementing stage's end and the
 * reviewer's start (the pipeline's gateBeforeReview). Undefined without a reviewer or before it started.
 */
export function gateMs(stages: PaneStage[]): number | undefined {
  const at = stages.map((s) => /implement/i.test(s.name)).lastIndexOf(true);
  const impl = stages[at];
  const next = stages[at + 1];
  if (at < 0 || impl?.endedAt === undefined || next?.name !== 'reviewer' || next.startedAt === undefined) return undefined;
  return Math.max(0, next.startedAt - impl.endedAt);
}

/**
 * A live run's Tests and PR cards (Tests after the last implementing stage, PR last). No event marks the gate,
 * so Tests runs once the implementing stage is done and has passed once the reviewer started (it runs only on a green gate).
 */
export function withPendingGateSteps(stages: PaneStage[]): PaneStage[] {
  const out = [...stages];
  const at = out.map((s) => /implement/i.test(s.name)).lastIndexOf(true);
  const impl = out[at];
  const ms = gateMs(stages);
  const tests: PaneStage =
    ms !== undefined ? { name: 'tests', label: 'Gates', phase: 'done', ms }
    : impl?.phase === 'done' && impl.endedAt !== undefined && (out[at + 1] === undefined || out[at + 1]!.phase === 'pending') ? { name: 'tests', label: 'Gates', phase: 'running', startedAt: impl.endedAt }
    : { name: 'tests', label: 'Gates', phase: 'pending' };
  out.splice(at < 0 ? out.length : at + 1, 0, tests);
  out.push({ name: 'pr', label: 'PR', phase: 'pending' });
  return out;
}

/** A finished run's stage line, from its stage records (one per stage, with the stage's own duration). */
export function stagesFromRecords(stages: StageDetail[]): PaneStage[] {
  return stages.map((s, src): PaneStage => ({ name: s.record.stage ?? 'run', src, phase: s.record.completed ? 'done' : 'failed', ...(s.record.durationMs !== undefined ? { ms: s.record.durationMs } : {}) }));
}

/**
 * The gate steps the records show: Tests (the verify gate's proof of work) right after the last implementing
 * stage (else at the end), then PR when the run opened one. A step whose record is absent is left out. A gate
 * has no record of its own: a passed one shows the time the event log gives it (`testsMs`), else its outcome.
 */
export function withGateSteps(stages: PaneStage[], proof: Proof | undefined, prUrl: string | undefined, testsMs?: number): PaneStage[] {
  const out = [...stages];
  if (proof) {
    const at = out.map((s) => /implement/i.test(s.name)).lastIndexOf(true);
    out.splice(at < 0 ? out.length : at + 1, 0, { name: 'tests', label: 'Gates', phase: proof.passed ? 'done' : 'failed', ...(proof.passed && testsMs !== undefined ? { ms: testsMs } : { note: proof.passed ? 'Passed' : 'Failed' }) });
  }
  if (prUrl !== undefined) {
    const n = /(\d+)\/?$/.exec(prUrl)?.[1];
    out.push({ name: 'pr', label: 'PR', phase: 'done', note: n !== undefined ? `#${n}` : 'Opened', href: prUrl });
  }
  return out;
}

/** One terminal line: a tool call is a `$` command, a tool result and the agent's words plain text. */
export interface LogLine {
  cmd: boolean;
  text: string;
}
export function toLogLines(entries: { role: string; text: string }[], max = 12): LogLine[] {
  return entries
    // Tool calls and the agent's words only: tool results and the per-stage cost line are noise in a tail.
    .filter((e) => e.role === 'tool' || e.role === 'assistant')
    .map((e): LogLine => ({ cmd: e.role === 'tool', text: e.role === 'assistant' ? (e.text.split('\n').find((l) => l.trim() !== '') ?? '').trim() : e.text.trim() }))
    .filter((l) => l.text !== '')
    .slice(-max);
}

export const transcriptLines = (transcript: string | undefined, max?: number): LogLine[] => toLogLines(transcript ? parseAgentStream(transcript) : [], max);
