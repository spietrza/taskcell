import type { HubClient } from '../../../packages/hub-client/src/client';
import type { RepoStamp, RunDetail, RunSummary } from '../../../packages/hub-client/src/wire';
import { tailRun } from '../../../packages/hub-client/src/runTail';
import { runStateWord } from '../../../packages/hub-client/src/run-labels';
import { ageOf } from './needsYou';

/** The most transcript lines the run view holds; older ones are dropped as new ones arrive. */
export const MAX_LINES = 50;

export interface RunRow {
  id: string;
  taskId: string;
  repoPath: string;
  title: string;
  repo: string;
  /** "running" for an active run, else the finished run's state word. */
  status: string;
  active: boolean;
  /** "$0.42", "cost unknown", or '' for an active run (no cost until it ends). */
  cost: string;
  age: string;
  /** The run record's time (finished runs); '' for an active one. */
  timestamp: string;
  /** The task's issue page (https only), or null when the board has none. */
  issueUrl: string | null;
  /** An active run's last session activity (ms): a log whose run ended before it is an older run's. */
  activeSince?: number;
  summary?: RunSummary;
}

export interface RunsData {
  active: RunRow[];
  recent: RunRow[];
}

export const https = (u: string | undefined): string | null => (u !== undefined && /^https:\/\//.test(u) ? u : null);

const costOf = (r: RunSummary): string => (r.costUnknown ? 'cost unknown' : `$${r.totalCostUsd.toFixed(2)}`);

/** Active runs first (every project's `list_active`), then recent runs newest first (`list_runs_all`). */
export async function loadRuns(client: HubClient, now: number = Date.now()): Promise<RunsData> {
  const [{ runs }, projects, tasks] = await Promise.all([
    client.call('list_runs_all'),
    client.call('list_projects').catch(() => []),
    client.call('list_tasks_all').then(
      (r) => new Map(r.tasks.map((t) => [`${t.repoPath}|${t.id}`, { title: t.title, issueUrl: https(t.url) }] as const)),
      () => new Map<string, Pick<RunRow, 'title' | 'issueUrl'>>(),
    ),
  ]);
  const taskOf = (repoPath: string, taskId: string): Pick<RunRow, 'title' | 'issueUrl'> =>
    tasks.get(`${repoPath}|${taskId}`) ?? { title: taskId, issueUrl: null };
  const actives = await Promise.all(
    projects.map((p) =>
      client.call('list_active', { repoPath: p.path }).then(
        (list) => list.map((a): RunRow => ({
          id: `active|${p.path}|${a.taskId}`,
          taskId: a.taskId,
          repoPath: p.path,
          ...taskOf(p.path, a.taskId),
          repo: p.name,
          status: 'running',
          active: true,
          cost: '',
          age: ageOf(new Date(a.lastActivityMs).toISOString(), now),
          timestamp: '',
          activeSince: a.lastActivityMs,
        })),
        () => [] as RunRow[],
      ),
    ),
  );
  const recent = runs
    .filter((r: RunSummary & RepoStamp) => r.source !== 'ci')
    .map((r): RunRow => ({
      id: `${r.repoPath}|${r.taskId}|${r.timestamp}`,
      taskId: r.taskId,
      repoPath: r.repoPath,
      ...taskOf(r.repoPath, r.taskId),
      repo: r.repoName,
      // An older hub sends no outcome: the state word from the row itself.
      status: r.outcome?.state ?? runStateWord(r),
      active: false,
      cost: costOf(r),
      age: ageOf(r.timestamp, now),
      timestamp: r.timestamp,
      summary: r,
    }))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { active: actives.flat(), recent };
}

export interface DiffSummary {
  files: number;
  added: number;
  removed: number;
}

/** Files changed and +/− lines of a unified diff; null when no stage carries one. The last stage with a diff is the run's change. */
export function diffSummary(stages: RunDetail['stages']): DiffSummary | null {
  const diff = [...stages].reverse().find((s) => s.diff)?.diff;
  if (!diff) return null;
  const out = { files: 0, added: 0, removed: 0 };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) out.files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) out.added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) out.removed += 1;
  }
  return out;
}

export interface RunView {
  detail: RunDetail;
  diff: DiffSummary | null;
  prUrl: string | null;
  diffUrl: string | null;
  ciUrl: string | null;
}

export async function loadRunView(client: HubClient, row: RunRow): Promise<RunView> {
  const detail = await client.call('read_run', { repoPath: row.repoPath, taskId: row.taskId, timestamp: row.timestamp, source: { kind: 'local' } });
  return { detail, diff: diffSummary(detail.stages), prUrl: https(detail.prUrl), diffUrl: https(detail.diffUrl), ciUrl: https(detail.ciUrl) };
}

interface LoggedEvent {
  id: number;
  ts: string;
  event: string;
  data: unknown;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

const innerEvent = (e: LoggedEvent): { type?: string } | undefined => (e.data as { event?: { type?: string } } | null)?.event;

/** One event-log entry as a transcript line. */
export function eventLine(e: LoggedEvent): string {
  const inner = innerEvent(e);
  const name = inner?.type ?? e.event;
  const detail = inner ? JSON.stringify(inner) : text(e.data);
  const time = e.ts.slice(11, 19);
  return `${time} ${name}${detail && detail !== '""' ? ` ${detail.slice(0, 160)}` : ''}`;
}

/**
 * Follow an active run's event log (the shared tail in packages/hub-client).
 * `onLines` gets the whole bounded tail (at most MAX_LINES); `onEnd` fires once when the run ends.
 * Returns a function that stops it.
 */
export function followRun(
  client: HubClient,
  row: Pick<RunRow, 'repoPath' | 'taskId' | 'activeSince'>,
  handlers: { onLines: (lines: string[]) => void; onEnd: () => void; onError: (message: string) => void },
): () => void {
  return tailRun(
    client,
    { repoPath: row.repoPath, taskId: row.taskId, activeSince: row.activeSince, keep: MAX_LINES },
    { onEvents: (events) => handlers.onLines(events.map(eventLine)), onEnd: handlers.onEnd, onError: handlers.onError },
  );
}
