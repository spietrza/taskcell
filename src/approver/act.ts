import { TaskcellError } from '../core/errors.js';
import { workflowPaths } from '../core/taskcell.js';
import type { GhRunner } from '../tasks/github.js';
import { assertShadowSafeGhArgs } from './publish.js';
import type { ApproverFacts, Decision, PrFacts } from './types.js';

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Act mode's gh allow-list: everything shadow mode may do, plus exactly three writes — mark ready,
 * merge the base into the head (update-branch: never a rebase), and a squash merge pinned to the head
 * the decision was made on. All use the permissions the approver job already has.
 */
export function assertActSafeGhArgs(args: string[]): void {
  const [cmd, sub, num, repoFlag, , flag, value, extra] = args;
  if (cmd === 'pr' && /^\d+$/.test(num ?? '') && repoFlag === '--repo') {
    if (args.length === 5 && (sub === 'ready' || sub === 'update-branch')) return;
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

/** Exclusions `decide()` does not already express (it covers non-factory, git conflicts, protected paths, state): release PRs and CI config. */
export function hardExclusions(facts: ApproverFacts): string[] {
  const reasons: string[] = [];
  if (isReleasePr(facts.pr)) reasons.push('release PR');
  if (facts.pr.mergeStateStatus === 'DIRTY') reasons.push('merge conflict');
  const ci = workflowPaths(facts.diff.paths);
  if (ci.length > 0) reasons.push(`touches CI config (${ci.join(', ')})`);
  return reasons;
}

/** Why act mode must leave this PR to a human. Empty = it may act. */
export function actExclusions(facts: ApproverFacts, decision: Decision): string[] {
  const reasons = hardExclusions(facts);
  if (decision.verdict !== 'APPROVE') reasons.push(`decision is ${decision.verdict} (${decision.rulesFired.join(', ') || 'no rules'})`);
  return reasons;
}
