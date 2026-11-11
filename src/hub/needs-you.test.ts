import { describe, it, expect } from 'vitest';
import { listNeedsYou, replyNeedsYou, NEEDS_REVISION_LABEL } from './needs-you.js';
import { DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_NEEDS_INFO_LABEL } from '../cli/args.js';
import type { GhRunner } from '../tasks/github.js';

interface StubComment {
  author: { login: string };
  body: string;
}

interface StubResponses {
  issueList?: unknown;
  prList?: unknown;
  issueView?: unknown;
  prView?: unknown;
  /** `gh api user` — the login the hub acts as. */
  user?: string;
  /** `<kind>#<number>` -> the comments `gh <kind> view --json comments` returns. */
  comments?: Record<string, StubComment[]>;
}

function stubGh(responses: StubResponses, calls: string[][] = []): GhRunner {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return `${responses.user ?? 'vanguard-bot'}\n`;
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(responses.issueList ?? []);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(responses.prList ?? []);
    if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'view') {
      if (args.at(-1) === 'comments') return JSON.stringify({ comments: responses.comments?.[`${args[0]}#${args[2]}`] ?? [] });
      return JSON.stringify((args[0] === 'issue' ? responses.issueView : responses.prView) ?? {});
    }
    return '';
  };
}

describe('listNeedsYou', () => {
  it('lists an issue at needs info with its last factory comment redacted and escaped', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      {
        issueList: [
          {
            number: 7,
            title: 'Vague ask',
            url: 'https://github.com/o/r/issues/7',
            labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }],
          },
        ],
        prList: [],
        user: 'vanguard-bot',
        comments: {
          'issue#7': [
            { author: { login: 'alice' }, body: 'please help' },
            { author: { login: 'vanguard-bot' }, body: 'What repo does <this> affect? sk-ANTHROPIC1234567890ABCDEFGHIJKLMNOPQR' },
          ],
        },
      },
      calls,
    );
    const items = await listNeedsYou('o/r', gh);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('o/r#7');
    expect(items[0]?.kind).toBe('issue');
    expect(items[0]?.reason).toBe(DEFAULT_GITHUB_NEEDS_INFO_LABEL);
    expect(items[0]?.url).toBe('https://github.com/o/r/issues/7');
    expect(items[0]?.lastComment?.author).toBe('vanguard-bot');
    // `<`/`>` escaped…
    expect(items[0]?.lastComment?.body).toContain('&lt;this&gt;');
    expect(items[0]?.lastComment?.body).not.toContain('<this>');
    // …and a secret-shaped token redacted.
    expect(items[0]?.lastComment?.body).not.toContain('sk-ANTHROPIC1234567890ABCDEFGHIJKLMNOPQR');
    // Both lists carry an explicit `-L`, and neither asks for comments.
    for (const list of calls.filter((c) => c[1] === 'list')) {
      expect(list).toContain('-L');
      expect(list.at(-1)).not.toContain('comments');
    }
  });

  it('lists a PR at vanguard:needs-human-review, vanguard:verify-failed, or with changes requested', async () => {
    const gh = stubGh({
      issueList: [],
      prList: [
        { number: 1, title: 'A', url: 'u1', labels: [{ name: 'vanguard:needs-human-review' }] },
        { number: 2, title: 'B', url: 'u2', labels: [{ name: 'vanguard:verify-failed' }] },
        { number: 3, title: 'C', url: 'u3', labels: [], reviewDecision: 'CHANGES_REQUESTED' },
        { number: 4, title: 'D', url: 'u4', labels: [], reviewDecision: 'APPROVED' },
      ],
    });
    const items = await listNeedsYou('o/r', gh);
    expect(items.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.reason)).toEqual(['vanguard:needs-human-review', 'vanguard:verify-failed', 'changes requested']);
    expect(items.every((i) => i.kind === 'pr')).toBe(true);
  });

  it('fetches comments for the waiting items only', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      {
        issueList: [],
        prList: [
          { number: 3, title: 'C', url: 'u3', labels: [], reviewDecision: 'CHANGES_REQUESTED' },
          { number: 4, title: 'D', url: 'u4', labels: [], reviewDecision: 'APPROVED' },
        ],
      },
      calls,
    );
    await listNeedsYou('o/r', gh);
    const commentFetches = calls.filter((c) => c[1] === 'view' && c.at(-1) === 'comments');
    expect(commentFetches.map((c) => c[2])).toEqual(['3']);
  });

  it('makes no gh call beyond the lists when nothing waits, and filters every list server-side', async () => {
    const calls: string[][] = [];
    await listNeedsYou('o/r', stubGh({ issueList: [], prList: [] }, calls));
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['issue', 'list'],
      ['pr', 'list'],
      ['pr', 'list'],
    ]);
    // `-L` must cap waiting items only: no list may fetch unrelated open PRs.
    for (const list of calls) expect(list.some((arg) => arg === '--label' || arg === '--search')).toBe(true);
  });

  it('bounds the concurrent comment fetches', async () => {
    let inFlight = 0;
    let peak = 0;
    const base = stubGh({
      issueList: [],
      prList: Array.from({ length: 12 }, (_, i) => ({ number: i + 1, title: 't', url: 'u', labels: [], reviewDecision: 'CHANGES_REQUESTED' })),
    });
    const gh: GhRunner = async (args) => {
      if (args[1] !== 'view') return base(args);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return base(args);
    };
    expect(await listNeedsYou('o/r', gh)).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('omits lastComment when the factory never commented', async () => {
    const gh = stubGh({
      issueList: [{ number: 1, title: 'A', url: 'u', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] }],
      prList: [],
      comments: { 'issue#1': [{ author: { login: 'alice' }, body: 'hi' }] },
    });
    const items = await listNeedsYou('o/r', gh);
    expect(items[0]?.lastComment).toBeUndefined();
  });

  it('treats another bot as a stranger, not as the factory asking (Dependabot/Renovate)', async () => {
    const gh = stubGh({
      issueList: [{ number: 1, title: 'A', url: 'u', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] }],
      prList: [],
      user: 'octo-maintainer',
      comments: { 'issue#1': [{ author: { login: 'dependabot[bot]' }, body: 'bumping a dep' }] },
    });
    expect((await listNeedsYou('o/r', gh))[0]?.lastComment).toBeUndefined();
  });

  it('recognizes the gh user, the CI identity and a configured bot login as the factory', async () => {
    const responses: StubResponses = {
      issueList: [
        { number: 1, title: 'A', url: 'u', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] },
        { number: 2, title: 'B', url: 'u', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] },
        { number: 3, title: 'C', url: 'u', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] },
      ],
      prList: [],
      user: 'octo-maintainer',
      comments: {
        'issue#1': [{ author: { login: 'octo-maintainer' }, body: 'which browser?' }],
        'issue#2': [{ author: { login: 'github-actions[bot]' }, body: 'which browser?' }],
        'issue#3': [{ author: { login: 'acme-vanguard[bot]' }, body: 'which browser?' }],
      },
    };
    const items = await listNeedsYou('o/r', stubGh(responses), { botLogins: ['acme-vanguard[bot]'] });
    expect(items.map((i) => i.lastComment?.author)).toEqual(['octo-maintainer', 'github-actions[bot]', 'acme-vanguard[bot]']);
  });

  it('rejects a slug that is not owner/repo', async () => {
    await expect(listNeedsYou('--repo=evil', stubGh({}))).rejects.toThrow(/Invalid repo slug/);
  });
});

