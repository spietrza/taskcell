import { isTrustedNonAuthorComment } from '../tasks/comment-trust.js';
import { assessTaskReadiness, isTaskcellSpec, SPEC_TAG } from '../tasks/triage.js';
import { formatFailureComment } from '../core/errors.js';
import { UsageCapError, usageCapMessage } from '../core/usage-cap.js';
import type { Task } from '../tasks/fetcher.js';
import type { RunSpecGeneratorDeps } from './spec.js';

/** Injectable spec generator (the real one boots a sandbox; tests inject a fake). */
export type GenerateSpec = (id: string, deps: RunSpecGeneratorDeps) => Promise<string>;

/** Clarification comment posted when triage flags a ticket as too vague to proceed. The hub's inbox reads it back (src/hub/needs-you.ts) to tell "too vague" from a question. */
export function clarifyMessage(mode: 'spec' | 'agent'): string {
  return mode === 'spec'
    ? 'Taskcell could not start: this ticket is too vague to spec. Add a clear description (what and why) and re-trigger.'
    : 'Taskcell could not start: this ticket lacks acceptance criteria or a spec. Add testable acceptance criteria (or a spec comment) and re-trigger.';
}

/**
 * Wrap a generated spec so the agent pass and triage recognise it as a spec comment. White-label
 * drops the "Taskcell" heading (a client repo must not carry automation branding); recognition is
 * keyed on the <tech_spec> tag, so triage/idempotency/conformance behave identically in both modes.
 */
export function specComment(spec: string, opts?: { whiteLabel?: boolean }): string {
  const heading = opts?.whiteLabel === true ? 'Tech spec:' : 'Taskcell tech spec:';
  return `${heading}\n\n<${SPEC_TAG}>\n${spec}\n</${SPEC_TAG}>`;
}

/** Comment posted when a genuine no-change outcome un-sticks the claimed marker. */
export const NO_CHANGE_MSG =
  'Taskcell run produced no changes — no PR was opened. Cleared `taskcell:running`; re-apply the trigger label to retry. See the run log.';

/**
 * Comment posted when the secret scan withheld the PR: what the watch did with the claim and the
 * exact step that releases the hold on THIS source (the configured trigger label / status / state).
 * The adapter's masked-findings comment carries no procedure — it also serves one-shot runs.
 */
export function holdMessage(claimNote: string, resume: string): string {
  return `Taskcell held this issue: the outgoing secret scan withheld the PR. ${claimNote} To retry once the secret is out of the change, ${resume}.`;
}

/** Post the no-change comment and (optionally) revert the claim — independent I/O, run concurrently. */
export async function commentAndRevert(comment: Promise<void>, revert?: Promise<void>): Promise<void> {
  await Promise.all(revert === undefined ? [comment] : [comment, revert]);
}

/**
 * Outcome of one issue run as the watch loop sees it. No `prUrl` has three meanings, and only the
 * first is a genuine no-change: the agent ran and the diff was empty (`onNoChange` un-sticks the
 * claim); `parked` — the agent never ran, triage already routed the ticket elsewhere (needs-info);
 * `secretBlocked` — the diff was withheld by the outgoing secret scan and the adapter already
 * labelled/commented the issue. The last must NOT revert the claim: sources that revert to the
 * trigger state (Linear, GitHub Projects) would re-list the issue next poll, re-run it, re-hit the
 * secret and re-post the block comment forever.
 */
export interface WatchRunOutcome {
  prUrl?: string;
  parked?: boolean;
  secretBlocked?: boolean;
  /** The base branch was already red and the adapter commented. Not a no-change: never revert the claim to the trigger. */
  baseRed?: boolean;
}

