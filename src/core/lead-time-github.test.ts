import { describe, expect, it } from 'vitest';
import { fetchLeadTimes, fetchPrLeadTime, leadTimeRollupForPrUrls, parsePrUrl, prNumbersForRepo } from './lead-time-github.js';
import type { GhRunner } from '../tasks/github.js';

describe('parsePrUrl', () => {
  it('extracts owner/repo and the PR number from a github.com PR URL', () => {
    expect(parsePrUrl('https://github.com/acme/widgets/pull/845')).toEqual({ repoSlug: 'acme/widgets', number: 845 });
  });

  it('returns undefined for a non-PR URL', () => {
    expect(parsePrUrl('https://gitlab.com/acme/widgets/-/merge_requests/1')).toBeUndefined();
    expect(parsePrUrl('not a url')).toBeUndefined();
  });
});

describe('prNumbersForRepo', () => {
  it('dedupes and filters to the given repo, case-insensitively', () => {
    const urls = [
      'https://github.com/acme/widgets/pull/1',
      'https://github.com/acme/widgets/pull/2',
      'https://github.com/acme/widgets/pull/1',
      'https://github.com/ACME/Widgets/pull/3',
      'https://github.com/other/repo/pull/9',
    ];
    expect(prNumbersForRepo(urls, 'acme/widgets')).toEqual([1, 2, 3]);
  });
});

function ghStub(responses: Record<string, string>): GhRunner {
  return async (args: string[]): Promise<string> => {
    const key = args.join(' ');
    const match = Object.entries(responses).find(([k]) => key.includes(k));
    if (match === undefined) throw new Error(`unexpected gh call: ${key}`);
    return match[1];
  };
}

describe('fetchPrLeadTime', () => {
  it('combines the PR view with both timelines into one lead-time record', async () => {
    const gh = ghStub({
      'pr view 845': JSON.stringify({
        number: 845,
        createdAt: '2026-11-10T14:18:30Z',
        mergedAt: '2026-11-10T19:47:02Z',
        closingIssuesReferences: [{ number: 842 }],
      }),
      'issues/842/timeline': JSON.stringify([
        [{ event: 'labeled', created_at: '2026-11-10T14:05:47Z', label: { name: 'ready for agent' } }],
      ]),
      'issues/845/timeline': JSON.stringify([
        [
          { event: 'labeled', created_at: '2026-11-10T16:05:21Z', label: { name: 'needs revision' } },
          { event: 'merged', created_at: '2026-11-10T19:47:02Z' },
        ],
      ]),
    });
    const result = await fetchPrLeadTime('acme/widgets', 845, {}, gh);
    expect(result).toEqual({
      issueRef: 'acme/widgets#842',
      prNumber: 845,
      labeledAt: '2026-11-10T14:05:47Z',
      prOpenedAt: '2026-11-10T14:18:30Z',
      mergedAt: '2026-11-10T19:47:02Z',
      labelToPrMs: 763_000,
      prToMergeMs: 19_712_000,
      reviseRounds: 1,
      firstTry: false,
    });
  });

  it('returns undefined when the PR closes no issue', async () => {
    const gh = ghStub({
      'pr view 7': JSON.stringify({ number: 7, createdAt: '2026-01-01T00:00:00Z', closingIssuesReferences: [] }),
    });
    expect(await fetchPrLeadTime('acme/widgets', 7, {}, gh)).toBeUndefined();
  });
});

describe('fetchLeadTimes', () => {
  it('drops a PR whose fetch throws instead of failing the whole batch', async () => {
    const gh: GhRunner = async (args: string[]): Promise<string> => {
      if (args.includes('1')) throw new Error('boom');
      if (args[0] === 'pr') return JSON.stringify({ number: 2, createdAt: '2026-01-01T00:00:00Z', closingIssuesReferences: [] });
      return JSON.stringify([]);
    };
    expect(await fetchLeadTimes('acme/widgets', [1, 2], {}, gh)).toEqual([]);
  });
});

describe('leadTimeRollupForPrUrls', () => {
  it('filters PR urls to the repo, fetches, and rolls up', async () => {
    const gh = ghStub({
      'pr view 845': JSON.stringify({
        number: 845,
        createdAt: '2026-11-10T14:18:30Z',
        mergedAt: '2026-11-10T19:47:02Z',
        closingIssuesReferences: [{ number: 842 }],
      }),
      'issues/842/timeline': JSON.stringify([[{ event: 'labeled', created_at: '2026-11-10T14:05:47Z', label: { name: 'ready for agent' } }]]),
      'issues/845/timeline': JSON.stringify([[{ event: 'merged', created_at: '2026-11-10T19:47:02Z' }]]),
    });
    const rollup = await leadTimeRollupForPrUrls(
      'acme/widgets',
      ['https://github.com/acme/widgets/pull/845', 'https://github.com/other/repo/pull/1'],
      {},
      gh,
    );
    expect(rollup.items).toHaveLength(1);
    expect(rollup.firstTryRate).toBe(1);
  });
});