describe('replyNeedsYou', () => {
  it('on a needs-info issue: posts the comment and swaps the label to ready for agent', async () => {
    const calls: string[][] = [];
    const gh = stubGh({ issueView: { state: 'OPEN', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] } }, calls);
    await replyNeedsYou('o/r', 'o/r#7', 'issue', 'here is the missing context', gh);

    const comment = calls.find((c) => c[0] === 'issue' && c[1] === 'comment');
    expect(comment).toBeDefined();
    expect(comment).toEqual(['issue', 'comment', '7', '--repo', 'o/r', '--body', 'here is the missing context']);

    const edit = calls.find((c) => c[0] === 'issue' && c[1] === 'edit');
    expect(edit).toEqual([
      'issue',
      'edit',
      '7',
      '--repo',
      'o/r',
      '--remove-label',
      DEFAULT_GITHUB_NEEDS_INFO_LABEL,
      '--add-label',
      DEFAULT_GITHUB_AGENT_LABEL,
    ]);

    // The comment must be posted before the label swap (the ticket's own ordering).
    expect(calls.indexOf(comment!)).toBeLessThan(calls.indexOf(edit!));
  });

  it('on a waiting PR: posts the comment and adds needs revision', async () => {
    const calls: string[][] = [];
    const gh = stubGh({ prView: { state: 'OPEN', labels: [{ name: 'vanguard:needs-human-review' }] } }, calls);
    await replyNeedsYou('o/r', 'o/r#9', 'pr', 'pushed a fix', gh);

    const comment = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(comment).toEqual(['pr', 'comment', '9', '--repo', 'o/r', '--body', 'pushed a fix']);

    const edit = calls.find((c) => c[0] === 'pr' && c[1] === 'edit');
    expect(edit).toEqual(['pr', 'edit', '9', '--repo', 'o/r', '--add-label', NEEDS_REVISION_LABEL]);
  });

  it('on an item in no actionable state: makes no label change and throws', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      { issueView: { state: 'OPEN', labels: [] } }, // no longer "needs info"
      calls,
    );
    await expect(replyNeedsYou('o/r', 'o/r#7', 'issue', 'too late', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'comment')).toBe(false);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit')).toBe(false);
  });

  it('on a closed issue: makes no label change and throws', async () => {
    const calls: string[][] = [];
    const gh = stubGh({ issueView: { state: 'CLOSED', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] } }, calls);
    await expect(replyNeedsYou('o/r', 'o/r#7', 'issue', 'too late', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'issue' && (c[1] === 'comment' || c[1] === 'edit'))).toBe(false);
  });

  it('on a PR with no waiting signal: makes no label change and throws', async () => {
    const calls: string[][] = [];
    const gh = stubGh({ prView: { state: 'OPEN', labels: [], reviewDecision: 'APPROVED' } }, calls);
    await expect(replyNeedsYou('o/r', 'o/r#9', 'pr', 'too late', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'pr' && (c[1] === 'comment' || c[1] === 'edit'))).toBe(false);
  });

  it('rejects a malformed id', async () => {
    await expect(replyNeedsYou('o/r', 'not-an-id', 'issue', 'x', stubGh({}))).rejects.toThrow(/Invalid item id/);
  });

  it('refuses an id naming another repo, touching no repo at all', async () => {
    const calls: string[][] = [];
    const gh = stubGh({ issueView: { state: 'OPEN', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] } }, calls);
    await expect(replyNeedsYou('o/r', 'other/repo#1', 'issue', 'x', gh)).rejects.toThrow(/not an item of o\/r/);
    expect(calls).toEqual([]);
  });
});
