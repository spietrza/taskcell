import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeIssueLeadTime, countLabelEvents, earliestLabelAt, rollupLeadTimes, formatLeadTime } from './lead-time.js';
import type { IssueLeadTime, TimelineEvent } from './lead-time.js';

/** A recorded GitHub timeline for one issue + its PR (two revise rounds, then merged). */
const fixture = JSON.parse(readFileSync(new URL('./lead-time.fixture.json', import.meta.url), 'utf8')) as {
  issueRef: string;
  issueTimeline: TimelineEvent[];
  pr: { number: number; createdAt: string; mergedAt: string };
  prTimeline: TimelineEvent[];
};

describe('earliestLabelAt', () => {
  it('finds the earliest matching label event, ignoring other labels', () => {
    const at = earliestLabelAt(fixture.issueTimeline, new Set(['ready for agent']));
    expect(at).toBe('2026-11-10T14:05:47Z');
  });

  it('returns undefined when no event matches', () => {
    expect(earliestLabelAt(fixture.issueTimeline, new Set(['ready for spec']))).toBeUndefined();
  });
});

describe('countLabelEvents', () => {
  it('counts every labeled event for the name, not unlabeled ones', () => {
    expect(countLabelEvents(fixture.prTimeline, 'needs revision')).toBe(2);
  });

  it('counts a label applied under its legacy spelling', () => {
    const labeled = (name: string): TimelineEvent => ({ event: 'labeled', created_at: '2026-01-01T00:00:00Z', label: { name } });
    expect(countLabelEvents([labeled('vanguard:revising'), labeled('taskcell:revising'), labeled('bug')], 'taskcell:revising')).toBe(2);
  });

  it('is 0 for a label that never appears', () => {
    expect(countLabelEvents(fixture.prTimeline, 'nonexistent')).toBe(0);
  });
});

describe('computeIssueLeadTime (recorded fixture)', () => {
  it('derives label->PR, PR->merge and revise rounds from the recorded timeline', () => {
    const result = computeIssueLeadTime({
      issueRef: fixture.issueRef,
      issueTimeline: fixture.issueTimeline,
      pr: fixture.pr,
      prTimeline: fixture.prTimeline,
    });
    expect(result).toEqual({
      issueRef: 'acme/widgets#842',
      prNumber: 845,
      labeledAt: '2026-11-10T14:05:47Z',
      prOpenedAt: '2026-11-10T14:18:30Z',
      mergedAt: '2026-11-10T19:47:02Z',
      labelToPrMs: 763_000, // 14:05:47 -> 14:18:30 = 12m43s
      prToMergeMs: 19_712_000, // 14:18:30 -> 19:47:02 = 5h28m32s
      reviseRounds: 2,
      firstTry: false,
    });
  });

  it('is first-try when merged with no revise-label events', () => {
    const result = computeIssueLeadTime({
      issueRef: 'acme/widgets#900',
      issueTimeline: fixture.issueTimeline,
      pr: { number: 901, createdAt: '2026-11-11T09:00:00Z', mergedAt: '2026-11-11T09:40:00Z' },
      prTimeline: [{ event: 'merged', created_at: '2026-11-11T09:40:00Z' }],
    });
    expect(result.reviseRounds).toBe(0);
    expect(result.firstTry).toBe(true);
  });

  it('leaves merge-dependent fields undefined for a PR still open', () => {
    const result = computeIssueLeadTime({
      issueRef: 'acme/widgets#901',
      issueTimeline: fixture.issueTimeline,
      pr: { number: 902, createdAt: '2026-11-11T09:00:00Z', mergedAt: null },
      prTimeline: [],
    });
    expect(result.mergedAt).toBeUndefined();
    expect(result.prToMergeMs).toBeUndefined();
    expect(result.firstTry).toBe(false);
  });

  it('leaves label-dependent fields undefined when the trigger label was never seen (e.g. a manually filed PR)', () => {
    const result = computeIssueLeadTime({
      issueRef: 'acme/widgets#902',
      issueTimeline: [],
      pr: fixture.pr,
      prTimeline: fixture.prTimeline,
    });
    expect(result.labeledAt).toBeUndefined();
    expect(result.labelToPrMs).toBeUndefined();
  });
});

describe('rollupLeadTimes', () => {
  function item(overrides: Partial<IssueLeadTime>): IssueLeadTime {
    return { issueRef: 'x', reviseRounds: 0, firstTry: false, ...overrides };
  }

  it('computes medians and the first-try rate over merged items only', () => {
    const items = [
      item({ labelToPrMs: 1000, prToMergeMs: 2000, reviseRounds: 0, firstTry: true, mergedAt: 'a' }),
      item({ labelToPrMs: 3000, prToMergeMs: 6000, reviseRounds: 1, firstTry: false, mergedAt: 'b' }),
      item({ labelToPrMs: 2000, prToMergeMs: 4000, reviseRounds: 2, firstTry: false, mergedAt: 'c' }),
      item({ reviseRounds: 0, firstTry: false }), // not merged yet: excluded from firstTryRate, counted in medianReviseRounds
    ];
    const rollup = rollupLeadTimes(items);
    expect(rollup.medianLabelToPrMs).toBe(2000);
    expect(rollup.medianPrToMergeMs).toBe(4000);
    expect(rollup.medianReviseRounds).toBe(0.5);
    expect(rollup.firstTryRate).toBeCloseTo(1 / 3);
  });

  it('omits every summary field for an empty set', () => {
    expect(rollupLeadTimes([])).toEqual({ items: [] });
  });
});

describe('lead time guards and formatting', () => {
  it('drops a negative span (label applied after the PR opened)', () => {
    const item = computeIssueLeadTime({
      issueRef: 'a/b#1',
      issueTimeline: [{ event: 'labeled', label: { name: 'ready for agent' }, created_at: '2026-01-02T00:00:00Z' }],
      pr: { number: 2, createdAt: '2026-01-01T00:00:00Z' },
    });
    expect(item.labelToPrMs).toBeUndefined();
  });

  it('prints medians and warns about failed lookups', () => {
    const text = formatLeadTime({ items: [], medianLabelToPrMs: 7_200_000, firstTryRate: 0.5, failedPrs: 2 });
    expect(text).toContain('median label -> PR     2.0 h');
    expect(text).toContain('first-try merge rate   50%');
    expect(text).toContain('2 PR lookup(s) failed');
  });
});
