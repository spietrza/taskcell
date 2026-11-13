import type { Caller } from '../teams.js';
import { describe, expect, test } from 'vitest';
import { savePaths } from '../projects.js';
import { saveTeams } from '../teams.js';
import { dispatchRpc, makeCtx, tmpGitRepo } from '../test-kit.js';

describe('dispatchRpc teams', () => {
  test('list_teams / get_team return the default team and track project changes', async () => {
    const repo = await tmpGitRepo();
    const { ctx } = await makeCtx(repo);
    await savePaths(ctx.configDir, [repo]);
    const teams = (await dispatchRpc(ctx, 'list_teams', {})) as { id: string; repositories: string[] }[];
    expect(teams).toHaveLength(1);
    expect(teams[0]!.repositories).toEqual([repo]);
    await dispatchRpc(ctx, 'remove_project', { path: repo });
    expect(await dispatchRpc(ctx, 'get_team', { id: teams[0]!.id })).toMatchObject({ repositories: [] });
    expect(await dispatchRpc(ctx, 'get_team', { id: 'nope' })).toBeNull();
  });
});

describe('team_role', () => {
  test('a member reads their role, the owner is admin everywhere, a stranger gets null', async () => {
    const repo = await tmpGitRepo();
    const { ctx } = await makeCtx(repo);
    await saveTeams(ctx.configDir, [
      { id: 't', name: 'T', members: [{ login: 'ann', role: 'admin' }, { login: 'bob', role: 'member' }], repositories: [] },
    ]);
    const as = (id: string): Caller => ({ user: { id, email: `${id}@x.test`, name: 'ann' }, owner: false });
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, as('bob'))).toBe('member');
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, as('ann'))).toBe('admin');
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' })).toBe('admin');
    // The display name "ann" grants nothing; an unknown team is null too.
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, as('mallory'))).toBeNull();
    expect(await dispatchRpc(ctx, 'team_role', { id: 'nope' }, as('ann'))).toBeNull();
  });
});
