import type { StageDetail } from '../../taskcell-output';
import { parseAgentStream } from './parseStream';

export type StagePhase = 'done' | 'failed' | 'running' | 'pending';
export interface PaneStage {
  name: string;
  phase: StagePhase;
  /** Finished stage: its duration. */
  ms?: number;
  /** Running stage: when it started (epoch ms), so its card can tick. */
  startedAt?: number;
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
    const prev = t.stages[i];
    switch (e.type) {
      case 'run-start':
        t.startedAt = at;
        t.stages = (Array.isArray(e.stages) ? (e.stages as string[]) : []).map((name) => ({ name, phase: 'pending' as const }));
        break;
      case 'stage-start':
        if (prev) t.stages[i] = { name: prev.name, phase: 'running', startedAt: at };
        break;
      case 'stage-end':
        if (prev) t.stages[i] = { name: prev.name, phase: e.outcome === 'completed' ? 'done' : 'failed', ...(prev.startedAt !== undefined ? { ms: at - prev.startedAt } : {}) };
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

/** A finished run's stage line, from its stage records (one per stage, with the stage's own duration). */
export function stagesFromRecords(stages: StageDetail[]): PaneStage[] {
  return stages.map((s): PaneStage => ({ name: s.record.stage ?? 'run', phase: s.record.completed ? 'done' : 'failed', ...(s.record.durationMs !== undefined ? { ms: s.record.durationMs } : {}) }));
}

/** One terminal line: a tool call is a `$` command, a tool result and the agent's words plain text. */
export interface LogLine {
  cmd: boolean;
  text: string;
}
export function toLogLines(entries: { role: string; text: string }[], max = 12): LogLine[] {
  return entries
    .map((e): LogLine => ({ cmd: e.role === 'tool', text: e.role === 'assistant' ? (e.text.split('\n').find((l) => l.trim() !== '') ?? '').trim() : e.text.trim() }))
    .filter((l) => l.text !== '')
    .slice(-max);
}

export const transcriptLines = (transcript: string | undefined, max?: number): LogLine[] => toLogLines(transcript ? parseAgentStream(transcript) : [], max);
