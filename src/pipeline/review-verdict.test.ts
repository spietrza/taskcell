import { describe, expect, it } from 'vitest';
import { hasBlockingFinding } from '../runners/review-prompt.js';
import { reviewVerdictLine, reviewVerdictOf } from './review-verdict.js';

function findingsBlock(items: { severity: string; kind: string; title: string; evidence: string }[]): string {
  return `<findings>${JSON.stringify({ findings: items })}</findings>`;
}

describe('reviewVerdictOf', () => {
  it('T1: changes for a high/critical finding, pass for explicitly clean low/medium replies; round-trips the shape', () => {
    const high = reviewVerdictOf(
      `Verdict: BLOCKING\n${findingsBlock([{ severity: 'high', kind: 'correctness', title: 'bad', evidence: 'diff line' }])}`,
    );
    expect(high.verdict).toBe('changes');
    expect(high.findings).toEqual([{ severity: 'high', kind: 'correctness', title: 'bad', evidence: 'diff line' }]);

    const low = reviewVerdictOf(
      `No blocking issues.\n${findingsBlock([{ severity: 'low', kind: 'style', title: 'nit', evidence: 'x' }])}`,
    );
    expect(low.verdict).toBe('pass');
    expect(low.findings).toEqual([{ severity: 'low', kind: 'style', title: 'nit', evidence: 'x' }]);
    expect(reviewVerdictOf(`No blocking issues.\n${findingsBlock([{ severity: 'medium', kind: 'correctness', title: 'minor', evidence: 'x' }])}`).verdict).toBe('pass');
  });

  it('T2: no <findings> block — prose keyword drives verdict, findings always []; malformed JSON never throws', () => {
    const blockingProse = reviewVerdictOf('Verdict: BLOCKING\nThis has a critical issue.');
    expect(blockingProse).toEqual({ verdict: 'changes', findings: [] });

    const cleanProse = reviewVerdictOf('No blocking issues.\n<promise>COMPLETE</promise>');
    expect(cleanProse).toEqual({ verdict: 'pass', findings: [] });

    const malformed = reviewVerdictOf('No blocking issues.\n<findings>{not json</findings>');
    expect(malformed).toEqual({ verdict: 'pass', findings: [] });
  });

  it.each([
    '',
    '   ',
    'Review unavailable: no diff was supplied',
    'Verdict: NO BLOCKING FINDINGS\nLooks fine.',
    '<findings>{not json</findings>',
    'No blocking issues',
    '> No blocking issues.',
    'No blocking issues. Still reviewing.',
  ])('marks an empty, aborted or unavailable reply as incomplete: %j', (text) => {
    expect(reviewVerdictOf(text)).toEqual({ verdict: 'incomplete', findings: [] });
  });

  it('blocking findings take precedence over the clean line', () => {
    expect(reviewVerdictOf(`No blocking issues.\n${findingsBlock([{ severity: 'high', kind: 'correctness', title: 'bad', evidence: 'x' }])}`).verdict).toBe('changes');
  });

  it('T3: verdict === "changes" iff hasBlockingFinding(text), including a self-contradicting reply', () => {
    const table = [
      'Verdict: NO BLOCKING FINDINGS\nAll good.',
      'Verdict: BLOCKING\nSomething is wrong.',
      `No blocking issues.\n${findingsBlock([{ severity: 'critical', kind: 'security', title: 'leak', evidence: 'x' }])}`,
      'Verdict: BLOCKING\nThis has a high-severity bug.',
      'Verdict: NO BLOCKING FINDINGS\nNo issues found.',
    ];
    for (const text of table) {
      expect(reviewVerdictOf(text).verdict === 'changes').toBe(hasBlockingFinding(text));
    }
  });
});

describe('reviewVerdictLine', () => {
  it('T4: renders PASS/CHANGES with singular/plural finding counts', () => {
    expect(reviewVerdictLine({ verdict: 'incomplete', findings: [] })).toBe('Review: INCOMPLETE (0 findings)');
    expect(reviewVerdictLine({ verdict: 'pass', findings: [] })).toBe('Review: PASS (0 findings)');
    expect(
      reviewVerdictLine({
        verdict: 'changes',
        findings: [
          { severity: 'high', kind: 'correctness', title: 'a', evidence: 'x' },
          { severity: 'high', kind: 'correctness', title: 'b', evidence: 'y' },
          { severity: 'high', kind: 'correctness', title: 'c', evidence: 'z' },
        ],
      }),
    ).toBe('Review: CHANGES (3 findings)');
    expect(reviewVerdictLine({ verdict: 'changes', findings: [{ severity: 'high', kind: 'correctness', title: 'a', evidence: 'x' }] })).toBe(
      'Review: CHANGES (1 finding)',
    );
  });
});
