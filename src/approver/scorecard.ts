/**
 * The approver's shadow scorecard: for every factory PR, the shadow verdict next to what the human
 * actually did, bucketed by risk class. Pure aggregation only — fetching the inputs (decisions.jsonl,
 * PR state, revert commits) lives in `outcome.ts`; this module never calls `gh`.
 */
import { parseJsonlLines } from '../core/stats.js';
import { alignTable } from '../core/table.js';
import type { HumanOutcome } from './types.js';

/** 30 correct APPROVE verdicts in a row in one risk class — the documented bar before that class is
 * even considered for opt-in auto-merge. This issue only measures toward it; nothing here turns
 * auto-merge on. */
export const AUTO_MERGE_STREAK_THRESHOLD = 30;

/** The subset of a decision record the scorecard needs — a superset like `DecisionRecord` satisfies it. */
export interface ShadowDecision {
  repo: string;
  prNumber: number;
  verdict: 'APPROVE' | 'ESCALATE';
  rulesFired: string[];
  headSha: string | null;
  timestamp: string;
}

export interface FactoryPrRef {
  repo: string;
  prNumber: number;
  /** GitHub PR state: OPEN, CLOSED, or MERGED. */
  state: string;
  mergedAt: string | null;
  /** The PR head's final commit SHA (survives branch deletion in the PR object). */
  finalHeadSha: string | null;
  mergeCommitSha: string | null;
}

export interface RevertRecord {
  repo: string;
  /** The SHA captured from "This reverts commit <sha>" — may be short or full. */
  targetSha: string;
  revertedAt: string;
}

export interface ScorecardRow {
  repo: string;
  prNumber: number;
  /** null when no decision record exists for this PR at all — listed, never counted. */
  verdict: 'APPROVE' | 'ESCALATE' | null;
  rulesFired: string[];
  riskClasses: string[];
  humanOutcome: HumanOutcome;
  decisionHeadSha: string | null;
  timestamp: string | null;
}

export interface RiskClassSummary {
  riskClass: string;
  approveTotal: number;
  approveCorrect: number;
  escalateTotal: number;
  escalateMergedUnchanged: number;
  /** Current streak of correct APPROVE verdicts, in chronological order; resets to 0 on a wrong one. */
  streak: number;
}

export interface ApproverScorecardReport {
  rows: ScorecardRow[];
  byRiskClass: RiskClassSummary[];
  autoMergeStreakThreshold: number;
}

/** Tolerant JSONL parse: a malformed or pre-schema line (missing a field this needs) is dropped, not fatal. */
export function parseDecisions(text: string): ShadowDecision[] {
  const decisions: ShadowDecision[] = [];
  for (const parsed of parseJsonlLines(text)) {
    if (typeof parsed.repo !== 'string' || typeof parsed.prNumber !== 'number') continue;
    if (parsed.verdict !== 'APPROVE' && parsed.verdict !== 'ESCALATE') continue;
    if (typeof parsed.timestamp !== 'string') continue;
    const rulesFired = Array.isArray(parsed.rulesFired) ? parsed.rulesFired.filter((r): r is string => typeof r === 'string') : [];
    decisions.push({
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      verdict: parsed.verdict,
      rulesFired,
      headSha: typeof parsed.headSha === 'string' ? parsed.headSha : null,
      timestamp: parsed.timestamp,
    });
  }
  return decisions;
}

const PATH_RULE_RE = /^path:(.+)$/;

/** Risk classes signalled by the decision's own `path:<key>` rules (see `.vanguard/approver.json`'s
 * `pathRules`), or `['general']` when none fired — which, by construction, is every APPROVE. */
export function riskClassesOf(rulesFired: ReadonlyArray<string>): string[] {
  const classes = [...new Set(rulesFired.map((rule) => PATH_RULE_RE.exec(rule)?.[1]).filter((c): c is string => c !== undefined))];
  return classes.length > 0 ? classes.sort() : ['general'];
}

/** The most recent decision per (repo, PR) — the shadow verdict currently standing for that PR. */
export function latestDecisions(decisions: ReadonlyArray<ShadowDecision>): ShadowDecision[] {
  const byKey = new Map<string, ShadowDecision>();
  for (const decision of decisions) {
    const key = `${decision.repo}:${decision.prNumber}`;
    const prior = byKey.get(key);
    if (prior === undefined || decision.timestamp.localeCompare(prior.timestamp) > 0) byKey.set(key, decision);
  }
  return [...byKey.values()];
}

/**
 * What the human did with a factory PR, from PR state and the default branch's revert history alone.
 * A merge later reverted within `windowDays` is 'reverted' regardless of whether it was merged as-is or
 * after more commits — it was not a correct APPROVE either way. An open PR (nothing decided yet) is
 * null, same as one with no matching `FactoryPrRef` at all.
 */
