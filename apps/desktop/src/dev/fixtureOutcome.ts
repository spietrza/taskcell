import type { RunSummary } from '../wire';
import { ASKED_WORDS } from '../runLabels';

// The hub derives these (src/hub/card-view.ts); the fixtures (demo mode and the tests) state them in short form so the screens render without a hub.
export const fixtureOutcome = (r: RunSummary): NonNullable<RunSummary['outcome']> =>
  r.prState === 'merged' ? { state: 'merged', place: { at: 6, failed: false } }
  : r.stoppedBy !== undefined ? { state: 'stopped: provider limit', place: { at: 2, failed: false } }
  : r.asked !== undefined ? { state: ASKED_WORDS, place: { at: 2, failed: false, ...(r.verifyPassed === true ? { passed: [3] } : {}) } }
  : r.anyFailed || r.verifyFailed === true ? { state: 'failed', place: { at: r.verifyFailed === true ? 3 : 2, failed: true } }
  : { state: r.prUrl !== undefined ? 'PR open' : 'passed', place: { at: 5, failed: false } };
export const withOutcome = <T extends RunSummary>(r: T): T => ({ ...r, outcome: fixtureOutcome(r) });
/** A test's loose run literal, read as a RunSummary with its outcome. */
export const withOutcomeLoose = (r: unknown): RunSummary => withOutcome(r as RunSummary);
