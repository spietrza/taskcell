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

/** The id the Board shows for a run's card: `gh-904` for `gh-owner-repo-904`; any other task id (hub-4) as it is. */
export const cardIdOf = (taskId: string): string => (issueNumber(taskId) !== undefined ? taskRefKey(taskId) : taskId);

/** Key of a board card for a run: the repository plus the folded task id (see taskRefKey). */
export const titleKey = (repoPath: string | undefined, taskId: string): string => `${repoPath ?? ''}|${taskRefKey(taskId)}`;

const nameWords = (name: string): string[] => name.split(/[^A-Za-z0-9]+/).filter(Boolean);

/**
 * Two letters for a repository's avatar (`taskcell-demo-form` -> `TD`). With `siblings` (the names shown beside it), the
 * leading words they all share are skipped, so `taskcell-demo-form` and `taskcell-demo-local` read `FO` and `LO`, not both `TD`.
 */
export function repoInitials(name: string | undefined, siblings: readonly string[] = []): string {
  let words = nameWords(name ?? '?');
  const others = siblings.filter((s) => s !== name).map(nameWords);
  if (others.length > 0) {
    let shared = 0;
    while (shared < words.length - 1 && others.every((o) => o[shared]?.toLowerCase() === words[shared]!.toLowerCase())) shared += 1;
    words = words.slice(shared);
  }
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
}

/** The words for a card or run whose agent stopped to ask: it is the person's turn. */
export const ASKED_WORDS = 'Waiting for your answer';
/** Needs-you styling (the one orange thing): a card or run waiting on the person. */
export const NEEDS_YOU_CHIP = 'rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary-text';

/** A finished run's state word, one source for the Runs row and the run header: the hub's `prState` decides merged. */
export function runStateWord(r: { anyFailed: boolean; stoppedBy?: string; prState?: string; prUrl?: string; verifyFailed?: true; cardDone?: true; asked?: string }): string {
  if (r.stoppedBy !== undefined) return 'stopped: provider limit';
  if (r.asked !== undefined) return ASKED_WORDS;
  if (r.anyFailed || r.verifyFailed === true) return 'failed';
  return r.prState === 'merged' ? 'merged' : r.prUrl !== undefined ? 'PR open' : r.cardDone === true ? 'done, no PR' : 'passed';
}

/** The chip colour of a state word: the colour always follows the word, never a second reading of the run. */
export function runStateTone(word: string): 'success' | 'destructive' | 'secondary' | 'primary' {
  if (word === 'failed') return 'destructive';
  if (word === ASKED_WORDS) return 'primary';
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
