import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { loadPolicy, POLICY_HASH_NONE } from './policy.js';
import { collectPrFacts, collectCheckFacts, collectReviewFacts, isFactoryPr } from './facts.js';
import { collectDiffFacts, emptyDiffFacts } from './diff-facts.js';
import { readLedger } from './ledger.js';
import { decide } from './rules.js';
import { buildDecisionRecord, appendDecision, appendAction } from './record.js';
import type { ActionKind } from './record.js';
import { publishCheckRun, commentDecision, commentOnce, shadowSafeGhRunner } from './publish.js';
import { actSafeGhRunner, actExclusions, reviewExact } from './act.js';
import { TaskcellError } from '../core/errors.js';
import type { ApproverFacts, Decision, DecisionRecord } from './types.js';
import { readEnv } from '../core/env.js';

export interface RunApproverInput {
  repoPath: string;
  repoSlug: string;
  prNumber: number;
  /** `act` only takes effect when `.taskcell/approver.json` on the base branch also sets `act: true`; otherwise shadow. */
  mode: 'shadow' | 'act';
  gh?: GhRunner;
  branch?: string;
  now?: Date;
  /** Compute and print the decision but publish/record nothing (the day-one backtest + local inspection). */
  dryRun?: boolean;
  /** Test seam: the wait between polls of the updated head's checks. */
  sleep?: (ms: number) => Promise<void>;
}

/** Act mode polls the updated head's checks every 30 s for 30 min — inside the workflow's 45 min timeout, and only one update per run. */
const POLL_MS = 30_000;
const POLL_ATTEMPTS = 60;

export interface RunApproverResult {
  record: DecisionRecord;
}

/**
 * Orchestration: level-triggered, idempotent per (PR, head SHA). Every step re-fetches from the API;
 * no in-process locking (the caller's workflow concurrency group serializes a PR). Exit is always
 * "a decision was computed and recorded", including ESCALATE — only an operational failure throws.
 */
