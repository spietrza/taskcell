// What ⌘K can find besides commands: the cards and runs the Board and Runs last loaded (they publish their own lists
// here), plus one read of every shown project's cards and runs each time the palette opens (`loadPalette`).
import { listRunsAll, listTasksAll } from './ipc';
import type { RepoStamp, RunSummary } from './wire';

export interface PaletteCard {
  id: string;
  title: string;
  repoPath?: string;
}
export type PaletteRun = RunSummary & Partial<RepoStamp>;

let cards: readonly PaletteCard[] = [];
let runs: readonly PaletteRun[] = [];

// Bumped by `clearPalette`, so a read started for the previous team or session never publishes.
let gen = 0;

export const publishCards = (list: readonly PaletteCard[]): void => void (cards = list);
export const publishRuns = (list: readonly PaletteRun[]): void => void (runs = list);
export const paletteItems = (): { cards: readonly PaletteCard[]; runs: readonly PaletteRun[] } => ({ cards, runs });

/** Forget every card and run: a team switch or a sign-out must not leave the previous scope searchable. */
export function clearPalette(): void {
  gen += 1;
  cards = [];
  runs = [];
}

/** Read the team's cards and runs (`list_tasks_all`, `list_runs_all`) once and publish what answered; a failed read keeps what is there. */
export async function loadPalette(teamId?: string): Promise<void> {
  const at = gen;
  const [t, r] = await Promise.allSettled([listTasksAll(teamId), listRunsAll(teamId)]);
  if (at !== gen) return;
  if (t.status === 'fulfilled') cards = t.value.tasks.map((c) => ({ id: c.id, title: c.title, repoPath: c.repoPath }));
  if (r.status === 'fulfilled') runs = r.value.runs;
}
