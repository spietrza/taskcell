/**
 * Decision record, facts, and policy types for the approver stage (v1: shadow mode). See
 * `src/approver/rules.ts` for the pure decision function and `src/approver/policy.ts` for the
 * zod schema these types mirror.
 */

export interface ApproverPolicy {
  schemaVersion: 1;
  enabled: boolean;
  factoryBranchPrefix: string;
  requiredChecks: Array<{ name: string; appId: number }>;
  reviewAuthors: string[];
  testGlobs: string[];
  pathRules: Record<string, string[]>;
  shape: { maxLines: number; maxFiles: number };
  ledger: { windowDays: number; maxLines: number };
  auditSample: { p: number };
  /** Act mode (merge APPROVEd factory PRs); off unless the base branch's policy turns it on. */
  act?: boolean;
  /** Act mode: a PR carrying this label is left for a human (default `taskcell:hold`). */
  holdLabel?: string;
  /** Act mode: API-sourced PR author logins the factory opens PRs as; a PR by anyone else is never acted on. */
  factoryAuthors?: string[];
}

export interface PrFacts {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  apiBaseSha: string;
  /** owner/name of the head repo, '' when the API omits it. */
  headRepo: string;
  title?: string;
  /** GitHub's mergeStateStatus (BEHIND, DIRTY, CLEAN, ...); absent when the API omits it. */
  mergeStateStatus?: string;
  /** API-sourced PR author login ('' when the API omits it). */
  author?: string;
  labels?: string[];
  /** `commitSha`: GitHub's commit id for the review, the head when it was submitted ('' or absent when the API omits it). */
  reviews: Array<{ author: string; body: string; submittedAt: string; state: string; commitSha?: string }>;
}

export interface CheckFact {
  name: string;
  appId: number;
  conclusion: string | null;
}

export type ReviewVerdictValue = 'clean' | 'blocking' | null;

export interface ReviewFacts {
  verdict: ReviewVerdictValue;
  sha: string | null;
  author: string | null;
}

export interface DiffFacts {
  gateConfigPaths?: string[];
  files: number;
  lines: number;
  paths: string[];
  testFilesDeleted: number;
  testCasesDelta: number;
  exportsRemoved: number;
  newDependency: boolean;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  /** patch-id of merge-base..headSha, or undefined when the diff is empty / the computation failed. */
  headPatchId: string | undefined;
  /** patch-id of merge-base..reviewedSha, computed only when reviewedSha !== headSha. */
  reviewedPatchId: string | undefined;
  /** Whether reviewedSha is an ancestor of headSha (true trivially when they are equal). */
  reviewedIsAncestor: boolean | undefined;
  /** merge-tree(baseSha, headSha): true clean, false conflict, undefined on failure. */
  mergeTreeHeadClean: boolean | undefined;
  /** merge-tree(baseSha, reviewedSha), computed only when reviewedSha !== headSha. */
  mergeTreeReviewedClean: boolean | undefined;
  /** Tree of headSha; act mode's exact review check compares it with `reviewedMergedTree`. */
  headTree?: string;
  /** Tree of `git merge-tree --write-tree <baseSha> <reviewedSha>` (clean merges only), computed only when reviewedSha !== headSha. */
  reviewedMergedTree?: string;
  /** The fetched refs/pull/<n>/head did not match the API head SHA. */
  headMoved: boolean;
  /** Any required git fact could not be computed (fetch/merge-base/numstat failure). */
  gitFactsFailed: boolean;
}

export interface ApproverFacts {
  pr: Omit<PrFacts, 'reviews'>;
  isFactoryPr: boolean;
  checks: CheckFact[];
  review: ReviewFacts;
  diff: DiffFacts;
  ledger: Record<string, number>;
  /** Σ of this PR's own changed lines — folded into the ledger module sums for the velocity rule. */
  thisPrLines: number;
}

export interface AuditSample {
  p: number;
  seed: string;
  hit: boolean;
}

export interface Decision {
  verdict: 'APPROVE' | 'ESCALATE';
  rulesFired: string[];
  auditSample: AuditSample;
  reviewValid: boolean;
}

export type Mode = 'shadow' | 'act';

/** What the human did with a factory PR, from PR state and revert history alone — see `scorecard.ts`. */
export type HumanOutcome = 'merged-as-is' | 'merged-after-changes' | 'closed' | 'reverted' | null;

export interface DecisionRecord {
  schemaVersion: 1;
  mode: Mode;
  repo: string;
  prNumber: number;
  headSha: string | null;
  baseSha: string | null;
  patchId: string | null;
  reviewedSha: string | null;
  checks: CheckFact[];
  review: { verdict: ReviewVerdictValue; sha: string | null };
  signals: {
    files: number;
    lines: number;
    testFilesDeleted: number;
    testCasesDelta: number;
    exportsRemoved: number;
    newDependency: boolean;
    paths: string[];
  };
  ledger: Record<string, number>;
  auditSample: AuditSample;
  rulesFired: string[];
  verdict: 'APPROVE' | 'ESCALATE';
  policyHash: string;
  timestamp: string;
  humanOutcome: HumanOutcome;
  /** Act mode: the APPROVE a merge is made on, appended even when the head already has a decision. */
  actMerge?: true;
}
