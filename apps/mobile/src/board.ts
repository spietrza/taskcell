import type { HubClient } from '../../../packages/hub-client/src/client';
import type { BoardTask, RepoReadFailure, RepoStamp } from '../../../packages/hub-client/src/wire';
import { STATION_SHORT, stationOf } from '../../../packages/hub-client/src/stations';
import { ageOf } from './needsYou';

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

/** The column of a station index (the hub's `view.place.at`; 6 is past the line); as the desktop's `COLUMN_OF_STATION`. */
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

export const boardColumn = (t: HubTask): string => COLUMN_OF_STATION[(t.view?.place ?? stationOf(t)).at] ?? 'done';

/** Hub tasks → cards, in the desktop's column order (the hub's order inside a column). The hub places each card (`view`). */
export function toCards(tasks: readonly HubTask[], now: number = Date.now()): Card[] {
  const order = (c: Card): number => COLUMNS.findIndex((x) => x.key === c.column);
  return tasks
    .map((task): Card => {
      const run = task.view?.run;
      // A claimed or running card's live state is its stage; the last delivered run is history, so it shows no PR/result.
      const live = task.column === 'queued' || task.column === 'claimed' || task.column === 'running';
      const finished = run !== undefined && !live ? run : undefined;
      return {
        id: `${task.repoPath ?? ''}|${task.id}`,
        title: task.title,
        repo: task.repoName || '',
        column: boardColumn(task),
        status: finished ? finished.state : task.state,
        age: ageOf(run?.timestamp, now),
        prUrl: https(finished?.prUrl),
        issueUrl: https(task.url),
        labels: task.labels ?? [],
        runStatus: run ? run.state : null,
        task,
      };
    })
    .sort((a, b) => order(a) - order(b)); // stable: the hub's order holds inside a column
}

export interface BoardData {
  cards: Card[];
  failures: RepoReadFailure[];
  capped: boolean;
}

/** The hub's tasks of every repository, each already placed by the hub (its newest run and waiting item ride on the card). */
export async function loadBoard(client: HubClient): Promise<BoardData> {
  const { tasks, capped, failures } = await client.call('list_tasks_all');
  return { cards: toCards(tasks), failures: failures ?? [], capped };
}
