import { createHubClient } from '../../../packages/hub-client/src/client';
import type { RepoStamp, RunDetail, RunSummary } from '../../../packages/hub-client/src/wire';
import { runStateWord } from '../../../packages/hub-client/src/runLabels';
import { withOrigin } from './connect';
import type { Credentials } from './credentials';
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
  summary?: RunSummary;
}

export interface RunsData {
  active: RunRow[];
  recent: RunRow[];
}

const hubClient = (c: Credentials, fetchImpl?: typeof fetch): ReturnType<typeof createHubClient> =>
  createHubClient({ baseUrl: c.url, token: c.token, fetch: withOrigin(c.url, fetchImpl) });

export const https = (u: string | undefined): string | null => (u !== undefined && /^https:\/\//.test(u) ? u : null);

const costOf = (r: RunSummary): string => (r.costUnknown ? 'cost unknown' : `$${r.totalCostUsd.toFixed(2)}`);

/** Active runs first (every project's `list_active`), then recent runs newest first (`list_runs_all`). */
export async function loadRuns(c: Credentials, fetchImpl?: typeof fetch, now: number = Date.now()): Promise<RunsData> {
  const client = hubClient(c, fetchImpl);
  const [{ runs }, projects, titles] = await Promise.all([
    client.call('list_runs_all'),
    client.call('list_projects').catch(() => []),
    client.call('list_tasks_all').then(
      (r) => new Map(r.tasks.map((t) => [`${t.repoPath}|${t.id}`, t.title] as const)),
      () => new Map<string, string>(),
    ),
  ]);
  const actives = await Promise.all(
    projects.map((p) =>
      client.call('list_active', { repoPath: p.path }).then(
        (list) => list.map((a): RunRow => ({
          id: `active|${p.path}|${a.taskId}`,
          taskId: a.taskId,
          repoPath: p.path,
          title: titles.get(`${p.path}|${a.taskId}`) ?? a.taskId,
          repo: p.name,
          status: 'running',
          active: true,
          cost: '',
          age: ageOf(new Date(a.lastActivityMs).toISOString(), now),
          timestamp: '',
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
      title: titles.get(`${r.repoPath}|${r.taskId}`) ?? r.taskId,
      repo: r.repoName,
      status: runStateWord(r),
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

export async function loadRunView(c: Credentials, row: RunRow, fetchImpl?: typeof fetch): Promise<RunView> {
  const detail = await hubClient(c, fetchImpl).call('read_run', { repoPath: row.repoPath, taskId: row.taskId, timestamp: row.timestamp, source: { kind: 'local' } });
  return { detail, diff: diffSummary(detail.stages), prUrl: https(detail.prUrl), diffUrl: https(detail.diffUrl), ciUrl: https(detail.ciUrl) };
}

const TERMINAL = new Set(['run-end', 'run-error', 'run-cancelled']);

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

const isTerminal = (e: LoggedEvent): boolean =>
  TERMINAL.has(e.event) || TERMINAL.has(innerEvent(e)?.type ?? '');

/**
 * Follow an active run's event log: each `/events` frame reads what the log gained since the last read.
 * `onLines` gets the whole bounded tail (at most MAX_LINES); `onEnd` fires once when the run ends, after which
 * the stream is closed and nothing more is read. Returns a function that stops it.
 */
export function followRun(
  c: Credentials,
  row: Pick<RunRow, 'repoPath' | 'taskId'>,
  handlers: { onLines: (lines: string[]) => void; onEnd: () => void; onError: (message: string) => void },
  fetchImpl?: typeof fetch,
): () => void {
  const client = hubClient(c, fetchImpl);
  let lines: string[] = [];
  let after = 0;
  let stopped = false;
  let busy = false;
  let again = false;
  let closeStream: (() => void) | undefined;

  const stop = (): void => {
    stopped = true;
    closeStream?.();
  };
  const read = async (): Promise<void> => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        let more = true;
        while (more && !stopped) {
          const r = await client.call('read_run_events', { repoPath: row.repoPath, taskId: row.taskId, after, limit: MAX_LINES });
          if (stopped) return;
          after = r.nextAfter;
          more = r.hasMore;
          if (r.events.length > 0) {
            lines = [...lines, ...r.events.map(eventLine)].slice(-MAX_LINES);
            handlers.onLines(lines);
          }
          if (r.events.some(isTerminal)) {
            stop();
            handlers.onEnd();
            return;
          }
        }
      } while (again && !stopped);
    } catch (err) {
      if (!stopped) handlers.onError(String(err));
    } finally {
      busy = false;
    }
  };

  closeStream = client.subscribe({
    onOpen: () => void read(),
    onEvent: () => void read(),
    onReset: () => void read(),
    onError: (message, detail) => {
      if (!stopped && !detail?.streamOpen) handlers.onError(message);
    },
  });
  void read();
  return stop;
}
