import { describe, it, expect, vi } from 'vitest';
import { editPullRequestLabels, githubPullRequestWatchPrimitives, watchPullRequestsOnce } from './pr-watch.js';
import { UsageCapError } from '../core/usage-cap.js';
import {
  PullRequestReviewIncompleteError,
  buildPullRequestReviewIncompleteComment,
  pullRequestReviewIncompleteHeadMarker,
} from './pr-review.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestWatchItem, PullRequestWatchPrimitives } from './pr-watch.js';

function pr(number: number): PullRequestWatchItem {
  return {
    repoSlug: 'o/r',
    number,
    title: `PR ${number}`,
    isDraft: false,
    author: 'alice',
    headRefOid: `sha-${number}`,
    labels: ['ready for taskcell review'],
  };
}

/** The REST issue lookup behind the PR-author gate: a MEMBER author unless a test says otherwise. */
function trustedAuthorApi(args: string[], association = 'MEMBER'): string {
  return args[0] === 'api' ? JSON.stringify({ user: { login: 'alice' }, author_association: association }) : '';
}

/** Taskcell's own review identity, as gh reports it. */
const BOT = { author: { login: 'github-actions' }, authorAssociation: 'CONTRIBUTOR' };

describe('githubPullRequestWatchPrimitives', () => {
  it('lists only non-draft, human-authored PRs that still carry the trigger label', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'aaa',
            labels: [{ name: 'ready for taskcell review' }],
          },
          {
            number: 13,
            title: 'Draft',
            isDraft: true,
            author: { login: 'bob' },
            headRefOid: 'bbb',
            labels: [{ name: 'ready for taskcell review' }],
          },
          {
            number: 14,
            title: 'Bot',
            isDraft: false,
            author: { login: 'github-actions[bot]' },
            headRefOid: 'ccc',
            labels: [{ name: 'ready for taskcell review' }],
          },
          {
            number: 15,
            title: 'Already claimed',
            isDraft: false,
            author: { login: 'carol' },
            headRefOid: 'ddd',
            labels: [{ name: 'taskcell:reviewing' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ comments: [], reviews: [] });
      }
      return trustedAuthorApi(args);
    };

    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'o/r',
      '--state',
      'open',
      '--label',
      'ready for taskcell review',
      '--limit',
      '100',
      '--json',
      'number,title,isDraft,author,headRefOid,labels',
    ]);
  });

  it('reviews only the configured author and skips PRs opened by others', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        // The mocked gh ignores --author, so the client-side filter must drop mallory's PR.
        return JSON.stringify([
          {
            number: 20,
            title: 'Mine',
            isDraft: false,
            author: { login: 'SebaBoler' },
            headRefOid: 'm1',
            labels: [{ name: 'ready for taskcell review' }],
          },
          {
            number: 21,
            title: 'Theirs',
            isDraft: false,
            author: { login: 'mallory' },
            headRefOid: 't1',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      author: 'SebaBoler',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([20]);
    // The filter is also pushed down to gh for a smaller payload.
    expect(calls[0]).toContain('--author');
    expect(calls[0]).toContain('SebaBoler');
  });

  it('skips a PR when Taskcell already reviewed the same head commit', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          comments: [{ body: 'Older note.' }],
          reviews: [{ ...BOT, body: '## Taskcell Review\n\nNo blocking findings.\n\n<!-- taskcell-pr-review: abc123 -->' }],
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(calls[2]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'comments,reviews']);
  });

  it('skips a PR when the matching review marker appears after an older marker', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          comments: [],
          reviews: [
            {
              ...BOT,
              body: [
                '## Taskcell Review',
                '',
                '<!-- taskcell-pr-review: deadbeef -->',
                '',
                'Current review body.',
                '',
                '<!-- taskcell-pr-review: abc123 -->',
              ].join('\n'),
            },
          ],
        });
      }
      return trustedAuthorApi(args);
    };

    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(calls[2]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'comments,reviews']);
  });

  it('keeps a PR ready when the per-PR dedupe lookup fails', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') throw new Error('temporary gh failure');
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(calls[2]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'comments,reviews']);
  });

  it('claims, marks reviewed, and restores labels through gh pr edit (removing the legacy spelling a PR still carries)', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ labels: [{ name: 'ready for vanguard review' }, { name: 'taskcell:reviewing' }] });
      return args[1] === 'list' ? '[]' : '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const item = pr(12);

    await primitives.claim(item);
    await primitives.markReviewed(item);
    await primitives.onFailure(item, new Error('boom'));

    expect(calls.filter((c) => c[1] === 'edit')).toEqual([
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'ready for vanguard review', '--add-label', 'taskcell:reviewing'],
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'taskcell:reviewing', '--add-label', 'taskcell:reviewed'],
      // The repo has neither spelling of the trigger: it is restored under the new name, created first.
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'taskcell:reviewing', '--add-label', 'ready for taskcell review'],
    ]);
  });

  it('stops restoring the trigger label after three incomplete attempts on the same head', async () => {
    const calls: string[][] = [];
    const headRefOid = 'abc123';
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'comments,reviews') {
        return JSON.stringify({
          comments: [],
          // The notice review-pr posts for a reply with no opening verdict line (e.g. a verdict after a preamble).
          reviews: Array.from({ length: 3 }, () => ({
            ...BOT,
            body: buildPullRequestReviewIncompleteComment('no-verdict', undefined, headRefOid),
          })),
        });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ labels: [{ name: 'taskcell:reviewing' }] });
      }
      return '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const item = { ...pr(12), headRefOid };
    const incomplete = new PullRequestReviewIncompleteError(
      {
        ...item,
        body: '',
        url: '',
        headRefName: 'branch',
        baseRefName: 'main',
        isCrossRepository: false,
        headRepositoryOwner: 'o',
        diff: '',
      },
      'incomplete',
    );

    await primitives.onFailure(item, incomplete);

    expect(calls.filter((args) => args[0] === 'pr' && args[1] === 'comment')).toHaveLength(1);
    expect(calls.find((args) => args[0] === 'pr' && args[1] === 'comment')?.at(-1)).toContain(
      'Remove and re-add the "ready for taskcell review" label to re-trigger the review.',
    );
    expect(calls.find((args) => args[0] === 'pr' && args[1] === 'edit')).not.toContain('--add-label');
  });

  it.each([
    ['leaves the trigger label off when the cap comment already exists', false, (): string => JSON.stringify({ comments: [{ ...BOT, body: 'stopped\n\n<!-- taskcell-pr-review-incomplete-cap: abc123 -->' }], reviews: [] })],
    ['restores the trigger label when the attempts cannot be counted', true, (): string => { throw new Error('HTTP 502'); }],
  ])('%s, without a cap comment', async (_n, restored, view) => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'comments,reviews') return view();
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ labels: [{ name: 'taskcell:reviewing' }] });
      return '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const item = { ...pr(12), headRefOid: 'abc123' };
    const incomplete = new PullRequestReviewIncompleteError(
      { ...item, body: '', url: '', headRefName: 'branch', baseRefName: 'main', isCrossRepository: false, headRepositoryOwner: 'o', diff: '' },
      'incomplete',
    );

    await primitives.onFailure(item, incomplete);

    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(false);
    const edit = calls.find((args) => args[0] === 'pr' && args[1] === 'edit');
    expect(edit).toContain('--remove-label');
    expect(edit?.includes('--add-label')).toBe(restored);
  });

  it('resets the incomplete-attempt cap for a new head', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'comments,reviews') {
        return JSON.stringify({
          comments: [],
          reviews: Array.from({ length: 3 }, () => ({
            ...BOT,
            body: pullRequestReviewIncompleteHeadMarker('old123'),
          })),
        });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ labels: [{ name: 'taskcell:reviewing' }] });
      }
      return '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const item = { ...pr(12), headRefOid: 'new123' };
    const incomplete = new PullRequestReviewIncompleteError(
      {
        ...item,
        body: '',
        url: '',
        headRefName: 'branch',
        baseRefName: 'main',
        isCrossRepository: false,
        headRepositoryOwner: 'o',
        diff: '',
      },
      'incomplete',
    );

    await primitives.onFailure(item, incomplete);

    const edit = calls.find((args) => args[0] === 'pr' && args[1] === 'edit');
    expect(edit).toContain('--add-label');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'comment')).toBe(false);
  });

  it('skips the edit and logs when the PR shows none of the labels to remove', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return args[1] === 'view' ? JSON.stringify({ labels: [] }) : '';
    };
    await editPullRequestLabels(gh, 'o/r', 12, { remove: ['taskcell:reviewing'] }, (line) => logs.push(line));
    expect(calls.some((c) => c[1] === 'edit')).toBe(false);
    expect(logs).toEqual([expect.stringContaining('taskcell:reviewing')]);
  });

  it('does not log a skipped removal of a label that is not in flight', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => (args[1] === 'view' ? JSON.stringify({ labels: [] }) : '');
    await editPullRequestLabels(gh, 'o/r', 12, { remove: ['taskcell:rate-limited', 'taskcell:reviewed'] }, (line) => logs.push(line));
    expect(logs).toEqual([]);
  });

  it('sends the skipped-removal line to the injected logger from claim, mark-reviewed and failure', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => (args[1] === 'view' ? JSON.stringify({ labels: [] }) : args[1] === 'list' ? '[]' : '');
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'taskcell:running',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
      log: (line) => logs.push(line),
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await primitives.claim(pr(12));
    await primitives.markReviewed(pr(12));
    await primitives.onFailure(pr(12), new Error('boom'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(logs).toEqual([
      expect.stringContaining('not removing taskcell:running'),
      expect.stringContaining('not removing taskcell:reviewing'),
      expect.stringContaining('not removing taskcell:reviewing'),
    ]);
  });

  it('creates a label on a failed label list only for the rate-limit hold, not for claim, mark-reviewed or restore', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'label' && args[1] === 'list') throw new Error('gh: 403');
      return args[1] === 'view' ? JSON.stringify({ labels: [{ name: 'ready for taskcell review' }, { name: 'taskcell:reviewing' }] }) : '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const creates = (): string[][] => calls.filter((c) => c[1] === 'create');

    await primitives.claim(pr(12));
    await primitives.markReviewed(pr(12));
    await primitives.onFailure(pr(12), new Error('boom'));
    expect(creates()).toEqual([]);

    await primitives.onFailure(pr(12), new UsageCapError('claude', 95, 90, new Date('2026-11-09T05:00:00Z')));
    expect(creates()).toEqual([['label', 'create', 'taskcell:rate-limited', '--repo', 'o/r', '--force']]);
  });

  it('logs why a scanned PR is skipped when its head is already reviewed', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ comments: [], reviews: [{ ...BOT, body: '<!-- taskcell-pr-review: abc123 -->' }] });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      log: (line) => logs.push(line),
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(logs).toContain('watch-prs o/r#12: skip -> head abc123 already reviewed');
  });

  it('with pinnedOnly reviews only the hinted PR and skips the label scan', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') throw new Error('no label scan expected');
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 316, title: 'Pinned', isDraft: false, author: { login: 'alice' }, headRefOid: 'abc123',
          labels: [{ name: 'ready for taskcell review' }], state: 'OPEN',
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      hintPr: 316,
      pinnedOnly: true,
      gh,
      reviewOne: async () => {},
    });

    expect((await primitives.listReady()).map((item) => item.number)).toEqual([316]);
    expect(calls.some((c) => c[0] === 'pr' && c[1] === 'list')).toBe(false);
    expect(primitives.takeListFailures?.()).toEqual([]);
  });

  it('with pinnedOnly a failed fetch of the pin is a list failure, not a green "0 ready"', async () => {
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') throw new Error('HTTP 502');
      return trustedAuthorApi(args);
    };
    const base = { repoSlug: 'o/r', label: 'ready for taskcell review', reviewingLabel: 'taskcell:reviewing', reviewedLabel: 'taskcell:reviewed', hintPr: 316, gh, reviewOne: async (): Promise<void> => {} };
    const pinned = githubPullRequestWatchPrimitives({ ...base, pinnedOnly: true });
    expect(await pinned.listReady()).toEqual([]);
    expect(pinned.takeListFailures?.()).toEqual(['o/r#316']);
  });

  it('pinnedOnly without a pin still scans by label', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return args[0] === 'pr' && args[1] === 'list' ? '[]' : trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r', label: 'ready for taskcell review', reviewingLabel: 'taskcell:reviewing', reviewedLabel: 'taskcell:reviewed',
      pinnedOnly: true, gh, reviewOne: async () => {},
    });
    expect(await primitives.listReady()).toEqual([]);
    expect(calls.some((c) => c[0] === 'pr' && c[1] === 'list')).toBe(true);
  });

  it('pins the hinted PR when the label scan misses it (eventually consistent search)', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 316,
          title: 'Re-labeled after a failed review',
          isDraft: false,
          author: { login: 'alice' },
          headRefOid: 'abc123',
          labels: [{ name: 'ready for taskcell review' }],
          state: 'OPEN',
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      hintPr: 316,
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([316]);
    expect(calls).toContainEqual([
      'pr',
      'view',
      '316',
      '--repo',
      'o/r',
      '--json',
      'number,title,isDraft,author,headRefOid,labels,state',
    ]);
  });

  it('reviews the hinted PR even when its head already carries a review marker', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Deliberately re-labeled',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ comments: [], reviews: [{ ...BOT, body: '<!-- taskcell-pr-review: abc123 -->' }] });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      hintPr: 12,
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    // The dedupe lookup is bypassed for the hinted PR — the re-label was deliberate.
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'view')).toBe(false);
  });

  it('skips the hinted PR when it is no longer open or lost the trigger label', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 316,
          title: 'Merged already',
          isDraft: false,
          author: { login: 'alice' },
          headRefOid: 'abc123',
          labels: [{ name: 'ready for taskcell review' }],
          state: 'MERGED',
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      hintPr: 316,
      log: (line) => logs.push(line),
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(logs).toContain('watch-prs o/r#316: hint skip -> state MERGED');
  });

  it('keeps the scan alive when the hint fetch fails', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for taskcell review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '99') throw new Error('boom');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      hintPr: 99,
      log: (line) => logs.push(line),
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(logs).toContain('watch-prs o/r#99: hint fetch failed -> boom');
  });
});

