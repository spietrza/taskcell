import { execa } from 'execa';
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { loadPolicy, POLICY_HASH_NONE } from './policy.js';
import { collectPrFacts, collectCheckFacts, collectReviewFacts, isFactoryPr } from './facts.js';
import { collectDiffFacts, emptyDiffFacts } from './diff-facts.js';
import { readLedger } from './ledger.js';
import { decide } from './rules.js';
import { buildDecisionRecord, appendDecision, appendAction, reasonKey } from './record.js';
import type { ActionKind } from './record.js';
import { publishCheckRun, commentDecision, commentOnce, shadowSafeGhRunner } from './publish.js';
import { actSafeGhRunner, actExclusions, reviewExact, escapeForComment } from './act.js';
import { redactForPublish } from '../core/secret-scan.js';
import { TaskcellError } from '../core/errors.js';
import type { ApproverFacts, Decision, DecisionRecord, PrFacts } from './types.js';

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
/** GitHub reports `UNKNOWN` while it computes mergeability; look again a few times before leaving the PR for a human. */
const UNKNOWN_RETRIES = 3;
const UNKNOWN_RETRY_MS = 5_000;

/** Error text as it may go into a comment or the log: tokens and injected secret values redacted. */
const errorText = (err: unknown): string => redactForPublish(err instanceof Error ? err.message : String(err));

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
  const branchOpts = input.branch !== undefined ? { branch: input.branch } : {};

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
        failures.push(`${step}: ${errorText(err)}`);
      }
    };
    await attempt('check run', () => publishCheckRun(gh, input.repoSlug, publishHeadSha, input.prNumber, decision, record, acting));
    // In act mode the decision is in the check run and the log; a comment is posted only when a human has to act.
    if (!acting) await attempt('comment', () => commentDecision(gh, input.repoSlug, input.prNumber, decision, record));
    await attempt('decision record', () => appendDecision(input.repoPath, record, branchOpts));
    if (failures.length > 0) {
      throw new TaskcellError(`approver: ${decision.verdict} for #${input.prNumber} was decided, but ${failures.join('; ')}`);
    }
    return { record };
  };

  const sleep = input.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  // Read the PR again; GitHub computes mergeStateStatus lazily, so UNKNOWN is retried a few times before it counts.
  const readPr = async (): Promise<PrFacts> => {
    let current = await collectPrFacts(gh, input.repoSlug, input.prNumber);
    for (let i = 0; i < UNKNOWN_RETRIES && current.mergeStateStatus === 'UNKNOWN'; i += 1) {
      await sleep(UNKNOWN_RETRY_MS);
      current = await collectPrFacts(gh, input.repoSlug, input.prNumber);
    }
    return current;
  };

  // `--mode act` (whether the policy allows it is not known yet): settle the PR read first, so the base, the policy and
  // the seed all come from the read the decision is made on, and read the policy strictly from the fetched base, so
  // nothing (an update-branch included) runs under a stale local copy.
  const actRequested = input.mode === 'act' && input.dryRun !== true;
  const prFacts = actRequested ? await readPr() : await collectPrFacts(gh, input.repoSlug, input.prNumber);
  const base = prFacts.baseRefName !== '' ? prFacts.baseRefName : 'main';
  const loaded = await loadPolicy(input.repoPath, base, actRequested ? { requireRemote: true } : {});
  if (loaded === undefined) {
    const decision: Decision = { verdict: 'ESCALATE', rulesFired: ['policy-unreadable'], auditSample: { p: 0, seed: '', hit: false }, reviewValid: false };
    return finish(undefined, decision, POLICY_HASH_NONE, prFacts.headSha);
  }
  const { policy, policyHash } = loaded;
  const seed = `${input.repoSlug}:${input.prNumber}:${prFacts.headSha}:${policyHash}`;

  const stopped = policy.enabled === false || (process.env.VANGUARD_APPROVER_STOP ?? '') !== '';
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

  acting = actRequested && policy.act === true;
  const actGh = actSafeGhRunner(rawGh);
  const logAction = (action: ActionKind, reason: string, headSha: string, reasonCode?: string): Promise<void> =>
    appendAction(input.repoPath, { schemaVersion: 1, kind: 'action', mode: 'act', repo: input.repoSlug, prNumber: input.prNumber, headSha, action, reason, ...(reasonCode !== undefined && reasonCode !== reason ? { reasonCode } : {}), timestamp }, branchOpts);
  // `code` is the stable part of a reason (default: the reason itself): it keys the marker and the log, so a different code on the
  // same head is reported while free-form detail (a gh error) does not make every run comment again.
  const tell = async (action: ActionKind, reason: string, headSha: string, code: string = reason): Promise<void> => {
    const marker = `<!-- taskcell-approver-act: ${headSha}:${action}:${reasonKey(code)} -->`;
    // A failed comment must not hide the log line, nor the other way round: both run, then the failures are thrown together (like finish()).
    const failures: string[] = [];
    try {
      await commentOnce(actGh, input.repoSlug, input.prNumber, marker, `## Taskcell Approver (act mode)\n\nLeft for a human: ${escapeForComment(reason)}.\n\n${marker}`);
    } catch (err) {
      failures.push(`comment: ${errorText(err)}`);
    }
    try {
      await logAction(action, reason, headSha, code);
    } catch (err) {
      failures.push(`log: ${errorText(err)}`);
    }
    if (failures.length > 0) throw new TaskcellError(`approver: #${input.prNumber} ${action} could not be reported (${failures.join('; ')})`);
  };

  const { reviews: _reviews, ...prWithoutReviews } = prFacts;
  const factory = isFactoryPr(prFacts, input.repoSlug, policy);
  const checks = await collectCheckFacts(gh, input.repoSlug, prFacts.headSha, policy);
  const reviewOpts = { requireRunStamp: true };
  const review = collectReviewFacts(prFacts, policy, acting ? reviewOpts : {});
  const diff = await collectDiffFacts({
    repoPath: input.repoPath,
    prNumber: input.prNumber,
    baseRefName: base,
    apiHeadSha: prFacts.headSha,
    reviewedSha: review.sha,
    policy,
    requireRemoteBase: acting,
  });
  const ledger = await readLedger({
    repoPath: input.repoPath,
    policy,
    now,
    prNumber: input.prNumber,
    touchedPaths: diff.paths,
    ...branchOpts,
  });

  const facts: ApproverFacts = { pr: prWithoutReviews, isFactoryPr: factory, checks, review, diff, ledger, thisPrLines: diff.lines };
  const decision = decide(facts, policy, seed);

  const result = await finish(facts, decision, policyHash, diff.headSha);
  if (!acting || facts.pr.state !== 'OPEN') return result;

  if (review.sha === null) {
    // No usable review for this head (yet): the PR-review run that triggered this one may have posted none (a PR the App bot
    // opened is only labelled by its `opened` run). The decision is in the check run and the log; a "left for a human"
    // comment here would land shortly before the run of the real review merges the PR.
    await logAction('left-for-human', 'review-missing: no usable review for this head yet; nothing to act on', diff.headSha);
    return result;
  }

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
    try {
      await actGh(['pr', 'update-branch', String(input.prNumber), '--repo', input.repoSlug]);
    } catch (err) {
      await tell('error', `the branch update failed: ${errorText(err)}`, diff.headSha, 'update-branch-failed');
      return result;
    }
    try {
      await logAction('update-branch', 'base branch moved; merged it into the head', diff.headSha);
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
    } catch (err) {
      await tell('error', `waiting for the updated head failed: ${errorText(err)}`, diff.headSha, 'update-wait-failed');
      return result;
    }
    await tell('checks-failed', 'timed out waiting for the checks on the updated head (a push made with the workflow token does not start CI; re-run the checks or push with a token that does)', diff.headSha);
    return result;
  }

  if (!reviewExact(facts)) {
    await tell('left-for-human', 'review-stale: the head tree is not the reviewed commit merged with the base; a new review is needed', diff.headSha);
    return result;
  }
  // Before the merge: the state read at the start is minutes old (checks wait, polls). Re-read the PR, the policy (strictly
  // from the remote base) and the in-repo kill switch, and hold the same exclusions against what is true now. (The
  // VANGUARD_APPROVER_STOP repo variable reaches the job as env at start; it is not re-read, `enabled` in the policy is.)
  const stale = await staleBeforeMerge();
  if (stale.reasons.length > 0) {
    await tell('left-for-human', `changed before the merge: ${stale.reasons.join('; ')}`, diff.headSha, stale.code);
    return result;
  }
  // The decision a merge is made on is always on the log before the merge, even when this head already has a record.
  try {
    await appendDecision(input.repoPath, { ...result.record, actMerge: true }, branchOpts);
  } catch (err) {
    // No merge without its record; comment why (the log is what just failed, so the action record is best effort).
    await tell('error', `the decision could not be logged before the merge: ${errorText(err)}`, diff.headSha, 'decision-log-failed').catch((tellErr: unknown) => console.error(errorText(tellErr)));
    throw new TaskcellError(errorText(err));
  }
  try {
    await actGh(['pr', 'merge', String(input.prNumber), '--repo', input.repoSlug, '--squash', '--match-head-commit', diff.headSha]);
  } catch (err) {
    await tell('merge-failed', `the merge was rejected: ${errorText(err)}`, diff.headSha, 'merge-rejected').catch((tellErr: unknown) => console.error(errorText(tellErr)));
    throw new TaskcellError(errorText(err));
  }
  try {
    await logAction('merge', 'reviewed, checks green, decision APPROVE; squash-merged', diff.headSha);
  } catch (err) {
    // The merge happened; a lost log line must not look like a failed merge.
    console.error(`taskcell approve: #${input.prNumber} was merged, but logging it failed: ${errorText(err)}`);
    await tell('error', `merged, but the action log failed: ${errorText(err)}`, diff.headSha, 'merge-log-failed');
  }
  return result;

  // `code` is set only when the reasons carry free-form error text; every other reason is stable and keys itself.
  async function staleBeforeMerge(): Promise<{ reasons: string[]; code?: string }> {
    try {
      return { reasons: await staleReasons() };
    } catch (err) {
      return { reasons: [`could not re-read the PR: ${errorText(err)}`], code: 'pre-merge-read-failed' };
    }
  }

  async function staleReasons(): Promise<string[]> {
    const latest = await readPr();
    if (latest.state !== 'OPEN') return [`the PR is ${latest.state}`];
    if (latest.headSha !== diff.headSha) return ['the head moved'];
    if (latest.baseRefName !== prFacts.baseRefName) return ['the base branch changed'];
    const reloaded = await loadPolicy(input.repoPath, base, { requireRemote: true });
    if (reloaded === undefined) return ['the policy could not be re-read from the base branch'];
    if (reloaded.policy.enabled === false || (process.env.VANGUARD_APPROVER_STOP ?? '') !== '') return ['the kill switch is on'];
    if (reloaded.policy.act !== true) return ['act mode is off in the policy'];
    if (reloaded.policyHash !== policyHash) return ['the policy changed'];
    // The strict policy read above just fetched the base, so this is its tip now (the API's baseRefOid can lag); an empty one fails closed.
    const baseTip = (await execa('git', ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`], { cwd: input.repoPath })).stdout.trim();
    if (baseTip === '' || baseTip !== diff.baseSha) return ['the base tip moved'];
    const { reviews: freshReviews, ...freshPr } = latest;
    const freshReview = collectReviewFacts(latest, reloaded.policy, reviewOpts);
    // Decide again on what is true now (required checks re-read, seed from this read): the verdict must still be APPROVE.
    const freshChecks = await collectCheckFacts(gh, input.repoSlug, diff.headSha, reloaded.policy);
    const freshFacts: ApproverFacts = { ...facts, pr: freshPr, isFactoryPr: isFactoryPr(latest, input.repoSlug, reloaded.policy), checks: freshChecks, review: freshReview };
    const freshDecision = decide(freshFacts, reloaded.policy, `${input.repoSlug}:${input.prNumber}:${latest.headSha}:${reloaded.policyHash}`);
    const reasons = actExclusions(freshFacts, freshDecision, reloaded.policy, freshReviews);
    if (freshPr.mergeStateStatus !== 'CLEAN') reasons.push(`mergeStateStatus ${freshPr.mergeStateStatus ?? 'absent'}`);
    if (freshReview.sha !== review.sha || freshReview.verdict !== review.verdict) reasons.push('the review changed');
    return reasons;
  }
}
