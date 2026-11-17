import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { dispatchRpc, makeCtx, tmpGitRepo, tmpRepo, type OWNER } from '../test-kit.js';

const cli = vi.hoisted(() => ({
  skillsChecked: vi.fn(),
  skillsUpdate: vi.fn(),
  skillsAddPr: vi.fn(),
  skillsDiscover: vi.fn(),
  skillsRemovePr: vi.fn(),
  recordedMetrics: vi.fn(async () => ''),
  cachedResolver: vi.fn(() => async () => undefined),
}));
vi.mock('../../core/skills.js', () => cli);
const gh = vi.hoisted(() => vi.fn());
vi.mock('../../tasks/github.js', async (orig) => ({ ...(await orig<object>()), defaultGhRunner: gh }));

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
  expect(cli.skillsAddPr).not.toHaveBeenCalled();
  expect(cli.skillsRemovePr).not.toHaveBeenCalled();
});

test('update_skill_pr always asks for a PR and never a dry run, and returns its URL', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsUpdate.mockImplementation(async () => ({ prUrl: PR }));
  expect(await dispatchRpc(ctx, 'update_skill_pr', { repoPath: repo, name: 'a', pr: false })).toEqual({ prUrl: PR });
  expect(cli.skillsUpdate).toHaveBeenCalledWith(expect.objectContaining({ name: 'a', pr: true, dryRun: false }), {}, expect.any(Function));
});

test('an update that opens no PR is an error, not a silent success', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsUpdate.mockImplementation(async (_o: unknown, _d: unknown, out: (l: string) => void) => {
    out('a\tmodified locally → skipped');
    return {};
  });
  await expect(dispatchRpc(ctx, 'update_skill_pr', { repoPath: repo, name: 'a' })).rejects.toThrow('opened no pull request: a\tmodified locally → skipped');
});

test('add and remove open a PR and show its link; a failed add carries the command reason', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsAddPr.mockImplementation(async () => ({ prUrl: PR }));
  cli.skillsRemovePr.mockImplementation(async () => ({ prUrl: PR }));
  expect(await dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s' })).toEqual({ prUrl: PR });
  expect(await dispatchRpc(ctx, 'remove_skill_pr', { repoPath: repo, name: 'a' })).toEqual({ prUrl: PR });
  const { TaskcellError } = await import('../../core/errors.js');
  cli.skillsAddPr.mockRejectedValue(new TaskcellError('Cannot resolve HEAD of https://github.com/o/s.'));
  await expect(dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s' })).rejects.toThrow('Cannot resolve HEAD');
});

test('a #ref on the source is split off as in the CLI', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsAddPr.mockImplementation(async () => ({ prUrl: PR }));
  await dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s#v1' });
  expect(cli.skillsAddPr).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'https://github.com/o/s', ref: 'v1' }));
  await expect(dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/s#' })).rejects.toThrow('empty #ref');
});

test('a GitHub or GitLab browse link is split into source, ref and folder; explicit values win', async () => {
  const { splitSource } = await import('./skills.js');
  expect(splitSource('https://github.com/o/r/tree/main/skills/a')).toEqual({ source: 'https://github.com/o/r', ref: 'main', path: 'skills/a' });
  expect(splitSource('https://github.com/o/r/blob/v1/skills/a/SKILL.md')).toEqual({ source: 'https://github.com/o/r', ref: 'v1', path: 'skills/a' });
  expect(splitSource('https://github.com/o/r/tree/dev')).toEqual({ source: 'https://github.com/o/r', ref: 'dev' });
  expect(splitSource('https://gitlab.com/g/sub/p/-/tree/main/skills/a')).toEqual({ source: 'https://gitlab.com/g/sub/p', ref: 'main', path: 'skills/a' });
  expect(splitSource('https://gitlab.com/g/p/-/blob/main/s/SKILL.md')).toEqual({ source: 'https://gitlab.com/g/p', ref: 'main', path: 's' });
  expect(splitSource('https://github.com/o/r/tree/main/skills/a', 'v2')).toMatchObject({ ref: 'v2', path: 'skills/a' });
  expect(splitSource('https://github.com/o/r')).toEqual({ source: 'https://github.com/o/r' });
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  cli.skillsAddPr.mockImplementation(async () => ({ prUrl: PR }));
  await dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/r/tree/main/skills/a' });
  expect(cli.skillsAddPr).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'https://github.com/o/r', ref: 'main', path: 'skills/a' }));
});

test('discover_skills lists a repository for the owner only, and add_skill_pr takes several paths', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  const found = { commit: 'c'.repeat(40), skills: [{ path: 'skills/a', name: 'a' }] };
  cli.skillsDiscover.mockResolvedValue(found);
  expect(await dispatchRpc(ctx, 'discover_skills', { repoPath: repo, source: 'https://github.com/o/r' })).toEqual(found);
  expect(cli.skillsDiscover).toHaveBeenCalledWith({ source: 'https://github.com/o/r' });
  await expect(dispatchRpc(ctx, 'discover_skills', { repoPath: repo, source: 'https://github.com/o/r' }, outsider)).rejects.toThrow('only the hub owner');
  cli.skillsAddPr.mockImplementation(async () => ({ prUrl: PR }));
  await dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/r', ref: found.commit, paths: ['skills/a', 'skills/b'], name: 'ignored' });
  expect(cli.skillsAddPr).toHaveBeenLastCalledWith(expect.objectContaining({ ref: found.commit, paths: ['skills/a', 'skills/b'] }));
  expect(cli.skillsAddPr.mock.calls.at(-1)?.[0]).not.toHaveProperty('name');
  await expect(dispatchRpc(ctx, 'add_skill_pr', { repoPath: repo, source: 'https://github.com/o/r', paths: [] })).rejects.toThrow('paths must be');
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

test('list_pending_skill_prs lists only open skill-add branches, with the skill names from the title', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  gh.mockResolvedValue(JSON.stringify([
    { number: 29, url: 'https://github.com/allowed/repo/pull/29', title: 'chore(skills): add ponytail, caveman', headRefName: 'chore/taskcell-skills-add-30233a99' },
    { number: 30, url: 'https://github.com/allowed/repo/pull/30', title: 'chore(skills): remove a', headRefName: 'chore/taskcell-skills-remove-1' },
  ]));
  expect(await dispatchRpc(ctx, 'list_pending_skill_prs', { repoPath: repo })).toEqual({
    prs: [{ number: 29, url: 'https://github.com/allowed/repo/pull/29', names: ['ponytail', 'caveman'] }],
  });
  expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['--repo', 'allowed/repo', '--state', 'open']));
  await expect(dispatchRpc(ctx, 'list_pending_skill_prs', { repoPath: repo }, outsider)).rejects.toThrow('only the hub owner');
});
