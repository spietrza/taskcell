import { TaskcellError } from '../core/errors.js';
import { hasLabel, NEEDS_REVISION_LABEL } from '../core/labels.js';
import { workflowPaths } from '../core/taskcell.js';
import type { GhRunner } from '../tasks/github.js';
import { assertShadowSafeGhArgs, parseApiCall } from './publish.js';
import { dedicatedReviewers } from './facts.js';
import type { ApproverFacts, ApproverPolicy, Decision, PrFacts } from './types.js';

const SHA_RE = /^[0-9a-f]{7,64}$/;

/** Open PRs as `rebaseDependents` lists them: fixed fields, bounded. */
export const OPEN_PRS_FIELDS = 'number,headRefName,isCrossRepository,author';
/** Reads for the merge order: one issue, and its native blocked-by relations. */
const DEPENDENCY_READ_RE = /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+(?:\/dependencies\/blocked_by)?$/;
/** A dependent PR's timeline, read for when its revise label was applied. */
const TIMELINE_READ_RE = /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/timeline$/;
/** An endpoint with no `.` or `..` path segment. */
const noDotSegments = (endpoint: string): boolean => !endpoint.split('/').some((part) => /^\.+$/.test(part));

/**
 * Act mode's gh allow-list: everything shadow mode may do, plus three writes — merge the base into the
 * head (update-branch: never a rebase), a squash merge pinned to the head the decision was made on, and
 * adding or removing the revise label (a dependent PR that conflicts after its dependency merged) — and
 * the reads the merge order needs (an issue, its blocked-by relations, the open PR list, a dependent's timeline). It never marks
 * a draft ready. All use the permissions the approver job already has.
 */
export function assertActSafeGhArgs(args: string[]): void {
  const [cmd, sub, num, repoFlag, , flag, value, extra] = args;
  if (cmd === 'pr' && /^\d+$/.test(num ?? '') && repoFlag === '--repo') {
    if (args.length === 5 && sub === 'update-branch') return;
    if (args.length === 7 && sub === 'edit' && (flag === '--add-label' || flag === '--remove-label') && value === NEEDS_REVISION_LABEL) return;
    if (sub === 'merge' && args.length === 8 && flag === '--squash' && value === '--match-head-commit' && SHA_RE.test(extra ?? '')) return;
  }
  if (cmd === 'pr' && sub === 'list' && args.length === 10 && num === '--repo' && args[4] === '--state' && flag === 'open' && value === '--limit' && /^\d{1,3}$/.test(extra ?? '') && args[8] === '--json' && args[9] === OPEN_PRS_FIELDS) return;
  if (cmd === 'api' && (args.length === 2 || (args.length === 3 && args[2] === '--paginate'))) {
    const { method, endpoints } = parseApiCall(args);
    const endpoint = endpoints[0] ?? '';
    if (method === 'GET' && endpoints.length === 1 && DEPENDENCY_READ_RE.test(endpoint) && noDotSegments(endpoint)) return;
  }
  if (cmd === 'api' && args.length === 4 && args[2] === '--paginate' && args[3] === '--slurp' && TIMELINE_READ_RE.test(sub ?? '') && noDotSegments(sub ?? '')) return;
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

/** A reason as it is safe to put in a bot comment: no HTML, markdown links or images, bare URLs, mentions, issue links, `.github/` path prefixes or newlines; capped. `\` is escaped too, or one in the input would cancel the escape added after it. */
export function escapeForComment(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  return flat
    .replace(/[<>&`|]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '`': "'", '|': '/' })[c]!)
    .replace(/[\\[\]()!]/g, (c) => `\\${c}`)
    .replace(/:\/\//g, ':\u200b//')
    .replace(/\bwww\./gi, 'www\u200b.')
    .replace(/@/g, '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .replace(/(^|[\s(])(\.(?:github|gitlab))\//g, '$1$2\u200b/');
}

/** Act mode's reason (stable code `no-dedicated-reviewer`) when the policy names no reviewer login other than `github-actions`. */
export const NO_DEDICATED_REVIEWER =
  'the policy lists no dedicated reviewer login in reviewAuthors (a GitHub App login other than github-actions); act mode acts on nothing';

/**
 * Why act mode must leave this PR to a human, beyond `decide()`: a draft (never promoted — a draft can be a hold),
 * a human hold (a CHANGES_REQUESTED review or the hold label), a PR not opened by a factory login, a release PR,
 * CI config, and any mergeStateStatus other than CLEAN/BEHIND (BLOCKED, UNSTABLE, UNKNOWN, DIRTY, absent).
 * `mergeState: false` leaves the last one out: the gates a dependent PR must pass before it is updated or sent to revise.
 */
export function hardExclusions(facts: ApproverFacts, policy: ApproverPolicy, reviews: PrFacts['reviews'], opts: { mergeState?: boolean } = {}): string[] {
  const reasons: string[] = [];
  if (facts.pr.isDraft) reasons.push('draft PR (act mode never marks a draft ready)');
  if (holdsChanges(reviews)) reasons.push('a review requests changes');
  if (policy.requiredChecks.length === 0) reasons.push('the policy lists no required checks (act mode acts on nothing)');
  // defence in depth: approve.ts returns earlier on the same condition
  if (dedicatedReviewers(policy).length === 0) reasons.push(NO_DEDICATED_REVIEWER);
  const holdLabel = policy.holdLabel ?? 'taskcell:hold';
  if (hasLabel(facts.pr.labels ?? [], holdLabel)) reasons.push(`hold label ${holdLabel}`);
  const author = facts.pr.author ?? '';
  if (author === '' || !(policy.factoryAuthors ?? []).includes(author)) reasons.push(`not opened by the factory (author "${author}")`);
  if (isReleasePr(facts.pr)) reasons.push('release PR');
  const state = facts.pr.mergeStateStatus ?? 'UNKNOWN';
  if (opts.mergeState === false) {
    // a dependent PR: its merge state is what is being fixed
  } else if (state === 'DIRTY') reasons.push('merge conflict');
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
