import { expect, test, vi } from 'vitest';
import { dispatchRpc, makeCtx, tmpGitRepo } from '../test-kit.js';

const read = vi.hoisted(() => vi.fn(async () => ({ repo: 'allowed/repo', issue: 5, prs: [], entries: [], chains: [], unavailable: [] })));
vi.mock('../../core/history.js', () => ({ readIssueHistory: read }));

test('read_issue_history includes the hub audit log for an admin only', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  await dispatchRpc(ctx, 'read_issue_history', { repoPath: repo, issue: 5 });
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'allowed/repo', issue: 5, hubConfigDir: ctx.configDir }));
  await dispatchRpc({ ...ctx, actor: { login: 'bob', admin: false } }, 'read_issue_history', { repoPath: repo, issue: 5 });
  expect((read.mock.calls.at(-1) as unknown[])[0]).not.toHaveProperty('hubConfigDir');
});

test('read_issue_history validates the issue and the remote', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  await expect(dispatchRpc(ctx, 'read_issue_history', { repoPath: repo, issue: 0 })).rejects.toThrow('positive integer');
});
