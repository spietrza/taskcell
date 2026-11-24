import { execa } from 'execa';
import { expect, test, vi } from 'vitest';
import { dispatchRpc, makeCtx, tmpRepo, tmpGitRepo } from '../test-kit.js';

test('reply_needs_you takes the repo from the allowlisted path, never from the id', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  // An id naming an unregistered repo is refused: it must never become the `--repo` a reply
  // comments on and relabels.
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'other/repo#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('other/repo#1 is not an item of allowed/repo');
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'other/repo#1', kind: 'nope', body: 'hi' }))
    .rejects.toThrow("kind must be 'issue', 'pr' or 'card'");
});

test('reply_needs_you enforces mutation permissions before touching GitHub', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'allowed/repo#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('disabled on a non-loopback bind');
});

test('merge_needs_you is refused when mutations are not allowed', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
  await expect(dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'allowed/repo#1' }))
    .rejects.toThrow('disabled on a non-loopback bind');
});

test('merge_needs_you refuses an id naming another repo', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  await expect(dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'other/repo#1' }))
    .rejects.toThrow('other/repo#1 is not an item of allowed/repo');
});

test('list_needs_you is empty on a project with no GitHub remote', async () => {
  const repo = await tmpRepo();
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const { ctx } = await makeCtx(repo);
  expect(await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo })).toEqual({ items: [] });
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'o/r#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('no GitHub remote');
  await expect(dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'o/r#1' })).rejects.toThrow('no GitHub remote');
});

const ISSUE = JSON.stringify([{ number: 4, title: 'Q', url: 'https://github.com/allowed/repo/issues/4', labels: [{ name: 'needs info' }], updatedAt: 'x' }]);
const commentsOf = (body: string): string => JSON.stringify({ comments: [{ author: { login: 'me' }, body }] });
const fakeGh = (calls: string[][], opts: { fail?: () => boolean; body?: string } = {}) => async (args: string[]): Promise<string> => {
  calls.push(args);
  if (opts.fail?.()) throw new Error('rate limited');
  if (args[0] === 'api') return 'me';
  if (args[1] === 'list') return args[0] === 'issue' ? ISSUE : '[]';
  return commentsOf(opts.body ?? 'Which file?');
};

test('list_needs_you lists the last comment and the too-vague ask once, then serves the kept read', async () => {
  const { clarifyMessage } = await import('../../runners/watch-shared.js');
  const { forgetBoardWaiting } = await import('../asking.js');
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const calls: string[][] = [];
  const { ctx } = await makeCtx(repo, { gh: fakeGh(calls, { body: clarifyMessage('spec') }) });
  forgetBoardWaiting(repo);
  const first = await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo }) as { items: { lastComment?: { author: string }; ask?: string }[] };
  expect(first.items[0]?.lastComment?.author).toBe('me');
  expect(first.items[0]?.ask).toBe('too-vague');
  const n = calls.length;
  await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo });
  expect(calls.length).toBe(n);
});

test('list_needs_you_all keeps the last items of a repository GitHub could not be read for, and reports it', async () => {
  const { forgetBoardWaiting } = await import('../asking.js');
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { savePaths } = await import('../projects.js');
  let down = false;
  const { ctx } = await makeCtx(repo, { gh: fakeGh([], { fail: () => down }) });
  await savePaths(ctx.configDir, [repo]);
  forgetBoardWaiting(repo);
  const ok = await dispatchRpc(ctx, 'list_needs_you_all', {}) as { items: unknown[]; failures: unknown[] };
  expect(ok.items).toHaveLength(1);
  expect(ok.failures).toEqual([]);
  forgetBoardWaiting(repo);
  await dispatchRpc(ctx, 'list_needs_you_all', {});
  down = true;
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(Date.now() + 61_000);
  try {
    const stale = await dispatchRpc(ctx, 'list_needs_you_all', {}) as { items: unknown[]; failures: { repoPath: string }[] };
    expect(stale.items).toHaveLength(1);
    expect(stale.failures).toHaveLength(1);
  } finally {
    now.mockRestore();
  }
});

test('needs_you_comment reads one item\'s last comment and refuses another repository', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const calls: string[][] = [];
  const { ctx } = await makeCtx(repo, { gh: fakeGh(calls) });
  expect(await dispatchRpc(ctx, 'needs_you_comment', { repoPath: repo, id: 'allowed/repo#4', kind: 'issue' })).toEqual({ lastComment: { author: 'me', body: 'Which file?' }, ask: 'question' });
  await expect(dispatchRpc(ctx, 'needs_you_comment', { repoPath: repo, id: 'other/repo#4', kind: 'issue' })).rejects.toThrow('not an item of allowed/repo');
  await expect(dispatchRpc(ctx, 'needs_you_comment', { repoPath: repo, id: 'allowed/repo#4', kind: 'x' })).rejects.toThrow("kind must be 'issue' or 'pr'");
});

test('needs_you_comment refuses an item that is not waiting', async () => {
  const { forgetBoardWaiting } = await import('../asking.js');
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo, { gh: fakeGh([]) });
  forgetBoardWaiting(repo);
  await expect(dispatchRpc(ctx, 'needs_you_comment', { repoPath: repo, id: 'allowed/repo#99', kind: 'issue' })).rejects.toThrow('not waiting');
  await expect(dispatchRpc(ctx, 'needs_you_comment', { repoPath: repo, id: 'allowed/repo#4', kind: 'pr' })).rejects.toThrow('not waiting');
});

test('the first read after a drop is kept briefly, so the next read refreshes', async () => {
  const { forgetBoardWaiting } = await import('../asking.js');
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const calls: string[][] = [];
  const { ctx } = await makeCtx(repo, { gh: fakeGh(calls) });
  forgetBoardWaiting(repo);
  await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo });
  const lists = (): number => calls.filter((c) => c[1] === 'list').length;
  const n = lists();
  const now = vi.spyOn(Date, 'now');
  try {
    now.mockReturnValue(Date.now() + 5_000);
    await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo });
    expect(lists()).toBeGreaterThan(n);
    const m = lists();
    now.mockReturnValue(Date.now() + 10_000);
    await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo });
    expect(lists()).toBe(m);
  } finally {
    now.mockRestore();
  }
});

test('last-good items keep their comments through an outage, without per-item retries, and expire', async () => {
  const { forgetBoardWaiting } = await import('../asking.js');
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const calls: string[][] = [];
  let down = false;
  const { ctx } = await makeCtx(repo, { gh: fakeGh(calls, { fail: () => down }) });
  forgetBoardWaiting(repo);
  const t0 = Date.now();
  const list = (): Promise<{ items: { lastComment?: { body: string } }[]; unchecked?: true }> => dispatchRpc(ctx, 'list_needs_you', { repoPath: repo }) as never;
  expect((await list()).items[0]?.lastComment?.body).toBe('Which file?');
  down = true;
  const now = vi.spyOn(Date, 'now');
  try {
    now.mockReturnValue(t0 + 61_000);
    const before = calls.length;
    const out = await list();
    expect(out.unchecked).toBe(true);
    expect(out.items[0]?.lastComment?.body).toBe('Which file?');
    // the failed list, and nothing per item (no `api user`, no comment views)
    expect(calls.slice(before).filter((c) => c[0] === 'api' || c[1] === 'view')).toEqual([]);
    now.mockReturnValue(t0 + 11 * 60_000);
    const old = await list();
    expect(old.unchecked).toBe(true);
    expect(old.items).toEqual([]);
  } finally {
    now.mockRestore();
  }
});
