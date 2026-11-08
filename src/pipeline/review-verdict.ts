/**
 * The persisted reading of one reviewer/conformance reply: the merge gate's verdict plus the
 * `<findings>` block, so the record, the PR body and the Task Board chip can all read the SAME
 * decision instead of re-deriving it.
 */
import { hasBlockingFinding } from '../runners/review-prompt.js';
import { extractFindings } from '../structured/findings.js';
import type { Finding, ReviewVerdict } from '../wire.js';

export interface ReviewVerdictSummary {
  verdict: ReviewVerdict;
  findings: Finding[];
}

// The reviewer/conformance prompt (pipeline.ts) requires this exact line, on its own, when there is
// no blocking finding. Anything else — an empty reply, an aborted one, "Review unavailable: …" — is
// not a stated pass, so it must not read as one (#665: such a reply was recorded as `pass`).
const NO_BLOCKING_ISSUES_RE = /^No blocking issues\.$/m;

/**
 * The persisted reading of one review reply. `changes` iff `hasBlockingFinding()` — the SAME
 * predicate `publishReviewVerdict` gates `request-changes` on, so a chip can never disagree with
 * what the bot actually did to the PR. Otherwise `pass` iff the reply states the exact "No blocking
 * issues." line; a reply that neither blocks nor states that line (empty, aborted, "Review
 * unavailable: …") is `incomplete`, not a silent pass. The stated `Verdict:` line is NOT used: nothing
 * gates on it today (see verdictContradictsFindings) and a self-contradicting reply must read as the
 * gate read it. `findings` is `[]` when no parseable `<findings>` block is present.
 */
export function reviewVerdictOf(text: string): ReviewVerdictSummary {
  const verdict: ReviewVerdict = hasBlockingFinding(text) ? 'changes' : NO_BLOCKING_ISSUES_RE.test(text) ? 'pass' : 'incomplete';
  let findings: Finding[];
  try {
    findings = extractFindings(text).findings;
  } catch {
    findings = [];
  }
  return { verdict, findings };
}

/** `Review: PASS (0 findings)` / `Review: CHANGES (3 findings)` / `Review: INCOMPLETE (0 findings)` — the PR-body one-liner. */
export function reviewVerdictLine(summary: ReviewVerdictSummary): string {
  const n = summary.findings.length;
  const label = summary.verdict.toUpperCase();
  return `Review: ${label} (${n} finding${n === 1 ? '' : 's'})`;
}
