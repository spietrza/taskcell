import { describe, it, expect } from 'vitest';
import { listNeedsYou, replyNeedsYou, NEEDS_INFO_LABEL, READY_FOR_AGENT_LABEL, NEEDS_REVISION_LABEL } from './needs-you.js';
import type { GhRunner } from '../tasks/github.js';

function stubGh(responses: Record<string, unknown>, calls: string[][] = []): GhRunner {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(responses.issueList ?? []);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(responses.prList ?? []);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(responses.issueView ?? {});
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(responses.prView ?? {});
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
            labels: [{ name: NEEDS_INFO_LABEL }],
            comments: [
              { author: { login: 'alice' }, body: 'please help' },
              { author: { login: 'vanguard[bot]' }, body: 'What repo does <this> affect? sk-ANTHROPIC1234567890ABCDEFGHIJKLMNOPQR' },
            ],
          },
        ],
        prList: [],
      },
      calls,
    );
    const items = await listNeedsYou('o/r', gh);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('o/r#7');
    expect(items[0]?.kind).toBe('issue');
    expect(items[0]?.reason).toBe(NEEDS_INFO_LABEL);
    expect(items[0]?.url).toBe('https://github.com/o/r/issues/7');
    expect(items[0]?.lastComment?.author).toBe('vanguard[bot]');
    // `<`/`>` escaped…
    expect(items[0]?.lastComment?.body).toContain('&lt;this&gt;');
    expect(items[0]?.lastComment?.body).not.toContain('<this>');
    // …and a secret-shaped token redacted.
    expect(items[0]?.lastComment?.body).not.toContain('sk-ANTHROPIC1234567890ABCDEFGHIJKLMNOPQR');
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

  it('omits lastComment when the factory never commented', async () => {
    const gh = stubGh({
      issueList: [{ number: 1, title: 'A', url: 'u', labels: [{ name: NEEDS_INFO_LABEL }], comments: [{ author: { login: 'alice' }, body: 'hi' }] }],
      prList: [],
    });
    const items = await listNeedsYou('o/r', gh);
    expect(items[0]?.lastComment).toBeUndefined();
  });
});

describe('replyNeedsYou', () => {
  it('on a needs-info issue: posts the comment and swaps the label to ready for agent', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      { issueView: { state: 'OPEN', labels: [{ name: NEEDS_INFO_LABEL }] } },
      calls,
    );
    await replyNeedsYou('o/r#7', 'issue', 'here is the missing context', gh);

    const comment = calls.find((c) => c[0] === 'issue' && c[1] === 'comment');
    expect(comment).toBeDefined();
    expect(comment).toEqual(['issue', 'comment', '7', '--repo', 'o/r', '--body', 'here is the missing context']);

    const edit = calls.find((c) => c[0] === 'issue' && c[1] === 'edit');
    expect(edit).toEqual(['issue', 'edit', '7', '--repo', 'o/r', '--remove-label', NEEDS_INFO_LABEL, '--add-label', READY_FOR_AGENT_LABEL]);

    // The comment must be posted before the label swap (the ticket's own ordering).
    expect(calls.indexOf(comment!)).toBeLessThan(calls.indexOf(edit!));
  });

  it('on a waiting PR: posts the comment and adds needs revision', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      { prView: { state: 'OPEN', labels: [{ name: 'vanguard:needs-human-review' }] } },
      calls,
    );
    await replyNeedsYou('o/r#9', 'pr', 'pushed a fix', gh);

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
    await expect(replyNeedsYou('o/r#7', 'issue', 'too late', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'comment')).toBe(false);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit')).toBe(false);
  });

  it('on a closed issue: makes no label change and throws', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      { issueView: { state: 'CLOSED', labels: [{ name: NEEDS_INFO_LABEL }] } },
      calls,
    );
    await expect(replyNeedsYou('o/r#7', 'issue', 'too late', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'issue' && (c[1] === 'comment' || c[1] === 'edit'))).toBe(false);
  });

  it('on a PR with no waiting signal: makes no label change and throws', async () => {
    const calls: string[][] = [];
    const gh = stubGh(
      { prView: { state: 'OPEN', labels: [], reviewDecision: 'APPROVED' } },
      calls,
    );
    await expect(replyNeedsYou('o/r#9', 'pr', 'too late', gh)).rejects.toThrow(/not waiting/);
    expect(calls.some((c) => c[0] === 'pr' && (c[1] === 'comment' || c[1] === 'edit'))).toBe(false);
  });

  it('rejects a malformed id', async () => {
    await expect(replyNeedsYou('not-an-id', 'issue', 'x', stubGh({}))).rejects.toThrow(/Invalid item id/);
  });
});
