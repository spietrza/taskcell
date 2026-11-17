import { taskRefKey } from './features/board/taskref';

/** Who started a run, when that is a person: the hub's shared `token` identity and the local worker are not, so they show nothing. */
export function startedByLabel(startedBy: string | undefined): string | undefined {
  return startedBy === 'token' || startedBy === 'local-worker' ? undefined : startedBy;
}

/** The issue number a run's task id ends in (`gh-owner-repo-904` -> 904); undefined for a task id without one. */
export function issueNumber(taskId: string): number | undefined {
  const m = /^(?:gh|gl)-(\d+)$/.exec(taskRefKey(taskId));
  return m ? Number(m[1]) : undefined;
}

/** Key of a board card for a run: the repository plus the folded task id (see taskRefKey). */
export const titleKey = (repoPath: string | undefined, taskId: string): string => `${repoPath ?? ''}|${taskRefKey(taskId)}`;

/** Two letters for a repository's avatar (`taskcell-demo-form` -> `TD`). */
export function repoInitials(name: string | undefined): string {
  const words = (name ?? '?').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
}

/** A finished run's state word, one source for the Runs row and the run header: the hub's `prState` decides merged. */
export function runStateWord(r: { anyFailed: boolean; stoppedBy?: string; prState?: string; prUrl?: string }): string {
  if (r.stoppedBy !== undefined) return 'stopped: provider limit';
  if (r.anyFailed) return 'failed';
  return r.prState === 'merged' ? 'merged' : r.prUrl !== undefined ? 'PR open' : 'passed';
}
