import { describe, it, expect, vi } from 'vitest';
import { GitHubTaskFetcher, linkPullRequest, fetchNativeBlockedBy, resolveGithubDependencyNode, checkGithubDependencies } from './github.js';
import { isTrustedComment } from './comment-trust.js';
import type { GhRunner } from './github.js';

function fakeGh(): GhRunner {
  const issue = { number: 7, title: 'Bug', body: 'desc', labels: [{ name: 'bug' }] };
  return async (args: string[]): Promise<string> =>
    args.includes('view') ? JSON.stringify(issue) : JSON.stringify([issue]);
}

describe('GitHubTaskFetcher', () => {
  it('maps an issue to a Task (id = repo#number)', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task).toEqual({ id: 'SebaBoler/vanguard#7', title: 'Bug', description: 'desc', labels: ['bug'], children: [], comments: [], ref: '7' }); // ref additive (S9)
  });

  it('accepts a repo#number reference', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('SebaBoler/vanguard#7');
    expect(task.id).toBe('SebaBoler/vanguard#7');
  });

  it('lists open issues', async () => {
    const list = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('SebaBoler/vanguard#7');
  });

  it('maps comments from the JSON response into Task.comments', async () => {
    const issueWithComments = {
      number: 7,
      title: 'Bug',
      body: 'desc',
      labels: [{ name: 'bug' }],
      comments: [
        { author: { login: 'alice' }, body: 'First comment', createdAt: '2024-01-01T00:00:00Z' },
        { author: { login: 'bob' }, body: 'Second comment', createdAt: '2024-01-02T00:00:00Z' },
      ],
    };
    const gh: GhRunner = async (): Promise<string> => JSON.stringify(issueWithComments);
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', gh).fetch('7');
    expect(task.comments).toEqual([
      { author: 'alice', authorAssociation: '', body: 'First comment' },
      { author: 'bob', authorAssociation: '', body: 'Second comment' },
    ]);
  });

  it('defaults comments to [] when the issue has no comments field', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task.comments).toEqual([]);
  });

  it('T19: fetch sources the issue author and comment association', async () => {
    const calls: string[][] = [];
    const fetcher = new GitHubTaskFetcher('o/r', async (args) => {
      calls.push(args);
      return JSON.stringify({ number: 1, title: '', body: '', labels: [], author: { login: 'reporter' },
        comments: [{ author: { login: 'maintainer' }, authorAssociation: 'OWNER', body: 'spec' }] });
    });
    const task = await fetcher.fetch('1');
    expect(task.author).toBe('reporter');
    expect(task.comments[0]?.authorAssociation).toBe('OWNER');
    expect(calls[0]?.at(-1)?.split(',')).toContain('author');
  });

  // GitHub always models an association, so a missing one fails closed (unlike GitLab, which models
  // none) — and the fetcher warns, since a future gh that drops the field would mute every human.
  it('fails closed and warns when gh returned no association at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const gh = async (): Promise<string> =>
        JSON.stringify({ number: 1, title: '', body: '', labels: [], comments: [{ author: { login: 'alice' }, body: 'hi' }] });
      const task = await new GitHubTaskFetcher('o/r', gh).fetch('1');
      expect(task.comments[0]?.authorAssociation).toBe('');
      expect(isTrustedComment(task.comments[0]!)).toBe(false);
      expect(warn.mock.calls[0]?.[0]).toContain('no authorAssociation');
      warn.mockClear();
      const withAssociation = async (): Promise<string> =>
        JSON.stringify({ number: 1, title: '', body: '', labels: [], comments: [{ author: { login: 'alice' }, authorAssociation: 'NONE', body: 'hi' }] });
      await new GitHubTaskFetcher('o/r', withAssociation).fetch('1');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('linkPullRequest', () => {
  it('comments the PR url onto the issue', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return '';
    };
    await linkPullRequest('SebaBoler/vanguard', 'SebaBoler/vanguard#7', 'https://example/pr/1', gh);
    expect(calls[0]).toEqual(expect.arrayContaining(['issue', 'comment', '7', '--repo', 'SebaBoler/vanguard']));
    expect(calls[0]?.join(' ')).toContain('https://example/pr/1');
  });
});

