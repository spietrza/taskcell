import { taskRefKey } from './features/board/taskref';

/** Who started a run, in plain words: the hub's shared `token` identity and the local worker are not names. */
export function startedByLabel(startedBy: string | undefined): string | undefined {
  if (startedBy === 'token') return 'Hub';
  if (startedBy === 'local-worker') return 'Local worker';
  return startedBy;
}

/** The issue number a run's task id ends in (`gh-owner-repo-904` -> 904); undefined for a task id without one. */
export function issueNumber(taskId: string): number | undefined {
  const m = /^(?:gh|gl)-(\d+)$/.exec(taskRefKey(taskId));
  return m ? Number(m[1]) : undefined;
}

/** The id the Board shows for a run's card: `gh-904` for `gh-owner-repo-904`; any other task id (hub-4) as it is. */
export const cardIdOf = (taskId: string): string => (issueNumber(taskId) !== undefined ? taskRefKey(taskId) : taskId);

/** Key of a board card for a run: the repository plus the folded task id (see taskRefKey). */
export const titleKey = (repoPath: string | undefined, taskId: string): string => `${repoPath ?? ''}|${taskRefKey(taskId)}`;

/** Two letters for a repository's avatar (`taskcell-demo-form` -> `TD`). */
export function repoInitials(name: string | undefined): string {
  const words = (name ?? '?').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
}

/** A finished run's state word, one source for the Runs row and the run header: the hub's `prState` decides merged. */
export function runStateWord(r: { anyFailed: boolean; stoppedBy?: string; prState?: string; prUrl?: string; verifyFailed?: true; cardDone?: true; asked?: string }): string {
  if (r.stoppedBy !== undefined) return 'stopped: provider limit';
  if (r.asked !== undefined) return 'asks you';
  if (r.anyFailed || r.verifyFailed === true) return 'failed';
  return r.prState === 'merged' ? 'merged' : r.prUrl !== undefined ? 'PR open' : r.cardDone === true ? 'done, no PR' : 'passed';
}

/** The chip colour of a state word: the colour always follows the word, never a second reading of the run. */
export function runStateTone(word: string): 'success' | 'destructive' | 'warning' | 'secondary' | 'primary' {
  if (word === 'failed') return 'destructive';
  if (word === 'asks you') return 'warning';
  if (word === 'running') return 'primary';
  if (word === 'cancelled' || word.startsWith('stopped')) return 'secondary';
  return 'success';
}

/** What a run that stopped to ask says to the person: the summary's `asked`, else the implementer record's last reply. */
export function askedOf(
  summary: { asked?: string } | undefined,
  detail: { stages: { record: { stage?: string; exitReason?: string; stoppedBy?: string; finalText?: string } }[] } | undefined,
): string | undefined {
  if (summary?.asked !== undefined) return summary.asked;
  const r = detail?.stages.find((s) => s.record.stage === 'implementer' && s.record.exitReason === 'incomplete' && s.record.stoppedBy === undefined)?.record;
  return r?.finalText?.trim() || undefined;
}
