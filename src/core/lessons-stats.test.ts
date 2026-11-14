import { describe, it, expect } from 'vitest';
import { aggregateLessons, fetchFirstPass, firstPassOf, formatLessonsStats } from './lessons-stats.js';
import { parseMetrics } from './stats.js';
import type { MetricRecord } from './stats.js';

const rec = (over: Partial<MetricRecord>): MetricRecord => ({ taskId: 't', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, durationMs: 0, ...over });
const PR = (n: number): string => `https://github.com/o/r/pull/${n}`;

describe('parseMetrics lessons fields', () => {
  it('reads lessonsLoaded and lessonIds, and old records without them read as before', () => {
    const text = [
      JSON.stringify({ evt: 'run_complete', taskId: 'a', lessonsLoaded: 2, lessonIds: ['x', 'y'] }),
      JSON.stringify({ evt: 'run_complete', taskId: 'b' }),
    ].join('\n');
    const [a, b] = parseMetrics(text);
    expect(a).toMatchObject({ lessonsLoaded: 2, lessonIds: ['x', 'y'] });
    expect(b).not.toHaveProperty('lessonsLoaded');
    expect(b).not.toHaveProperty('lessonIds');
  });
});

describe('aggregateLessons', () => {
  it('counts runs once across stages and splits the first-pass rate by lessons loaded', () => {
    const records = [
      rec({ taskId: 'a', ts: '1', stage: 'implementer', lessonsLoaded: 2, prUrl: PR(1) }),
      rec({ taskId: 'a', ts: '1', stage: 'reviewer', lessonsLoaded: 2, prUrl: PR(1) }),
      rec({ taskId: 'b', ts: '2', stage: 'implementer', lessonsLoaded: 0, prUrl: PR(2) }),
      rec({ taskId: 'c', ts: '3', stage: 'implementer', lessonsLoaded: 0, prUrl: PR(3) }),
      rec({ taskId: 'old', ts: '4', stage: 'implementer', prUrl: PR(4) }),
    ];
    const r = aggregateLessons(records, new Map([[PR(1), true], [PR(2), false], [PR(3), true], [PR(4), true]]));
    expect(r).toMatchObject({ runs: 3, runsWithLessons: 1, avgLessonsPerRun: 0.67 });
    expect(r.firstPass.all).toMatchObject({ prs: 4, passed: 3, rate: 0.75 });
    expect(r.firstPass.withLessons).toMatchObject({ prs: 1, passed: 1, rate: 1 });
    expect(r.firstPass.without).toMatchObject({ prs: 2, passed: 1, rate: 0.5 });
  });

  it('says "no data" instead of 0 without first-pass data or lesson fields', () => {
    const out = formatLessonsStats(aggregateLessons([rec({ prUrl: PR(1) })]));
    expect(out).toContain('runs with lessons      no data');
    expect(out).toContain('avg lessons per run    no data');
    expect(out).toContain('first-pass rate        no data');
    expect(out).toContain('lessons loaded       no data');
    expect(out).not.toMatch(/\b0%/);
  });

  it('prints the rates and counts', () => {
    const out = formatLessonsStats(aggregateLessons([rec({ ts: '1', lessonsLoaded: 3, prUrl: PR(1) })], new Map([[PR(1), false]])));
    expect(out).toContain('runs with lessons      1 of 1');
    expect(out).toContain('avg lessons per run    3');
    expect(out).toContain('first-pass rate        0% (0/1 PRs)');
    expect(out).toContain('none                 no data');
  });
});

describe('firstPassOf', () => {
  const trusted = { author: { login: 'bot' }, authorAssociation: 'MEMBER' };
  it('uses the earliest trusted verdict', () => {
    expect(
      firstPassOf({
        comments: [
          { ...trusted, body: '## Review\nVerdict: NO BLOCKING FINDINGS', createdAt: '2026-01-02' },
          { ...trusted, body: '## Review\nVerdict: BLOCKING', createdAt: '2026-01-01' },
        ],
      }),
    ).toBe(false);
  });
  it('treats CHANGES_REQUESTED as blocking, ignores untrusted authors, and is undefined without a verdict', () => {
    expect(firstPassOf({ reviews: [{ ...trusted, state: 'CHANGES_REQUESTED', body: '', submittedAt: '1' }] })).toBe(false);
    expect(firstPassOf({ comments: [{ author: { login: 'x' }, authorAssociation: 'NONE', body: 'Verdict: BLOCKING', createdAt: '1' }] })).toBeUndefined();
    expect(firstPassOf({ comments: [{ ...trusted, body: 'looks fine', createdAt: '1' }] })).toBeUndefined();
  });
});

describe('fetchFirstPass', () => {
  it('maps PR urls of the repo to the outcome and skips other repos, failures and PRs without a verdict', async () => {
    const gh = async (args: string[]): Promise<string> => {
      const n = args[2];
      if (n === '2') throw new Error('gone');
      if (n === '3') return JSON.stringify({ comments: [] });
      return JSON.stringify({ comments: [{ author: { login: 'bot' }, authorAssociation: 'MEMBER', body: 'Verdict: NO BLOCKING FINDINGS', createdAt: '1' }] });
    };
    const out = await fetchFirstPass('o/r', [PR(1), PR(2), PR(3), 'https://github.com/x/y/pull/9'], gh);
    expect([...out]).toEqual([[PR(1), true]]);
  });
});
