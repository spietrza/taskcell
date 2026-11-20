import { createHubClient } from '../../../packages/hub-client/src/client';
import type { BoardTask, RepoReadFailure, RepoStamp, RunSummary } from '../../../packages/hub-client/src/wire';
import { taskRefKey } from '../../desktop/src/features/board/taskref';
import { runStateWord } from '../../desktop/src/runLabels';
import { STATION_SHORT, cardStationOf } from '../../desktop/src/stations';
import { ageOf } from './needsYou';
import { withOrigin } from './connect';
import type { Credentials } from './credentials';

export type HubTask = BoardTask & Partial<RepoStamp>;

/** The desktop Board's columns, left to right (`COLUMNS` in TaskBoard.tsx): a card sits in the column of its station. */
export const COLUMNS = [
  { key: 'card', label: STATION_SHORT.card },
  { key: 'spec', label: STATION_SHORT.spec },
  { key: 'cell', label: STATION_SHORT.cell },
  { key: 'gates', label: STATION_SHORT.gates },
  { key: 'review', label: `${STATION_SHORT.review} / ${STATION_SHORT.pr}` },
  { key: 'done', label: 'Done' },
] as const;

/** The column of a station index (`cardStationOf(...).at`; 6 is past the line); as the desktop's `COLUMN_OF_STATION`. */
const COLUMN_OF_STATION = ['card', 'spec', 'cell', 'gates', 'review', 'review', 'done'] as const;

export interface Card {
  id: string;
  title: string;
  repo: string;
  column: string;
  /** The card's state: its newest run's word when it has finished one, else the tracker's chip. */
  status: string;
  age: string;
  /** The PR page (https only), or null. */
  prUrl: string | null;
  /** The issue page (https only), or null. */
  issueUrl: string | null;
  labels: string[];
  /** Latest local run's state word; null when none. */
  runStatus: string | null;
  task: HubTask;
}

const https = (u: string | undefined): string | null => (u !== undefined && /^https:\/\//.test(u) ? u : null);

/** Each card's newest local run (runs come newest first), keyed by card id; as the desktop's `newestRuns`. */
export type HubRun = RunSummary & Partial<RepoStamp>;

/** A card's key in the runs map: its repository too, since two repositories can both have `gh-3`. */
const runKey = (repoPath: string | undefined, taskId: string): string => `${repoPath ?? ''}|${taskRefKey(taskId)}`;

export function newestRuns(runs: readonly HubRun[]): Map<string, RunSummary> {
  const out = new Map<string, RunSummary>();
  for (const r of runs) if (r.source !== 'ci' && !out.has(runKey(r.repoPath, r.taskId))) out.set(runKey(r.repoPath, r.taskId), r);
  return out;
}

export const boardColumn = (t: HubTask, run?: RunSummary): string => COLUMN_OF_STATION[cardStationOf(t, run).at] ?? 'done';

/** Hub tasks → cards, in the desktop's column order (the hub's order inside a column). */
export function toCards(tasks: readonly HubTask[], runs: readonly HubRun[], now: number = Date.now()): Card[] {
  const last = newestRuns(runs);
  const order = (c: Card): number => COLUMNS.findIndex((x) => x.key === c.column);
  return tasks
    .map((task): Card => {
      const run = last.get(runKey(task.repoPath, task.id));
      // A claimed or running card's live state is its stage; the last delivered run is history, so it shows no PR/result.
      const live = task.column === 'queued' || task.column === 'claimed' || task.column === 'running';
      const finished = run !== undefined && !live ? run : undefined;
      return {
        id: `${task.repoPath ?? ''}|${task.id}`,
        title: task.title,
        repo: task.repoName || '',
        column: boardColumn(task, run),
        status: finished ? runStateWord(finished) : task.state,
        age: ageOf(run?.timestamp, now),
        prUrl: https(finished?.prUrl),
        issueUrl: https(task.url),
        labels: task.labels ?? [],
        runStatus: run ? runStateWord(run) : null,
        task,
      };
    })
    .sort((a, b) => order(a) - order(b)); // stable: the hub's order holds inside a column
}

const hubClient = (c: Credentials, fetchImpl?: typeof fetch): ReturnType<typeof createHubClient> =>
  createHubClient({ baseUrl: c.url, token: c.token, fetch: withOrigin(c.url, fetchImpl) });

export interface BoardData {
  cards: Card[];
  failures: RepoReadFailure[];
  capped: boolean;
}

/** The hub's tasks of every repository, with their runs (which place a card in Review / Done). Runs are optional: a failed read leaves cards placed by their column. */
export async function loadBoard(c: Credentials, fetchImpl?: typeof fetch): Promise<BoardData> {
  const client = hubClient(c, fetchImpl);
  const [{ tasks, capped, failures }, runs] = await Promise.all([
    client.call('list_tasks_all'),
    client.call('list_runs_all').then((r) => r.runs, () => [] as HubRun[]),
  ]);
  return { cards: toCards(tasks, runs), failures: failures ?? [], capped };
}
