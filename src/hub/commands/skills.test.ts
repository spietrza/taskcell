import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { dispatchRpc, makeCtx, tmpGitRepo, tmpRepo, type OWNER } from '../test-kit.js';

const cli = vi.hoisted(() => ({
  skillsChecked: vi.fn(),
  skillsUpdate: vi.fn(),
  skillsAddPr: vi.fn(),
  skillsRemovePr: vi.fn(),
  recordedMetrics: vi.fn(async () => ''),
  cachedResolver: vi.fn(() => async () => undefined),
}));
vi.mock('../../cli/skills.js', () => cli);

const outsider: typeof OWNER = { user: { id: 'u2', email: 'u2@x.test', name: 'Member' }, owner: false };
const PR = 'https://github.com/o/r/pull/9';

beforeEach(() => {
  for (const f of Object.values(cli)) f.mockClear();
  cli.skillsChecked.mockResolvedValue([
    { name: 'a', source: 'https://github.com/o/a', commit: 'abcdef1234', status: 'pinned', state: 'outdated', upstream: 'f00' },
    { name: 'b', source: '-', commit: '', status: 'local', state: 'local' },
  ]);
  cli.recordedMetrics.mockResolvedValue(
    JSON.stringify({ evt: 'run_complete', taskId: 't1', ts: '2026-01-01T00:00:00Z', stage: 'implement', costUsd: 1, skillsUsed: ['a'], verdict: 'pass' }),
  );
});

test('list_repo_skills joins status, check and usage', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  expect(await dispatchRpc(ctx, 'list_repo_skills', { repoPath: repo })).toEqual({ skills: [] }); // no skills/ yet: empty state
  await mkdir(join(repo, 'skills'));
  const { skills } = (await dispatchRpc(ctx, 'list_repo_skills', { repoPath: repo })) as { skills: { name: string; commit: string; check: string; usage?: { runs: number } }[] };
  expect(skills.map((s) => [s.name, s.commit, s.check, s.usage?.runs])).toEqual([['a', 'abcdef1', 'outdated', 1], ['b', '', 'local', undefined]]);
});

test('only allowlisted projects are covered', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  const elsewhere = await tmpRepo();
  for (const [cmd, args] of [['list_repo_skills', {}], ['update_skill_pr', { name: 'a' }], ['add_skill_pr', { source: 'https://x/y' }], ['remove_skill_pr', { name: 'a' }]] as const) {
    await expect(dispatchRpc(ctx, cmd, { repoPath: elsewhere, ...args })).rejects.toThrow();
  }
  expect(cli.skillsChecked).not.toHaveBeenCalled();
  expect(cli.skillsUpdate).not.toHaveBeenCalled();
  expect(cli.skillsAddPr).not.toHaveBeenCalled();
  expect(cli.skillsRemovePr).not.toHaveBeenCalled();
});

test('update_skill_pr always asks for a PR and never a dry run, and returns its URL', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsUpdate.mockImplementation(async (_o: unknown, _d: unknown, out: (l: string) => void) => out(`opened ${PR}`));
  expect(await dispatchRpc(ctx, 'update_skill_pr', { repoPath: repo, name: 'a', pr: false })).toEqual({ prUrl: PR });
  expect(cli.skillsUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'a', pr: true, dryRun: false }), {}, expect.any(Function));
});

test('an update that opens no PR is an error, not a silent success', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsUpdate.mockImplementation(async (_o: unknown, _d: unknown, out: (l: string) => void) => out('a\tcurrent'));
  await expect(dispatchRpc(ctx, 'update_skill_pr', { repoPath: repo, name: 'a' })).rejects.toThrow('opened no pull request');
});

test('add and remove open a PR and show its link; a failed add carries the command reason', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsAddPr.mockImplementation(async (_o: unknown, _d: unknown, out: (l: string) => void) => out(`opened ${PR}`));
  cli.skillsRemovePr.mockImplementation(async (_o: unknown, _d: unknown, out: (l: string) => void) => out(`opened ${PR}`));
  expect(await dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s' })).toEqual({ prUrl: PR });
  expect(await dispatchRpc(ctx, 'remove_skill_pr', { repoPath: repo, name: 'a' })).toEqual({ prUrl: PR });
  const { TaskcellError } = await import('../../core/errors.js');
  cli.skillsAddPr.mockRejectedValue(new TaskcellError('Cannot resolve HEAD of https://github.com/o/s.'));
  await expect(dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s' })).rejects.toThrow('Cannot resolve HEAD');
});

test('a #ref on the source is split off as in the CLI', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsAddPr.mockImplementation(async (_o: unknown, _d: unknown, out: (l: string) => void) => out(`opened ${PR}`));
  await dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s#v1' });
  expect(cli.skillsAddPr).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'https://github.com/o/s', ref: 'v1' }), {}, expect.any(Function));
  await expect(dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s#' })).rejects.toThrow('empty #ref');
});

test('the audit target of an add never carries credentials or a query from the source', async () => {
  const { commands } = await import('./skills.js');
  const target = commands.audit.add_skill_pr!.target!;
  const secret = 'ghp_' + 'A1b2'.repeat(9);
  const t = target({ repoPath: '/r', source: `https://${secret}@github.com/o/s?token=${secret}` });
  expect(t).toBe('/r:https://github.com/o/s');
  expect(t).not.toContain(secret);
});

test('without the owner role, update, add and remove are refused before anything runs', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  await expect(dispatchRpc(ctx, 'update_skill_pr', { repoPath: repo, name: 'a' }, outsider)).rejects.toThrow('only the hub owner');
  expect(cli.skillsUpdate).not.toHaveBeenCalled();
  await expect(dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s' }, outsider)).rejects.toThrow('only the hub owner');
  await expect(dispatchRpc(ctx, 'remove_skill_pr', { repoPath: repo, name: 'a' }, outsider)).rejects.toThrow('only the hub owner');
  expect(cli.skillsAddPr).not.toHaveBeenCalled();
  expect(cli.skillsRemovePr).not.toHaveBeenCalled();
});