describe('githubPullRequestWatchPrimitives trust', () => {
  const listed = JSON.stringify([
    { number: 12, title: 'Fix', isDraft: false, author: { login: 'alice' }, headRefOid: 'abc123', labels: [{ name: 'ready for taskcell review' }] },
  ]);
  const primitivesFor = (gh: GhRunner, extra: { allowedAuthors?: string[]; log?: (line: string) => void; hintPr?: number; reviewOne?: () => Promise<void> } = {}): PullRequestWatchPrimitives =>
    githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      gh,
      reviewOne: async () => {},
      ...extra,
    });

  it('ignores a review marker posted by an untrusted commenter', async () => {
    const gh: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') {
        return JSON.stringify({
          comments: [{ author: { login: 'mallory' }, authorAssociation: 'NONE', body: '<!-- taskcell-pr-review: abc123 -->' }],
          reviews: [],
        });
      }
      return trustedAuthorApi(args);
    };
    const ready = await primitivesFor(gh).listReady();
    expect(ready.map((item) => item.number)).toEqual([12]);
  });

  it('skips a PR whose author is neither a repo member nor allowlisted', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args, 'CONTRIBUTOR');
    };
    await expect(primitivesFor(gh, { log: (line) => logs.push(line) }).listReady()).resolves.toEqual([]);
    expect(logs).toContain('watch-prs o/r#12: skip -> PR author @alice (CONTRIBUTOR) is not trusted');
  });

  it('reviews an allowlisted non-member author and fails closed when the author lookup fails', async () => {
    const ok: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args, 'NONE');
    };
    expect((await primitivesFor(ok, { allowedAuthors: ['Alice'] }).listReady()).map((item) => item.number)).toEqual([12]);
    const broken: GhRunner = async (args) => {
      if (args[0] === 'api') throw new Error('rate limited');
      return ok(args);
    };
    await expect(primitivesFor(broken, { allowedAuthors: ['alice'] }).listReady()).resolves.toEqual([]);
  });

  it('logs a failed author lookup as such and fails the run for the pinned PR', async () => {
    const broken: GhRunner = async (args) => {
      if (args[0] === 'api') throw new Error('rate limited');
      if (args[1] === 'list') return listed;
      return JSON.stringify({ comments: [], reviews: [] });
    };
    const logs: string[] = [];
    const unpinned = await watchPullRequestsOnce(primitivesFor(broken, { log: (line) => logs.push(line) }));
    expect(logs).toContain('watch-prs o/r#12: skip -> author lookup failed: rate limited');
    expect(logs.some((line) => line.includes('@?'))).toBe(false);
    expect(unpinned.failed).toEqual([]);

    const pinned = await watchPullRequestsOnce(primitivesFor(broken, { hintPr: 12 }));
    expect(pinned).toEqual({ reviewed: [], failed: ['o/r#12'], skipped: [], paused: [] });
  });

  it('a usage-cap pause is not a failed item, a real review failure is', async () => {
    const gh: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args);
    };
    const paused = await watchPullRequestsOnce(primitivesFor(gh, { reviewOne: async () => { throw new UsageCapError('claude', 95, 90, new Date('2026-11-09T05:00:00Z')); } }));
    expect(paused).toEqual({ reviewed: [], failed: [], skipped: [], paused: ['o/r#12'] });
    const failed = await watchPullRequestsOnce(primitivesFor(gh, { reviewOne: async () => { throw new Error('boom'); } }));
    expect(failed.failed).toEqual(['o/r#12']);
  });
});