/** Whether one SHA is a prefix of the other — either may be the short or full form. */
function shaPrefixMatches(a: string, b: string): boolean {
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

export function resolveOutcome(
  pr: FactoryPrRef,
  decisionHeadSha: string | null,
  reverts: ReadonlyArray<RevertRecord>,
  windowDays = 7,
): HumanOutcome {
  if (pr.state !== 'MERGED' || pr.mergedAt === null) {
    return pr.state === 'CLOSED' ? 'closed' : null;
  }
  const mergeCommitSha = pr.mergeCommitSha;
  const mergedMs = Date.parse(pr.mergedAt);
  const cutoff = mergedMs + windowDays * 24 * 60 * 60 * 1000;
  const revertedWithinWindow = mergeCommitSha !== null && reverts.some((r) => {
    if (r.repo !== pr.repo || !shaPrefixMatches(r.targetSha, mergeCommitSha)) return false;
    const revertedMs = Date.parse(r.revertedAt);
    return revertedMs >= mergedMs && revertedMs <= cutoff;
  });
  if (revertedWithinWindow) return 'reverted';
  const noLaterCommits = decisionHeadSha !== null && decisionHeadSha === pr.finalHeadSha;
  return noLaterCommits ? 'merged-as-is' : 'merged-after-changes';
}

export interface BuildScorecardOptions {
  windowDays?: number;
  threshold?: number;
}

/**
 * Join the latest decision per PR with its factory-PR state and the repo's revert history into the
 * per-PR rows and the per-risk-class rollup. A PR with a decision but no matching `FactoryPrRef` (not
 * found in the PR list, e.g. still outside `gh pr list`'s window) gets `humanOutcome: null` and is
 * excluded from the rollup, same as a PR with no decision at all — nothing here is guessed.
 */
export function buildScorecard(
  decisions: ReadonlyArray<ShadowDecision>,
  factoryPrs: ReadonlyArray<FactoryPrRef>,
  reverts: ReadonlyArray<RevertRecord>,
  options: BuildScorecardOptions = {},
): ApproverScorecardReport {
  const windowDays = options.windowDays ?? 7;
  const threshold = options.threshold ?? AUTO_MERGE_STREAK_THRESHOLD;

  const keyOf = (repo: string, prNumber: number): string => `${repo}:${prNumber}`;
  const latestByKey = new Map(latestDecisions(decisions).map((d) => [keyOf(d.repo, d.prNumber), d]));
  const prByKey = new Map(factoryPrs.map((pr) => [keyOf(pr.repo, pr.prNumber), pr]));
  const refsByKey = new Map([...latestByKey.values(), ...factoryPrs].map((ref) => [keyOf(ref.repo, ref.prNumber), ref]));

  const rows: ScorecardRow[] = [...refsByKey.keys()].map((key) => {
    const { repo, prNumber } = refsByKey.get(key)!;
    const decision = latestByKey.get(key);
    const pr = prByKey.get(key);
    const humanOutcome = pr !== undefined ? resolveOutcome(pr, decision?.headSha ?? null, reverts, windowDays) : null;
    return {
      repo,
      prNumber,
      verdict: decision?.verdict ?? null,
      rulesFired: decision?.rulesFired ?? [],
      riskClasses: decision !== undefined ? riskClassesOf(decision.rulesFired) : [],
      humanOutcome,
      decisionHeadSha: decision?.headSha ?? null,
      timestamp: decision?.timestamp ?? null,
    };
  });
  rows.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.prNumber - b.prNumber);

  const byClass = new Map<string, RiskClassSummary>();
  const summaryOf = (riskClass: string): RiskClassSummary => {
    const existing = byClass.get(riskClass);
    if (existing !== undefined) return existing;
    const fresh: RiskClassSummary = { riskClass, approveTotal: 0, approveCorrect: 0, escalateTotal: 0, escalateMergedUnchanged: 0, streak: 0 };
    byClass.set(riskClass, fresh);
    return fresh;
  };

  // Rows are in chronological order; a wrong APPROVE resets the streak, an ESCALATE never touches it.
  for (const row of rows) {
    if (row.verdict === null || row.humanOutcome === null) continue;
    for (const riskClass of row.riskClasses) {
      const summary = summaryOf(riskClass);
      if (row.verdict === 'APPROVE') {
        summary.approveTotal += 1;
        if (row.humanOutcome === 'merged-as-is') {
          summary.approveCorrect += 1;
          summary.streak += 1;
        } else {
          summary.streak = 0;
        }
      } else {
        summary.escalateTotal += 1;
        if (row.humanOutcome === 'merged-as-is') summary.escalateMergedUnchanged += 1;
      }
    }
  }

  return {
    rows,
    byRiskClass: [...byClass.values()].sort((a, b) => a.riskClass.localeCompare(b.riskClass)),
    autoMergeStreakThreshold: threshold,
  };
}

function outcomeLabel(outcome: HumanOutcome): string {
  return outcome ?? '(pending)';
}

/** Render the per-PR rows and the per-risk-class rollup as two text tables. */
export function formatApproverScorecard(report: ApproverScorecardReport): string {
  const prTable = alignTable([
    ['PR', 'VERDICT', 'RISK CLASS', 'HUMAN OUTCOME', 'RULES FIRED'],
    ...report.rows.map((row) => [
      `${row.repo}#${row.prNumber}`,
      row.verdict ?? '(no shadow verdict)',
      row.riskClasses.join(',') || '-',
      outcomeLabel(row.humanOutcome),
      row.rulesFired.join(',') || '(none)',
    ]),
  ]);
  const classTable = alignTable([
    ['RISK CLASS', 'APPROVE right/total', 'ESCALATE merged-unchanged/total', 'STREAK', `TOWARD AUTO-MERGE (${report.autoMergeStreakThreshold})`],
    ...report.byRiskClass.map((c) => [
      c.riskClass,
      `${c.approveCorrect}/${c.approveTotal}`,
      `${c.escalateMergedUnchanged}/${c.escalateTotal}`,
      String(c.streak),
      `${Math.min(c.streak, report.autoMergeStreakThreshold)}/${report.autoMergeStreakThreshold}`,
    ]),
  ]);
  return [prTable, '', classTable].join('\n');
}
