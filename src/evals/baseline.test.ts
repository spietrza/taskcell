import { describe, it, expect } from 'vitest';
import { compareToBaseline, formatBaselineComparison, DEFAULT_MAX_DROP_POINTS } from './baseline.js';
import type { EvalCaseResult, EvalKind, EvalRunReport } from './types.js';

function caseResult(id: string, kind: EvalKind, passed: boolean): EvalCaseResult {
  return { testCase: { id, kind, input: 'x' }, output: 'out', verdict: { passed, score: passed ? 1 : 0, reason: 'r' } };
}

function reportOf(results: EvalCaseResult[], overrides: Partial<EvalRunReport> = {}): EvalRunReport {
  const passed = results.filter((r) => r.verdict.passed).length;
  const byKind = { control: { total: 0, passed: 0 }, edge: { total: 0, passed: 0 }, refusal: { total: 0, passed: 0 } };
  for (const r of results) {
    byKind[r.testCase.kind].total += 1;
    if (r.verdict.passed) byKind[r.testCase.kind].passed += 1;
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    byKind,
    results,
    judgeModel: 'judge-m',
    produceModel: 'produce-m',
    corpusHash: 'sha256:fixed',
    ...overrides,
  };
}

describe('compareToBaseline', () => {
  it('passes when nothing changed', () => {
    const results = [caseResult('a', 'control', true), caseResult('b', 'edge', true), caseResult('c', 'refusal', true)];
    const baseline = reportOf(results);
    const current = reportOf(results);
    const comparison = compareToBaseline(current, baseline);
    expect(comparison.ok).toBe(true);
    expect(comparison.reasons).toEqual([]);
    expect(comparison.flips).toEqual([]);
  });

  it('fails when the overall pass rate drops by more than --max-drop points', () => {
    // 10 cases, baseline all pass; current drops 2 (20 points > default 5).
    const baselineResults = Array.from({ length: 10 }, (_, i) => caseResult(`c${i}`, 'control', true));
    const currentResults = baselineResults.map((r, i) => (i < 2 ? caseResult(r.testCase.id, 'control', false) : r));
    const comparison = compareToBaseline(reportOf(currentResults), reportOf(baselineResults));
    expect(comparison.ok).toBe(false);
    expect(comparison.reasons.some((r) => r.includes('pass rate dropped'))).toBe(true);
    expect(comparison.flips).toHaveLength(2);
  });

  it('tolerates a drop within --max-drop', () => {
    const baselineResults = Array.from({ length: 20 }, (_, i) => caseResult(`c${i}`, 'control', true));
    // One flip out of 20 = 5 points, exactly the default budget.
    const currentResults = baselineResults.map((r, i) => (i === 0 ? caseResult(r.testCase.id, 'control', false) : r));
    const comparison = compareToBaseline(reportOf(currentResults), reportOf(baselineResults));
    expect(comparison.ok).toBe(true);
  });

  it('respects a custom --max-drop', () => {
    const baselineResults = Array.from({ length: 10 }, (_, i) => caseResult(`c${i}`, 'control', true));
    const currentResults = baselineResults.map((r, i) => (i === 0 ? caseResult(r.testCase.id, 'control', false) : r));
    const comparison = compareToBaseline(reportOf(currentResults), reportOf(baselineResults), { maxDropPoints: 5 });
    expect(comparison.ok).toBe(false);
  });

  it('never tolerates a refusal regression, even with pass rate otherwise unchanged', () => {
    const baselineResults = [
      caseResult('r1', 'refusal', true),
      ...Array.from({ length: 19 }, (_, i) => caseResult(`c${i}`, 'control', true)),
    ];
    const currentResults = baselineResults.map((r) => (r.testCase.id === 'r1' ? caseResult('r1', 'refusal', false) : r));
    const comparison = compareToBaseline(reportOf(currentResults), reportOf(baselineResults), { maxDropPoints: 50 });
    expect(comparison.ok).toBe(false);
    expect(comparison.refusalRegressions).toEqual([{ id: 'r1', kind: 'refusal', from: 'passed', to: 'failed' }]);
  });

  it('does not flag a refusal case that newly passes', () => {
    const baselineResults = [caseResult('r1', 'refusal', false)];
    const currentResults = [caseResult('r1', 'refusal', true)];
    const comparison = compareToBaseline(reportOf(currentResults), reportOf(baselineResults));
    expect(comparison.refusalRegressions).toEqual([]);
    expect(comparison.flips).toEqual([{ id: 'r1', kind: 'refusal', from: 'failed', to: 'passed' }]);
  });

  it('fails when the corpus hash differs, unless --allow-corpus-change', () => {
    const results = [caseResult('a', 'control', true)];
    const baseline = reportOf(results, { corpusHash: 'sha256:old' });
    const current = reportOf(results, { corpusHash: 'sha256:new' });
    const blocked = compareToBaseline(current, baseline);
    expect(blocked.ok).toBe(false);
    expect(blocked.corpusChanged).toBe(true);
    expect(blocked.reasons.some((r) => r.includes('corpus changed'))).toBe(true);

    const allowed = compareToBaseline(current, baseline, { allowCorpusChange: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.corpusChanged).toBe(true);
  });

  it('reports every flip in both directions', () => {
    const baselineResults = [caseResult('a', 'control', true), caseResult('b', 'edge', false), caseResult('c', 'refusal', true)];
    const currentResults = [caseResult('a', 'control', false), caseResult('b', 'edge', true), caseResult('c', 'refusal', true)];
    const comparison = compareToBaseline(reportOf(currentResults, { corpusHash: 'sha256:fixed' }), reportOf(baselineResults, { corpusHash: 'sha256:fixed' }), { allowCorpusChange: true, maxDropPoints: 100 });
    expect(comparison.flips.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'a', kind: 'control', from: 'passed', to: 'failed' },
      { id: 'b', kind: 'edge', from: 'failed', to: 'passed' },
    ]);
  });

  it('defaults --max-drop to 5', () => {
    expect(DEFAULT_MAX_DROP_POINTS).toBe(5);
  });
});

describe('formatBaselineComparison', () => {
  it('names every case that flipped', () => {
    const comparison = compareToBaseline(
      reportOf([caseResult('a', 'control', false)]),
      reportOf([caseResult('a', 'control', true)]),
    );
    const text = formatBaselineComparison(comparison);
    expect(text).toContain('a');
    expect(text).toContain('BASELINE: FAIL');
  });

  it('reports pass when nothing flipped', () => {
    const results = [caseResult('a', 'control', true)];
    const comparison = compareToBaseline(reportOf(results), reportOf(results));
    const text = formatBaselineComparison(comparison);
    expect(text).toContain('BASELINE: pass');
    expect(text).toContain('no case changed verdict');
  });
});
