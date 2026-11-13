import { describe, it, expect } from 'vitest';
import { listNeedsYou, mergeNeedsYou, replyNeedsYou, NEEDS_REVISION_LABEL } from './needs-you.js';
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
  it('lists an issue at needs info with its last factory comment redacted, verbatim otherwise', async () => {
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
    // Verbatim: the UI renders it as text, so no HTML-escaping here…
    expect(items[0]?.lastComment?.body).toContain('<this>');
    // …and a secret-shaped token redacted.
    expect(items[0]?.lastComment?.body).not.toContain('sk-ANTHROPIC1234567890ABCDEFGHIJKLMNOPQR');
    // Both lists carry an explicit `-L`, and neither asks for comments.
    for (const list of calls.filter((c) => c[1] === 'list')) {
      expect(list).toContain('-L');
      expect(list.at(-1)).not.toContain('comments');
    }
  });

  it('reports the target branch: a PR\'s base, an issue\'s taskcell:base= label', async () => {
    const gh = stubGh({
      issueList: [{ number: 1, title: 'I', url: 'u1', labels: [{ name: 'needs info' }, { name: 'taskcell:base=uat' }] }],
      prList: [{ number: 2, title: 'P', url: 'u2', labels: [{ name: 'taskcell:needs-human-review' }], baseRefName: 'dev' }],
    });
    const items = await listNeedsYou('o/r', gh);
    expect(items.map((i) => [i.number, i.baseBranch])).toEqual([[1, 'uat'], [2, 'dev']]);
  });

  it('lists a PR at taskcell:needs-human-review, taskcell:verify-failed, or with changes requested', async () => {
    const gh = stubGh({
      issueList: [],
      prList: [
        { number: 1, title: 'A', url: 'u1', labels: [{ name: 'taskcell:needs-human-review' }] },
        { number: 2, title: 'B', url: 'u2', labels: [{ name: 'taskcell:verify-failed' }] },
        { number: 3, title: 'C', url: 'u3', labels: [], reviewDecision: 'CHANGES_REQUESTED' },
        { number: 4, title: 'D', url: 'u4', labels: [], reviewDecision: 'APPROVED' },
        // Already handed back to the factory (a reply added `needs revision`): not waiting on a human.
        { number: 5, title: 'E', url: 'u5', labels: [{ name: 'taskcell:needs-human-review' }, { name: NEEDS_REVISION_LABEL }] },
      ],
    });
    const items = await listNeedsYou('o/r', gh);
    expect(items.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.reason)).toEqual(['taskcell:needs-human-review', 'taskcell:verify-failed', 'changes requested']);
    expect(items.every((i) => i.kind === 'pr')).toBe(true);
  });

  it('passes on only an https url (else empty, so the UI renders no link)', async () => {
    const gh = stubGh({
      issueList: [],
      prList: [
        { number: 1, title: 'A', url: 'https://github.com/o/r/pull/1', labels: [{ name: 'taskcell:needs-human-review' }] },
        { number: 2, title: 'B', url: 'javascript:alert(1)', labels: [{ name: 'taskcell:needs-human-review' }] },
      ],
    });
    const items = await listNeedsYou('o/r', gh);
    expect(items.map((i) => i.url)).toEqual(['https://github.com/o/r/pull/1', '']);
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

  it('bounds the concurrent and the total comment fetches', async () => {
    let fetches = 0;
    let inFlight = 0;
    let peak = 0;
    const base = stubGh({
      issueList: [],
      prList: Array.from({ length: 35 }, (_, i) => ({ number: i + 1, title: 't', url: 'u', labels: [], reviewDecision: 'CHANGES_REQUESTED' })),
    });
    const gh: GhRunner = async (args) => {
      if (args[1] !== 'view') return base(args);
      fetches += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return base(args);
    };
    expect(await listNeedsYou('o/r', gh)).toHaveLength(35);
    expect(peak).toBeLessThanOrEqual(4);
    expect(fetches).toBe(30);
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
    await expect(listNeedsYou('-L/x', stubGh({}))).rejects.toThrow(/Invalid repo slug/);
  });

  it('keeps an item whose comment fetch fails, without its lastComment', async () => {
    const base = stubGh({
      issueList: [],
      prList: [
        { number: 1, title: 'A', url: 'u1', labels: [], reviewDecision: 'CHANGES_REQUESTED' },
        { number: 2, title: 'B', url: 'u2', labels: [], reviewDecision: 'CHANGES_REQUESTED' },
      ],
      comments: { 'pr#2': [{ author: { login: 'vanguard-bot' }, body: 'why?' }] },
    });
    const gh: GhRunner = async (args) => {
      if (args[1] === 'view' && args[2] === '1') throw new Error('HTTP 502');
      return base(args);
    };
    const items = await listNeedsYou('o/r', gh);
    expect(items.map((i) => i.number)).toEqual([1, 2]);
    expect(items[0]?.lastComment).toBeUndefined();
    expect(items[1]?.lastComment?.body).toBe('why?');
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
    const gh = stubGh({ prView: { state: 'OPEN', labels: [{ name: 'taskcell:needs-human-review' }] } }, calls);
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

  it('on a needs-info issue: moves it to the repo\'s configured trigger label', async () => {
    const calls: string[][] = [];
    const gh = stubGh({ issueView: { state: 'OPEN', labels: [{ name: DEFAULT_GITHUB_NEEDS_INFO_LABEL }] } }, calls);
    await replyNeedsYou('o/r', 'o/r#7', 'issue', 'context', gh, 'vanguard:go');
    const edit = calls.find((c) => c[0] === 'issue' && c[1] === 'edit');
    expect(edit?.slice(-2)).toEqual(['--add-label', 'vanguard:go']);
  });

  it('on a PR already at needs revision: refuses a second reply', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      { prView: { state: 'OPEN', labels: [{ name: 'taskcell:needs-human-review' }, { name: NEEDS_REVISION_LABEL }] } },
      calls,
    );
    await expect(replyNeedsYou('o/r', 'o/r#9', 'pr', 'again', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'pr' && (c[1] === 'comment' || c[1] === 'edit'))).toBe(false);
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

describe('listNeedsYou base branch', () => {
  it('lists a PR with its base branch', async () => {
    const gh = stubGh({ prList: [{ number: 5, title: 't', url: 'u', labels: [{ name: 'taskcell:needs-human-review' }], baseRefName: 'develop' }] });
    expect((await listNeedsYou('o/r', gh)).find((i) => i.kind === 'pr')?.baseRef).toBe('develop');
  });
});

describe('mergeNeedsYou', () => {
  const waitingPr = { state: 'OPEN', labels: [{ name: 'taskcell:needs-human-review' }], reviewDecision: null, headRefOid: 'abc123' };
  const allMethods = { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true };

  function mergeGh(opts: { pr?: unknown; checks?: string | Error; methods?: Record<string, boolean> }, calls: string[][]): GhRunner {
    const base = stubGh({ prView: opts.pr ?? waitingPr }, calls);
    return async (args) => {
      if (args[0] === 'pr' && args[1] === 'checks') {
        calls.push(args);
        if (opts.checks instanceof Error) throw opts.checks;
        return opts.checks ?? '[{"bucket":"pass"}]';
      }
      if (args[0] === 'repo') {
        calls.push(args);
        return JSON.stringify(opts.methods ?? allMethods);
      }
      return base(args);
    };
  }
  const merged = (calls: string[][]): boolean => calls.some((c) => c[1] === 'merge');

  it('merges a waiting PR, preferring squash and pinning the checked head commit', async () => {
    const calls: string[][] = [];
    await mergeNeedsYou('o/r', 'o/r#5', mergeGh({}, calls));
    expect(calls.at(-1)).toEqual(['pr', 'merge', '5', '--repo', 'o/r', '--squash', '--match-head-commit', 'abc123']);
  });

  it('uses the next allowed method, and refuses when none is allowed', async () => {
    const calls: string[][] = [];
    await mergeNeedsYou('o/r', 'o/r#5', mergeGh({ methods: { squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true } }, calls));
    expect(calls.at(-1)).toContain('--rebase');
    const none: string[][] = [];
    await expect(mergeNeedsYou('o/r', 'o/r#5', mergeGh({ methods: {} }, none))).rejects.toThrow('allows no merge method');
    expect(merged(none)).toBe(false);
  });

  it('refuses a PR outside the Needs you list', async () => {
    const calls: string[][] = [];
    await expect(mergeNeedsYou('o/r', 'o/r#5', mergeGh({ pr: { state: 'OPEN', labels: [] } }, calls))).rejects.toThrow('not waiting');
    expect(merged(calls)).toBe(false);
  });

  it('refuses a failing or pending required check', async () => {
    for (const checks of ['[{"bucket":"fail"}]', '[{"bucket":"pending"}]', '[{"bucket":"pass"},{"bucket":"cancel"}]']) {
      const calls: string[][] = [];
      await expect(mergeNeedsYou('o/r', 'o/r#5', mergeGh({ checks }, calls))).rejects.toThrow('failing or pending required checks');
      expect(merged(calls)).toBe(false);
    }
  });

  it('merges when checks are skipped or none are reported', async () => {
    for (const checks of ['[{"bucket":"skipping"},{"bucket":"pass"}]', new Error("no checks reported on the 'x' branch"), new Error('no required checks reported on the x branch')]) {
      const calls: string[][] = [];
      await mergeNeedsYou('o/r', 'o/r#5', mergeGh({ checks }, calls));
      expect(merged(calls)).toBe(true);
    }
  });

  it('surfaces other gh errors as themselves, not as failing checks', async () => {
    const calls: string[][] = [];
    await expect(mergeNeedsYou('o/r', 'o/r#5', mergeGh({ checks: new Error('HTTP 401: bad credentials') }, calls))).rejects.toThrow('bad credentials');
    expect(merged(calls)).toBe(false);
  });
});
