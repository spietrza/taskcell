import { describe, it, expect } from 'vitest';
import type { GhRunner } from '../tasks/github.js';
import { fetchFactoryPrs, fetchReverts, collectApproverScorecard } from './outcome.js';

interface Stub {
  prs?: unknown[];
  commits?: unknown[];
}

function makeGh(stub: Stub, calls: string[][] = []): GhRunner {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(stub.prs ?? []);
    if (args[0] === 'api' && args[1] === '--paginate') return JSON.stringify([stub.commits ?? []]);
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

describe('fetchFactoryPrs', () => {
  it('keeps only same-repo chore/vanguard-* PRs, shaping the fields the scorecard needs', async () => {
    const gh = makeGh({
      prs: [
        { number: 1, headRefName: 'chore/vanguard-1-abc', state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'h1', mergeCommit: { oid: 'm1' } },
        { number: 2, headRefName: 'feature/human', state: 'OPEN' },
      ],
    });
    const prs = await fetchFactoryPrs('o/r', gh);
    expect(prs).toEqual([
      { repo: 'o/r', prNumber: 1, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', finalHeadSha: 'h1', mergeCommitSha: 'm1' },
    ]);
  });

  it('defaults missing optional fields to null rather than throwing', async () => {
    const gh = makeGh({ prs: [{ number: 3, headRefName: 'chore/vanguard-3-x', state: 'OPEN' }] });
    const [pr] = await fetchFactoryPrs('o/r', gh);
    expect(pr).toMatchObject({ mergedAt: null, finalHeadSha: null, mergeCommitSha: null });
  });
});

describe('fetchReverts', () => {
  it('extracts the target SHA and commit date from a revert commit, skipping unrelated ones', async () => {
    const gh = makeGh({
      commits: [
        { commit: { message: 'Revert "feat: thing"\n\nThis reverts commit abcdef1234567890.', committer: { date: '2026-01-02T00:00:00Z' } } },
        { commit: { message: 'feat: unrelated change', committer: { date: '2026-01-02T00:00:00Z' } } },
      ],
    });
    const reverts = await fetchReverts('o/r', '2026-01-01', gh);
    expect(reverts).toEqual([{ repo: 'o/r', targetSha: 'abcdef1234567890', revertedAt: '2026-01-02T00:00:00Z' }]);
  });

  it('falls back to the author date when no committer date is present', async () => {
    const gh = makeGh({
      commits: [{ commit: { message: 'Revert "x"\n\nThis reverts commit 1234567.', author: { date: '2026-01-05T00:00:00Z' } } }],
    });
    const [revert] = await fetchReverts('o/r', '2026-01-01', gh);
    expect(revert).toEqual({ repo: 'o/r', targetSha: '1234567', revertedAt: '2026-01-05T00:00:00Z' });
  });
});

describe('collectApproverScorecard', () => {
  it('fetches factory PRs and reverts per repo named in the decisions, then builds the report', async () => {
    const calls: string[][] = [];
    const gh = makeGh(
      {
        prs: [{ number: 1, headRefName: 'chore/vanguard-1-abc', state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', headRefOid: 'h1', mergeCommit: { oid: 'm1' } }],
        commits: [],
      },
      calls,
    );
    const report = await collectApproverScorecard(
      [{ repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], headSha: 'h1', timestamp: '2026-01-01T00:00:00Z' }],
      { gh },
    );
    expect(report.byRiskClass).toEqual([
      { riskClass: 'general', approveTotal: 1, approveCorrect: 1, escalateTotal: 0, escalateMergedUnchanged: 0, streak: 1 },
    ]);
    // one pr list + one commits scan for the single repo
    expect(calls.filter((c) => c[0] === 'pr')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'api')).toHaveLength(1);
  });

  it('makes no gh calls at all when there are no decisions', async () => {
    const calls: string[][] = [];
    const gh = makeGh({ prs: [] }, calls);
    const report = await collectApproverScorecard([], { gh });
    expect(report.rows).toEqual([]);
    expect(calls).toEqual([]);
  });
});
