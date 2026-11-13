import { execa } from 'execa';
import { expect, test } from 'vitest';
import { dispatchRpc, makeCtx, tmpRepo, tmpGitRepo } from '../test-kit.js';

test('reply_needs_you takes the repo from the allowlisted path, never from the id', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  // An id naming an unregistered repo is refused: it must never become the `--repo` a reply
  // comments on and relabels.
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'other/repo#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('other/repo#1 is not an item of allowed/repo');
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'other/repo#1', kind: 'nope', body: 'hi' }))
    .rejects.toThrow("kind must be 'issue' or 'pr'");
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