export async function runApprover(input: RunApproverInput, state: { updated: boolean } = { updated: false }): Promise<RunApproverResult> {
  const rawGh = input.gh ?? defaultGhRunner;
  const gh = shadowSafeGhRunner(rawGh);
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();

  let acting = false;
  const finish = async (facts: ApproverFacts | undefined, decision: Decision, policyHash: string, publishHeadSha: string): Promise<RunApproverResult> => {
    const record = buildDecisionRecord({ mode: acting ? 'act' : 'shadow', repo: input.repoSlug, prNumber: input.prNumber, headSha: publishHeadSha, facts, decision, policyHash, timestamp });
    if (input.dryRun) return { record };
    // Publish first, record last, and run every step even when one fails: a failed record append must not
    // hide the check run, and no failure is swallowed — they are reported together once all three ran.
    const failures: string[] = [];
    const attempt = async (step: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        failures.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await attempt('check run', () => publishCheckRun(gh, input.repoSlug, publishHeadSha, input.prNumber, decision, record, acting));
    // In act mode the decision is in the check run and the log; a comment is posted only when a human has to act.
    if (!acting) await attempt('comment', () => commentDecision(gh, input.repoSlug, input.prNumber, decision, record));
    await attempt('decision record', () => appendDecision(input.repoPath, record, input.branch !== undefined ? { branch: input.branch } : {}));
    if (failures.length > 0) {
      throw new TaskcellError(`approver: ${decision.verdict} for #${input.prNumber} was decided, but ${failures.join('; ')}`);
    }
    return { record };
  };

  const prFacts = await collectPrFacts(gh, input.repoSlug, input.prNumber);
  const base = prFacts.baseRefName !== '' ? prFacts.baseRefName : 'main';
  const loaded = await loadPolicy(input.repoPath, base);
  if (loaded === undefined) {
    const decision: Decision = { verdict: 'ESCALATE', rulesFired: ['policy-unreadable'], auditSample: { p: 0, seed: '', hit: false }, reviewValid: false };
    return finish(undefined, decision, POLICY_HASH_NONE, prFacts.headSha);
  }
  const { policy, policyHash } = loaded;
  const seed = `${input.repoSlug}:${input.prNumber}:${prFacts.headSha}:${policyHash}`;

  const stopped = policy.enabled === false || (readEnv('TASKCELL_APPROVER_STOP') ?? '') !== '';
  if (stopped) {
    // Kill switch short-circuits before any diff/ledger collection (no head fetch, no merge-tree).
    const { reviews: _reviews, ...prWithoutReviews } = prFacts;
    const stoppedFacts: ApproverFacts = {
      pr: prWithoutReviews,
      isFactoryPr: false,
      checks: [],
      review: { verdict: null, sha: null, author: null },
      ledger: {},
      thisPrLines: 0,
      diff: emptyDiffFacts(prFacts.headSha),
    };
    const decision = decide(stoppedFacts, policy, seed);
    return finish(undefined, decision, policyHash, prFacts.headSha);
  }

  acting = input.mode === 'act' && policy.act === true && input.dryRun !== true;
  const actGh = actSafeGhRunner(rawGh);
  const logAction = (action: ActionKind, reason: string, headSha: string): Promise<void> =>
    appendAction(input.repoPath, { schemaVersion: 1, kind: 'action', mode: 'act', repo: input.repoSlug, prNumber: input.prNumber, headSha, action, reason, timestamp }, input.branch !== undefined ? { branch: input.branch } : {});
  const tell = async (action: ActionKind, reason: string, headSha: string): Promise<void> => {
    const marker = `<!-- taskcell-approver-act: ${headSha}:${action} -->`;
    await commentOnce(actGh, input.repoSlug, input.prNumber, marker, `## Taskcell Approver (act mode)\n\nLeft for a human: ${reason}.\n\n${marker}`);
    await logAction(action, reason, headSha);
  };

  const { reviews: _reviews, ...prWithoutReviews } = prFacts;
  const factory = isFactoryPr(prFacts, input.repoSlug, policy);
  const checks = await collectCheckFacts(gh, input.repoSlug, prFacts.headSha, policy);
  const review = collectReviewFacts(prFacts, policy);
  const diff = await collectDiffFacts({
    repoPath: input.repoPath,
    prNumber: input.prNumber,
    baseRefName: base,
    apiHeadSha: prFacts.headSha,
    reviewedSha: review.sha,
    policy,
  });
  const ledger = await readLedger({
    repoPath: input.repoPath,
    policy,
    now,
    prNumber: input.prNumber,
    touchedPaths: diff.paths,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  });

  const facts: ApproverFacts = { pr: prWithoutReviews, isFactoryPr: factory, checks, review, diff, ledger, thisPrLines: diff.lines };
  const decision = decide(facts, policy, seed);

  const result = await finish(facts, decision, policyHash, diff.headSha);
  if (!acting || facts.pr.state !== 'OPEN') return result;

  const excluded = actExclusions(facts, decision, policy, prFacts.reviews);
  if (excluded.length > 0) {
    await tell('left-for-human', excluded.join('; '), diff.headSha);
    return result;
  }

  // The base moved when the PR is behind per GitHub (strict branch protection) or the merge-base is not the base tip.
  const behind = prFacts.mergeStateStatus === 'BEHIND' || (diff.mergeBase !== '' && diff.baseSha !== '' && diff.mergeBase !== diff.baseSha);
  if (behind) {
    if (state.updated) {
      await tell('base-moved', 'the base branch moved again after an update', diff.headSha);
      return result;
    }
    // Merge of the base into the head only (never a rebase or force-push).
    await actGh(['pr', 'update-branch', String(input.prNumber), '--repo', input.repoSlug]);
    await logAction('update-branch', 'base branch moved; merged it into the head', diff.headSha);
    const sleep = input.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const current = await collectPrFacts(gh, input.repoSlug, input.prNumber);
      if (current.headSha !== '' && current.headSha !== diff.headSha) {
        const fresh = await collectCheckFacts(gh, input.repoSlug, current.headSha, policy);
        const failed = fresh.filter((c) => c.conclusion !== null && c.conclusion !== 'success');
        if (failed.length > 0) {
          await tell('checks-failed', `checks failed on the updated head (${failed.map((c) => c.name).join(', ')})`, current.headSha);
          return result;
        }
        if (fresh.every((c) => c.conclusion === 'success')) {
          // Decide again on the new head: a head that changed beyond the base merge needs a new review first.
          return runApprover(input, { updated: true });
        }
      }
      await sleep(POLL_MS);
    }
    await tell('checks-failed', 'timed out waiting for the checks on the updated head (a push made with the workflow token does not start CI; re-run the checks or push with a token that does)', diff.headSha);
    return result;
  }

  if (!reviewExact(facts)) {
    await tell('left-for-human', 'review-stale: the head tree is not the reviewed commit merged with the base; a new review is needed', diff.headSha);
    return result;
  }
  // The decision a merge is made on is always on the log before the merge, even when this head already has a record.
  await appendDecision(input.repoPath, { ...result.record, actMerge: true }, input.branch !== undefined ? { branch: input.branch } : {});
  try {
    await actGh(['pr', 'merge', String(input.prNumber), '--repo', input.repoSlug, '--squash', '--match-head-commit', diff.headSha]);
  } catch (err) {
    await tell('merge-failed', `the merge was rejected: ${err instanceof Error ? err.message : String(err)}`, diff.headSha);
    throw err;
  }
  await logAction('merge', 'reviewed, checks green, decision APPROVE; squash-merged', diff.headSha);
  return result;
}