export interface WatchPrimitives {
  /** List issues currently ready to run (trigger state + label). */
  listReady: () => Promise<Array<{ id: string }>>;
  /** Claim an issue so a later poll won't pick it again (e.g. move it out of the trigger state). */
  claim: (id: string) => Promise<void>;
  /** See WatchRunOutcome: only a genuine no-change (no PR, not parked, not secret-blocked) triggers `onNoChange`. */
  runOne: (id: string) => Promise<WatchRunOutcome>;
  /** Mark an issue as in review (a PR opened). */
  review: (id: string) => Promise<void>;
  /** No PR AND not parked: undo the claim so the issue is not stuck on the claimed marker. */
  onNoChange: (id: string) => Promise<void>;
  /**
   * The secret scan withheld the PR. Mark the hold WITHOUT restoring the trigger (a revert would
   * re-list the issue next poll) and tell the human how to release it: label sources swap the
   * claimed label for the secret-blocked label; state sources keep the claimed state. Every real
   * source supplies it; absent (test doubles) the issue simply stays claimed. A rejection routes to
   * onFailure and the claim stays.
   */
  onSecretBlocked?: (id: string) => Promise<void>;
  /**
   * The base branch was red, the adapter already posted why. Release the claim WITHOUT restoring the
   * trigger (a revert would re-run the full verify every poll). Absent: the issue stays claimed, which
   * is what state sources (Linear, GitHub Projects) want.
   */
  onBaseRed?: (id: string) => Promise<void>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

export interface SpecWatchPrimitives {
  listReady: () => Promise<Array<{ id: string }>>;
  claim: (id: string) => Promise<void>;
  /**
   * Triage + (spec-gen+comment+advance) or (clarify+needs-info). Returns the outcome.
   * At-least-once: the spec comment may be posted more than once if the advance step fails, but the
   * isSpecComment guard skips regeneration on retry so a re-run is cheap and posts no duplicate spec.
   */
  runSpec: (id: string) => Promise<'advanced' | 'needs_info'>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

/** Actions injected per-source into runSpecCore. */
export interface RunSpecCoreActions {
  postComment: (body: string) => Promise<void>;
  advance: () => Promise<void>;
  toNeedsInfo: () => Promise<void>;
}

/**
 * Shared 3-branch spec-run logic used by both Linear and GitHub spec primitives.
 *
 * Branch (a) idempotent retry — already Taskcell-specced: advance without regenerating.
 * Branch (b) triage says needs_info: post clarification comment then move to needs-info.
 * Branch (c) normal path: generate spec, post it, then advance.
 *
 * Call order is preserved: postComment BEFORE advance/toNeedsInfo.
 */
export async function runSpecCore(
  task: Task,
  id: string,
  deps: RunSpecGeneratorDeps,
  generate: GenerateSpec,
  actions: RunSpecCoreActions,
): Promise<'advanced' | 'needs_info'> {
  // (a) Idempotent retry: if a Taskcell-generated spec is already posted skip regeneration and just
  // advance — cheap, no duplicate spec comment / wasted sandbox+LLM. Issue-author trust is excluded
  // here: the reporter must not be able to skip spec generation with a forged <tech_spec>.
  if (task.comments.some((c) => isTrustedNonAuthorComment(c, { allowedAuthors: deps.feedbackAuthors }) && isTaskcellSpec(c))) {
    await actions.advance();
    return 'advanced';
  }

  // (b) Triage gate: description too vague to spec.
  if (assessTaskReadiness(task, 'spec') === 'needs_info') {
    await actions.postComment(clarifyMessage('spec'));
    await actions.toNeedsInfo();
    return 'needs_info';
  }

  // (c) Normal path: generate, post, advance.
  const spec = await generate(id, deps);
  await actions.postComment(specComment(spec));
  await actions.advance();
  return 'advanced';
}

/**
 * Shared agent-pass triage gate used by both Linear and GitHub issue watch primitives.
 *
 * When the needs-info option is set: fetch the task, run assessTaskReadiness in 'agent' mode,
 * and if vague post the clarification comment and move to needs-info (returns { parked: true } so
 * watchOnce counts this as noChange but skips onNoChange — the ticket is already correctly routed,
 * no implement budget spent). Otherwise delegate to the real runner.
 *
 * When the needs-info option is absent: delegate directly without fetching (behaviour unchanged).
 */
export async function triageAgentRun(
  id: string,
  fetcher: { fetch: (id: string) => Promise<Task> },
  runner: (id: string) => Promise<WatchRunOutcome>,
  action: {
    comment: (body: string) => Promise<void>;
    toNeedsInfo: () => Promise<void>;
  },
  allowedAuthors?: readonly string[],
): Promise<WatchRunOutcome> {
  const task = await fetcher.fetch(id);
  if (assessTaskReadiness(task, 'agent', { allowedAuthors }) === 'needs_info') {
    await action.comment(clarifyMessage('agent'));
    await action.toNeedsInfo();
    return { parked: true }; // no PR, already routed -> watchOnce skips onNoChange
  }
  return runner(id);
}

/**
 * Failure comment for a source without the `taskcell:rate-limited` hold (Linear, GitLab, Projects): a
 * usage-cap pause is worded as the configured reserve, not a failure, and names when to re-trigger.
 */
export function failureOrCapComment(title: string, error: unknown): string {
  if (!(error instanceof UsageCapError)) return formatFailureComment(title, error);
  return `Taskcell ${usageCapMessage(error.pct, error.cap, error.until)} (\`TASKCELL_USAGE_CAP_PCT\`). This is the configured reserve, not a failure and not a problem with this task; re-trigger it once ${error.until.toISOString()} has passed.`;
}