// S9: TaskFilter.limit is STRICTLY conditional — unset keeps watch's argv byte-identical.
it('list() argv is byte-identical to the pre-S9 shape when limit is unset (watch contract)', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return '[]';
  };
  await new GitHubTaskFetcher('o/r', gh).list({ state: 'open', labels: ['x'] });
  expect(calls[0]).toEqual(['issue', 'list', '--repo', 'o/r', '--json', 'number,title,body,labels', '--state', 'open', '--label', 'x']);
});

it('list() with limit adds -L and the state field to --json (the board call)', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return JSON.stringify([{ number: 9, title: 't', body: null, labels: [], state: 'closed' }]);
  };
  const tasks = await new GitHubTaskFetcher('o/r', gh).list({ state: 'all', limit: 50 });
  expect(calls[0]).toEqual(['issue', 'list', '--repo', 'o/r', '--json', 'number,title,body,labels,state', '--state', 'all', '-L', '50']);
  expect(tasks[0]).toMatchObject({ ref: '9', state: 'closed' });
});

import { githubDefaultBranch } from './github.js';
import { VanguardError } from '../core/errors.js';
describe('githubDefaultBranch', () => {
  it('reads the API default branch with the exact argv', async () => {
    const calls: string[][] = [];
    expect(await githubDefaultBranch('o/r', async (args) => { calls.push(args); return JSON.stringify({ defaultBranchRef: { name: 'main' } }); })).toBe('main');
    expect(calls).toEqual([['repo', 'view', 'o/r', '--json', 'defaultBranchRef']]);
  });
  it.each([{}, { defaultBranchRef: null }, { defaultBranchRef: { name: '' } }])('fails closed on %j', async (data) => {
    await expect(githubDefaultBranch('o/r', async () => JSON.stringify(data))).rejects.toThrow(VanguardError);
  });
});

// #760: task dependencies (native "blocked by" + `Depends on #N` body fallback).
describe('GitHubTaskFetcher — dependencies (#760)', () => {
  it('fetch() parses a body "Depends on" line into Task.dependsOn', async () => {
    const gh: GhRunner = async () => JSON.stringify({ number: 1, title: 't', body: 'Depends on #5\n\nDetails.', labels: [] });
    const task = await new GitHubTaskFetcher('o/r', gh).fetch('1');
    expect(task.dependsOn).toEqual([{ number: '5' }]);
  });

  it('fetch() parses a body "Start:" line into Task.startDate', async () => {
    const gh: GhRunner = async () => JSON.stringify({ number: 1, title: 't', body: 'Start: 2026-06-01', labels: [] });
    const task = await new GitHubTaskFetcher('o/r', gh).fetch('1');
    expect(task.startDate).toBe('2026-06-01');
  });

  it('fetch() omits dependsOn/startDate when the body has neither (unchanged behaviour)', async () => {
    const task = await new GitHubTaskFetcher('o/r', fakeGh()).fetch('7');
    expect(task.dependsOn).toBeUndefined();
    expect(task.startDate).toBeUndefined();
  });
});

describe('fetchNativeBlockedBy', () => {
  it('maps native blocked-by items, qualifying every ref with its own repo', async () => {
    const gh: GhRunner = async (args) => {
      expect(args).toEqual(['api', 'repos/me/app/issues/5/dependencies/blocked_by']);
      return JSON.stringify([
        { number: 7, repository: { full_name: 'me/app' } },
        { number: 9, repository: { full_name: 'other/lib' } },
      ]);
    };
    expect(await fetchNativeBlockedBy('me/app', '5', gh)).toEqual([
      { repo: 'me/app', number: '7' },
      { repo: 'other/lib', number: '9' },
    ]);
  });

  it('qualifies with the queried repo when the API omits `repository`', async () => {
    const gh: GhRunner = async () => JSON.stringify([{ number: 7 }]);
    expect(await fetchNativeBlockedBy('me/app', '5', gh)).toEqual([{ repo: 'me/app', number: '7' }]);
  });

  it('returns [] on a 404 (feature unavailable on this host, or no blockers)', async () => {
    const gh: GhRunner = async () => { throw new Error('HTTP 404: Not Found (https://api.github.com/...)'); };
    expect(await fetchNativeBlockedBy('me/app', '5', gh)).toEqual([]);
  });

  it('propagates a non-404 error instead of silently reporting "no blockers"', async () => {
    const gh: GhRunner = async () => { throw new Error('HTTP 502: Bad Gateway'); };
    await expect(fetchNativeBlockedBy('me/app', '5', gh)).rejects.toThrow('HTTP 502');
  });
});

