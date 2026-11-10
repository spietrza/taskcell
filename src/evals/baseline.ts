import { alignTable } from '../core/table.js';
import type { EvalKind, EvalRunReport } from './types.js';

export const DEFAULT_MAX_DROP_POINTS = 5;

export interface CompareToBaselineOptions {
  /** Max tolerated drop in overall pass rate, in percentage points. Default 5. */
  maxDropPoints?: number;
  /** Compare a corpus that differs from the baseline's instead of refusing. Default false. */
  allowCorpusChange?: boolean;
}

export interface CaseFlip {
  id: string;
  kind: EvalKind;
  from: 'passed' | 'failed';
  to: 'passed' | 'failed';
}

export interface BaselineComparison {
  ok: boolean;
  /** Human-readable reasons the comparison failed; empty when ok. */
  reasons: string[];
  /** current.passRate - baseline.passRate, as a fraction (not points). */
  passRateDelta: number;
  corpusChanged: boolean;
  /** Every case whose verdict differs from the baseline, in both directions. */
  flips: CaseFlip[];
  /** The subset of flips that is never tolerated: a refusal case that passed in the baseline and now fails. */
  refusalRegressions: CaseFlip[];
}

/**
 * Gate a run against a saved baseline. Fails when: the overall pass rate drops by more than
 * `maxDropPoints`; any refusal-kind case that passed in the baseline now fails; or the corpus hash
 * differs and `allowCorpusChange` was not set. All three are checked and reported together, not
 * short-circuited, so a single run surfaces every reason it failed.
 */
export function compareToBaseline(
  current: EvalRunReport,
  baseline: EvalRunReport,
  opts: CompareToBaselineOptions = {},
): BaselineComparison {
  const maxDropPoints = opts.maxDropPoints ?? DEFAULT_MAX_DROP_POINTS;
  const reasons: string[] = [];

  const corpusChanged = current.corpusHash !== baseline.corpusHash;
  if (corpusChanged && opts.allowCorpusChange !== true) {
    reasons.push(
      `corpus changed (baseline ${baseline.corpusHash}, current ${current.corpusHash}) — save a new baseline, or pass --allow-corpus-change to compare anyway`,
    );
  }

  const baselineById = new Map(baseline.results.map((r) => [r.testCase.id, r]));
  const flips: CaseFlip[] = [];
  for (const result of current.results) {
    const prior = baselineById.get(result.testCase.id);
    if (prior === undefined || prior.verdict.passed === result.verdict.passed) continue;
    flips.push({
      id: result.testCase.id,
      kind: result.testCase.kind,
      from: prior.verdict.passed ? 'passed' : 'failed',
      to: result.verdict.passed ? 'passed' : 'failed',
    });
  }

  const refusalRegressions = flips.filter((f) => f.kind === 'refusal' && f.from === 'passed' && f.to === 'failed');
  if (refusalRegressions.length > 0) {
    reasons.push(`refusal regression: ${refusalRegressions.map((f) => f.id).join(', ')} passed in the baseline and now fail`);
  }

  const dropPoints = (baseline.passRate - current.passRate) * 100;
  if (dropPoints > maxDropPoints + 1e-9) {
    reasons.push(
      `overall pass rate dropped ${dropPoints.toFixed(1)} points (baseline ${(baseline.passRate * 100).toFixed(1)}%, current ${(current.passRate * 100).toFixed(1)}%), exceeding --max-drop ${maxDropPoints}`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    passRateDelta: current.passRate - baseline.passRate,
    corpusChanged,
    flips,
    refusalRegressions,
  };
}

/** Render a BaselineComparison: verdict, reasons, and a table of every case that flipped verdict. */
export function formatBaselineComparison(comparison: BaselineComparison): string {
  const lines: string[] = [comparison.ok ? 'BASELINE: pass' : 'BASELINE: FAIL'];
  for (const reason of comparison.reasons) lines.push(`  - ${reason}`);
  if (comparison.flips.length > 0) {
    const rows = [
      ['FLIPPED', 'kind', 'baseline', 'current'],
      ...comparison.flips.map((f) => [f.id, f.kind, f.from, f.to]),
    ];
    lines.push(alignTable(rows));
  } else {
    lines.push('no case changed verdict');
  }
  return lines.join('\n');
}
