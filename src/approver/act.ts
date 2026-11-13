import { TaskcellError } from '../core/errors.js';
import { hasLabel } from '../core/labels.js';
import { workflowPaths } from '../core/taskcell.js';
import type { GhRunner } from '../tasks/github.js';
import { assertShadowSafeGhArgs } from './publish.js';
import type { ApproverFacts, ApproverPolicy, Decision, PrFacts } from './types.js';

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Act mode's gh allow-list: everything shadow mode may do, plus exactly two writes — merge the base
 * into the head (update-branch: never a rebase), and a squash merge pinned to the head the decision
 * was made on. It never marks a draft ready. All use the permissions the approver job already has.
 */
export function assertActSafeGhArgs(args: string[]): void {
  const [cmd, sub, num, repoFlag, , flag, value, extra] = args;
  if (cmd === 'pr' && /^\d+$/.test(num ?? '') && repoFlag === '--repo') {
    if (args.length === 5 && sub === 'update-branch') return;
    if (sub === 'merge' && args.length === 8 && flag === '--squash' && value === '--match-head-commit' && SHA_RE.test(extra ?? '')) return;
  }
  try {
    assertShadowSafeGhArgs(args);
  } catch {
    throw new TaskcellError(`act mode: refusing gh call "${args.join(' ')}"`);
  }
}

export function actSafeGhRunner(gh: GhRunner): GhRunner {
  return async (args: string[]): Promise<string> => {
    assertActSafeGhArgs(args);
    return gh(args);
  };
}

/** A release PR is never merged by the approver: the head branch or the title (incl. release-please's `chore(main): release x`) says release. */
export function isReleasePr(pr: Pick<PrFacts, 'headRefName' | 'title'>): boolean {
  return /(^|[/-])release([/-]|$)/i.test(pr.headRefName) || /^(chore(\([^)]*\))?:\s*)?release\b/i.test(pr.title ?? '');
}

/** mergeStateStatus values act mode proceeds on: CLEAN, or BEHIND (it updates first, and the re-decision then needs CLEAN). */
const ACTABLE_MERGE_STATES = new Set(['CLEAN', 'BEHIND']);

/** A change request holds until the same reviewer's later approval (or the review is dismissed): only each author's latest verdict-bearing review counts. */
export function holdsChanges(reviews: PrFacts['reviews']): boolean {
  const latest = new Map<string, { at: string; state: string }>();
  for (const r of reviews) {
    // A dismissed review no longer counts either way; an author we cannot name cannot be released by anyone's approval.
    if (r.state !== 'CHANGES_REQUESTED' && r.state !== 'APPROVED') continue;
    if (r.author === '') {
      if (r.state === 'CHANGES_REQUESTED') return true;
      continue;
    }
    const prev = latest.get(r.author);
    if (prev === undefined || r.submittedAt >= prev.at) latest.set(r.author, { at: r.submittedAt, state: r.state });
  }
  return [...latest.values()].some((v) => v.state === 'CHANGES_REQUESTED');
}

/** A reason as it is safe to put in a bot comment: no HTML, markdown links or images, bare URLs, mentions, issue links, `.github/` path prefixes or newlines; capped. */
export function escapeForComment(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  return flat
    .replace(/[<>&`|]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '`': "'", '|': '/' })[c]!)
    .replace(/[[\]()!]/g, (c) => `\\${c}`)
    .replace(/:\/\//g, ':\u200b//')
    .replace(/\bwww\./gi, 'www\u200b.')
    .replace(/@/g, '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .replace(/(^|[\s(])(\.(?:github|gitlab))\//g, '$1$2\u200b/');
}

/**
 * Why act mode must leave this PR to a human, beyond `decide()`: a draft (never promoted — a draft can be a hold),
 * a human hold (a CHANGES_REQUESTED review or the hold label), a PR not opened by a factory login, a release PR,
 * CI config, and any mergeStateStatus other than CLEAN/BEHIND (BLOCKED, UNSTABLE, UNKNOWN, DIRTY, absent).
 */
export function hardExclusions(facts: ApproverFacts, policy: ApproverPolicy, reviews: PrFacts['reviews']): string[] {
  const reasons: string[] = [];
  if (facts.pr.isDraft) reasons.push('draft PR (act mode never marks a draft ready)');
  if (holdsChanges(reviews)) reasons.push('a review requests changes');
  if (policy.requiredChecks.length === 0) reasons.push('the policy lists no required checks (act mode acts on nothing)');
  const holdLabel = policy.holdLabel ?? 'taskcell:hold';
  if (hasLabel(facts.pr.labels ?? [], holdLabel)) reasons.push(`hold label ${holdLabel}`);
  const author = facts.pr.author ?? '';
  if (author === '' || !(policy.factoryAuthors ?? []).includes(author)) reasons.push(`not opened by the factory (author "${author}")`);
  if (isReleasePr(facts.pr)) reasons.push('release PR');
  const state = facts.pr.mergeStateStatus ?? 'UNKNOWN';
  if (state === 'DIRTY') reasons.push('merge conflict');
  else if (!ACTABLE_MERGE_STATES.has(state)) reasons.push(`mergeStateStatus ${state}`);
  const ci = workflowPaths(facts.diff.paths);
  if (ci.length > 0) reasons.push(`touches CI config (${ci.join(', ')})`);
  return reasons;
}

/**
 * Act mode's review validity is exact (shadow keeps the patch-id rule): the head is the reviewed commit, or its
 * tree equals the tree of merging the base into the reviewed commit.
 */
export function reviewExact(facts: ApproverFacts): boolean {
  if (facts.review.sha === null) return false;
  if (facts.review.sha === facts.diff.headSha) return true;
  return facts.diff.headTree !== undefined && facts.diff.headTree === facts.diff.reviewedMergedTree;
}

/** Why act mode must leave this PR to a human. Empty = it may act. */
export function actExclusions(facts: ApproverFacts, decision: Decision, policy: ApproverPolicy, reviews: PrFacts['reviews']): string[] {
  const reasons = hardExclusions(facts, policy, reviews);
  if (decision.verdict !== 'APPROVE') reasons.push(`decision is ${decision.verdict} (${decision.rulesFired.join(', ') || 'no rules'})`);
  return reasons;
}
