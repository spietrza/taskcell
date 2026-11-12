import { describe, it, expect } from 'vitest';
import {
  AUTO_MERGE_STREAK_THRESHOLD,
  buildScorecard,
  formatApproverScorecard,
  latestDecisions,
  parseDecisions,
  resolveOutcome,
  riskClassesOf,
} from './scorecard.js';
import type { FactoryPrRef, RevertRecord, ShadowDecision } from './scorecard.js';

function decision(partial: Partial<ShadowDecision> & { prNumber: number; timestamp: string }): ShadowDecision {
  return {
    repo: 'o/r',
    verdict: 'APPROVE',
    rulesFired: [],
    headSha: 'head1',
    ...partial,
  };
}

function pr(partial: Partial<FactoryPrRef> & { prNumber: number }): FactoryPrRef {
  return {
    repo: 'o/r',
    state: 'MERGED',
    mergedAt: '2026-01-01T00:00:00.000Z',
    finalHeadSha: 'head1',
    mergeCommitSha: 'merge1',
    ...partial,
  };
}

describe('riskClassesOf', () => {
  it('returns the path: rule suffixes, sorted and deduped', () => {
    expect(riskClassesOf(['path:dependencies', 'size-lines', 'path:dependencies', 'path:ci-config'])).toEqual(['ci-config', 'dependencies']);
  });

  it('falls back to general when no path rule fired (true of every APPROVE)', () => {
    expect(riskClassesOf([])).toEqual(['general']);
    expect(riskClassesOf(['review-missing', 'size-lines'])).toEqual(['general']);
  });
});

describe('parseDecisions', () => {
  it('parses well-formed lines and drops malformed or incomplete ones', () => {
    const lines = [
      JSON.stringify({ repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], headSha: 'h1', timestamp: '2026-01-01T00:00:00.000Z' }),
      'not json',
      JSON.stringify({ repo: 'o/r', prNumber: 2, verdict: 'MAYBE', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ repo: 'o/r', prNumber: 3, verdict: 'ESCALATE', timestamp: '2026-01-02T00:00:00.000Z' }),
    ].join('\n');
    expect(parseDecisions(lines)).toEqual([
      { repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], headSha: 'h1', timestamp: '2026-01-01T00:00:00.000Z' },
      { repo: 'o/r', prNumber: 3, verdict: 'ESCALATE', rulesFired: [], headSha: null, timestamp: '2026-01-02T00:00:00.000Z' },
    ]);
  });
});

describe('latestDecisions', () => {
  it('keeps the most recent decision per (repo, PR) by timestamp', () => {
    const decisions = [
      decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'ESCALATE' }),
      decision({ prNumber: 1, timestamp: '2026-01-02T00:00:00.000Z', verdict: 'APPROVE' }),
      decision({ prNumber: 2, timestamp: '2026-01-01T00:00:00.000Z' }),
    ];
    const latest = latestDecisions(decisions);
    expect(latest).toHaveLength(2);
    expect(latest.find((d) => d.prNumber === 1)).toMatchObject({ verdict: 'APPROVE', timestamp: '2026-01-02T00:00:00.000Z' });
  });
});

describe('resolveOutcome', () => {
  it('is null for a still-open PR', () => {
    expect(resolveOutcome(pr({ prNumber: 1, state: 'OPEN', mergedAt: null }), 'head1', [])).toBeNull();
  });

  it('is closed for a closed-unmerged PR', () => {
    expect(resolveOutcome(pr({ prNumber: 1, state: 'CLOSED', mergedAt: null }), 'head1', [])).toBe('closed');
  });

  it('is merged-as-is when the final head matches the decision head and nothing was reverted', () => {
    expect(resolveOutcome(pr({ prNumber: 1 }), 'head1', [])).toBe('merged-as-is');
  });

  it('is merged-after-changes when commits landed after the decision head', () => {
    expect(resolveOutcome(pr({ prNumber: 1, finalHeadSha: 'head2' }), 'head1', [])).toBe('merged-after-changes');
  });

  it('is merged-after-changes when the decision head is unknown', () => {
    expect(resolveOutcome(pr({ prNumber: 1 }), null, [])).toBe('merged-after-changes');
  });

  it('detects a revert within the window, by full merge-commit SHA, overriding merged-as-is', () => {
    const reverts: RevertRecord[] = [{ repo: 'o/r', targetSha: 'merge1', revertedAt: '2026-01-03T00:00:00.000Z' }];
    expect(resolveOutcome(pr({ prNumber: 1 }), 'head1', reverts)).toBe('reverted');
  });

  it('detects a revert within the window by short SHA prefix', () => {
    const reverts: RevertRecord[] = [{ repo: 'o/r', targetSha: 'merge1'.slice(0, 4), revertedAt: '2026-01-02T00:00:00.000Z' }];
    expect(resolveOutcome(pr({ prNumber: 1 }), 'head1', reverts)).toBe('reverted');
  });

  it('ignores a revert outside the 7-day window', () => {
    const reverts: RevertRecord[] = [{ repo: 'o/r', targetSha: 'merge1', revertedAt: '2026-01-10T00:00:01.000Z' }];
    expect(resolveOutcome(pr({ prNumber: 1 }), 'head1', reverts)).toBe('merged-as-is');
  });

  it('ignores a revert targeting a different commit, or from another repo', () => {
    const reverts: RevertRecord[] = [
      { repo: 'o/r', targetSha: 'somethingelse', revertedAt: '2026-01-02T00:00:00.000Z' },
      { repo: 'other/repo', targetSha: 'merge1', revertedAt: '2026-01-02T00:00:00.000Z' },
    ];
    expect(resolveOutcome(pr({ prNumber: 1 }), 'head1', reverts)).toBe('merged-as-is');
  });
});

