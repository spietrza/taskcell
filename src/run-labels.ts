// Run labels: the hub derives a run's state word (src/hub/card-view.ts); the clients share the words (copied to
// packages/hub-client/src by `pnpm gen:wire`; pure: no DOM, Tauri or Node).

/** The words for a card or run whose agent stopped to ask: it is the person's turn. */
export const ASKED_WORDS = 'Waiting for your answer';

/** A finished run's state word, one source for the Runs row and the run header: the hub's `prState` decides merged. */
export function runStateWord(r: { anyFailed: boolean; stoppedBy?: string; prState?: string; prUrl?: string; verifyFailed?: true; cardDone?: true; asked?: string }): string {
  if (r.stoppedBy !== undefined) return 'stopped: provider limit';
  // Once its card is done the run waits on no answer: neutral history, as the card panel says it.
  if (r.asked !== undefined) return r.cardDone === true ? 'stopped to ask' : ASKED_WORDS;
  if (r.anyFailed || r.verifyFailed === true) return 'failed';
  return r.prState === 'merged' ? 'merged' : r.prUrl !== undefined ? 'PR open' : r.cardDone === true ? 'done, no PR' : 'passed';
}