describe('resolveGithubDependencyNode', () => {
  /** Routes a fake `gh` call to either the issue body or its blocked_by sub-resource. */
  function ghWith(routes: { issue?: Record<string, unknown> | Error; blockedBy?: unknown[] | Error }): GhRunner {
    return async (args) => {
      const path = args[1] ?? '';
      if (path.includes('dependencies/blocked_by')) {
        if (routes.blockedBy instanceof Error) throw routes.blockedBy;
        return JSON.stringify(routes.blockedBy ?? []);
      }
      if (args[0] === 'api') {
        if (routes.issue instanceof Error) throw routes.issue;
        return JSON.stringify(routes.issue ?? {});
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  it('is met when the issue is closed as completed', async () => {
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', ghWith({ issue: { state: 'closed', state_reason: 'completed' } }));
    expect(node).toEqual({ met: true, dependsOn: [] });
  });

  it('is not met when the issue is closed as not_planned', async () => {
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', ghWith({ issue: { state: 'closed', state_reason: 'not_planned' } }));
    expect(node.met).toBe(false);
  });

  it('is met when the issue is closed with no state_reason (null)', async () => {
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', ghWith({ issue: { state: 'closed', state_reason: null } }));
    expect(node.met).toBe(true);
  });

  it('is not met while the issue is still open', async () => {
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', ghWith({ issue: { state: 'open' } }));
    expect(node.met).toBe(false);
  });

  it('is met when the referenced PR is merged', async () => {
    const node = await resolveGithubDependencyNode(
      { number: '5' },
      'me/app',
      ghWith({ issue: { state: 'closed', pull_request: { merged_at: '2026-01-01T00:00:00Z' } } }),
    );
    expect(node.met).toBe(true);
  });

  it('is not met when the referenced PR is closed unmerged', async () => {
    const node = await resolveGithubDependencyNode(
      { number: '5' },
      'me/app',
      ghWith({ issue: { state: 'closed', pull_request: { merged_at: null } } }),
    );
    expect(node.met).toBe(false);
  });

  it('is missing on a 404 for the issue itself', async () => {
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', ghWith({ issue: new Error('HTTP 404: Not Found') }));
    expect(node).toEqual({ met: false, missing: true, dependsOn: [] });
  });

  it('propagates a non-404 error instead of reporting the reference as missing', async () => {
    const gh = ghWith({ issue: new Error('HTTP 502: Bad Gateway') });
    await expect(resolveGithubDependencyNode({ number: '5' }, 'me/app', gh)).rejects.toThrow('HTTP 502');
  });

  it('propagates a non-404 error from the native blocked-by lookup too', async () => {
    const gh = ghWith({ issue: { state: 'open' }, blockedBy: new Error('HTTP 503: Service Unavailable') });
    await expect(resolveGithubDependencyNode({ number: '5' }, 'me/app', gh)).rejects.toThrow('HTTP 503');
  });

  it('merges native + body dependsOn, qualifying body refs with its own repo', async () => {
    const gh = ghWith({
      issue: { state: 'open', body: 'Depends on #9', user: { login: 'owner' }, author_association: 'OWNER' },
      blockedBy: [{ number: 7, repository: { full_name: 'other/lib' } }],
    });
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', gh);
    expect(node.dependsOn).toEqual([
      { repo: 'other/lib', number: '7' },
      { repo: 'me/app', number: '9' },
    ]);
  });

  it("ignores body refs on an outsider's issue but keeps native blockers", async () => {
    const gh = ghWith({
      issue: { state: 'open', body: 'Depends on #1', user: { login: 'mallory' }, author_association: 'NONE' },
      blockedBy: [{ number: 7, repository: { full_name: 'other/lib' } }],
    });
    const node = await resolveGithubDependencyNode({ number: '5' }, 'me/app', gh);
    expect(node.dependsOn).toEqual([{ repo: 'other/lib', number: '7' }]);
  });

  // #760 cross-repo bug: a same-repo native blocker (the API omits `repository`, so it is implicitly
  // "the repo this issue was queried in") must come back qualified with THAT repo — not left
  // unqualified to be misread, deeper in checkDependencies's graph walk, against some other fallback.
  it('qualifies a same-repo native blocker with the queried repo, not the caller-supplied fallback', async () => {
    const gh = ghWith({ issue: { state: 'open' }, blockedBy: [{ number: 7 }] });
    const node = await resolveGithubDependencyNode({ repo: 'other/lib', number: '5' }, 'me/app', gh);
    expect(node.dependsOn).toEqual([{ repo: 'other/lib', number: '7' }]);
  });
});

describe('checkGithubDependencies', () => {
  it('is ready for a task with no dependencies', async () => {
    const task = { id: 'me/app#1', title: 't', description: '', labels: [], children: [], comments: [] };
    const gh: GhRunner = async () => JSON.stringify([]);
    expect(await checkGithubDependencies('me/app', task, '1', gh)).toEqual({ status: 'ready' });
  });

  // End-to-end reproduction of the #760 cross-repo bug: the root issue (me/app#1) depends on
  // other/lib#5; other/lib#5 has a NATIVE blocker on #7 in the SAME repo (so the API omits
  // `repository`, returning a bare `{ number: 7 }`). Resolving that nested ref must query
  // repos/other/lib/issues/7 — never repos/me/app/issues/7 (the root's own repo).
  it('resolves a same-repo native blocker of a cross-repo dependency against ITS OWN repo', async () => {
    const calls: string[] = [];
    const gh: GhRunner = async (args) => {
      const call = args.join(' ');
      calls.push(call);
      if (call === 'api repos/me/app/issues/1/dependencies/blocked_by') return JSON.stringify([]);
      if (call === 'api repos/other/lib/issues/5/dependencies/blocked_by') return JSON.stringify([{ number: 7 }]);
      if (call === 'api repos/other/lib/issues/5') return JSON.stringify({ state: 'open' });
      if (call === 'api repos/other/lib/issues/7/dependencies/blocked_by') return JSON.stringify([]);
      if (call === 'api repos/other/lib/issues/7') return JSON.stringify({ state: 'open' });
      throw new Error(`unexpected gh call: ${call}`);
    };
    const task = {
      id: 'me/app#1',
      title: 't',
      description: '',
      labels: [],
      children: [],
      comments: [],
      dependsOn: [{ repo: 'other/lib', number: '5' }],
    };
    const check = await checkGithubDependencies('me/app', task, '1', gh);
    expect(check).toEqual({ status: 'waiting', kind: 'unmet', blockers: [{ repo: 'other/lib', number: '5' }] });
    expect(calls).not.toContain('api repos/me/app/issues/7');
    expect(calls).not.toContain('api repos/me/app/issues/7/dependencies/blocked_by');
    expect(calls).toContain('api repos/other/lib/issues/7');
  });

  it('is waiting on a future start date even with no dependencies', async () => {
    const task = { id: 'me/app#1', title: 't', description: '', labels: [], children: [], comments: [], startDate: '2099-01-01' };
    const gh: GhRunner = async () => JSON.stringify([]);
    expect(await checkGithubDependencies('me/app', task, '1', gh)).toEqual({ status: 'waiting', kind: 'start-date', startDate: '2099-01-01' });
  });
});