describe('buildScorecard', () => {
  it('counts a correct APPROVE (merged as-is, not reverted) toward approveCorrect and the streak', () => {
    const report = buildScorecard(
      [decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'APPROVE' })],
      [pr({ prNumber: 1 })],
      [],
    );
    expect(report.byRiskClass).toEqual([
      { riskClass: 'general', approveTotal: 1, approveCorrect: 1, escalateTotal: 0, escalateMergedUnchanged: 0, streak: 1 },
    ]);
    expect(report.rows).toEqual([
      {
        repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], riskClasses: ['general'],
        humanOutcome: 'merged-as-is', decisionHeadSha: 'head1', timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('resets the streak to 0 on a wrong APPROVE, then rebuilds it', () => {
    const decisions = [
      decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'APPROVE' }),
      decision({ prNumber: 2, timestamp: '2026-01-02T00:00:00.000Z', verdict: 'APPROVE' }),
      decision({ prNumber: 3, timestamp: '2026-01-03T00:00:00.000Z', verdict: 'APPROVE' }),
      decision({ prNumber: 4, timestamp: '2026-01-04T00:00:00.000Z', verdict: 'APPROVE' }),
    ];
    const prs = [
      pr({ prNumber: 1 }), // correct
      pr({ prNumber: 2, finalHeadSha: 'head-changed' }), // wrong: merged after changes
      pr({ prNumber: 3 }), // correct again
      pr({ prNumber: 4 }), // correct again
    ];
    const report = buildScorecard(decisions, prs, []);
    const general = report.byRiskClass.find((c) => c.riskClass === 'general')!;
    expect(general.approveTotal).toBe(4);
    expect(general.approveCorrect).toBe(3);
    expect(general.streak).toBe(2); // PR 3 and 4, after the reset at PR 2
  });

  it('does not let an ESCALATE in between interrupt the APPROVE streak', () => {
    const decisions = [
      decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'APPROVE' }),
      decision({ prNumber: 2, timestamp: '2026-01-02T00:00:00.000Z', verdict: 'ESCALATE', rulesFired: ['review-missing'] }),
      decision({ prNumber: 3, timestamp: '2026-01-03T00:00:00.000Z', verdict: 'APPROVE' }),
    ];
    const prs = [
      pr({ prNumber: 1 }),
      pr({ prNumber: 2, state: 'CLOSED', mergedAt: null }),
      pr({ prNumber: 3 }),
    ];
    const report = buildScorecard(decisions, prs, []);
    const general = report.byRiskClass.find((c) => c.riskClass === 'general')!;
    expect(general.streak).toBe(2);
  });

  it('counts an ESCALATE the human merged unchanged, under its risk class', () => {
    const decisions = [decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'ESCALATE', rulesFired: ['path:dependencies'] })];
    const prs = [pr({ prNumber: 1 })];
    const report = buildScorecard(decisions, prs, []);
    expect(report.byRiskClass).toEqual([
      { riskClass: 'dependencies', approveTotal: 0, approveCorrect: 0, escalateTotal: 1, escalateMergedUnchanged: 1, streak: 0 },
    ]);
  });

  it('lists a factory PR with no decision as such, and excludes it from the rollup', () => {
    const report = buildScorecard([], [pr({ prNumber: 9 })], []);
    expect(report.rows).toEqual([
      { repo: 'o/r', prNumber: 9, verdict: null, rulesFired: [], riskClasses: [], humanOutcome: 'merged-after-changes', decisionHeadSha: null, timestamp: null },
    ]);
    expect(report.byRiskClass).toEqual([]);
  });

  it('excludes a decision with no outcome yet (still open, or not in the fetched PR list) from the rollup', () => {
    const decisions = [decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'APPROVE' })];
    const report = buildScorecard(decisions, [], []);
    expect(report.rows).toEqual([
      { repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], riskClasses: ['general'], humanOutcome: null, decisionHeadSha: 'head1', timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(report.byRiskClass).toEqual([]);
  });

  it('reports a reverted merge as neither a correct APPROVE nor a merged-unchanged ESCALATE', () => {
    const reverts: RevertRecord[] = [{ repo: 'o/r', targetSha: 'merge1', revertedAt: '2026-01-02T00:00:00.000Z' }];
    const approveReport = buildScorecard(
      [decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'APPROVE' })],
      [pr({ prNumber: 1 })],
      reverts,
    );
    expect(approveReport.byRiskClass[0]).toMatchObject({ approveTotal: 1, approveCorrect: 0, streak: 0 });

    const escalateReport = buildScorecard(
      [decision({ prNumber: 2, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'ESCALATE' })],
      [pr({ prNumber: 2 })],
      reverts,
    );
    expect(escalateReport.byRiskClass[0]).toMatchObject({ escalateTotal: 1, escalateMergedUnchanged: 0 });
  });

  it('defaults the auto-merge threshold to 30 and honors an override', () => {
    expect(buildScorecard([], [], []).autoMergeStreakThreshold).toBe(AUTO_MERGE_STREAK_THRESHOLD);
    expect(buildScorecard([], [], [], { threshold: 5 }).autoMergeStreakThreshold).toBe(5);
  });
});

describe('formatApproverScorecard', () => {
  it('renders a PR table and a risk-class table', () => {
    const report = buildScorecard(
      [decision({ prNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', verdict: 'APPROVE' })],
      [pr({ prNumber: 1 })],
      [],
    );
    const text = formatApproverScorecard(report);
    expect(text).toContain('o/r#1');
    expect(text).toContain('general');
    expect(text).toContain('merged-as-is');
    expect(text).toContain('1/30');
  });
});
