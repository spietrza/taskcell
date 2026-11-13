import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { savePaths } from './projects.js';
import { ensureTeams, getTeam, listTeams, loadTeams, roleOf, saveTeams, updateTeam, visibleTeams, withMember, withoutMember, withoutRepository, withRepository, withRole } from './teams.js';

let cfg: string;
beforeEach(async () => {
  cfg = await mkdtemp(join(tmpdir(), 'vanguard-hub-teams-'));
});

describe('teams storage', () => {
  it('round-trips members and repositories', async () => {
    const t = [{ id: 'a', name: 'A', members: [{ login: 'bob', role: 'admin' as const }], repositories: ['/r'] }];
    await saveTeams(cfg, t);
    expect(await loadTeams(cfg)).toEqual(t);
    expect(await getTeam(cfg, 'a')).toEqual(t[0]);
    expect(await getTeam(cfg, 'zz')).toBeUndefined();
  });
});

describe('migration', () => {
  it('puts every existing project in one default team', async () => {
    await savePaths(cfg, ['/a', '/b']);
    const teams = await listTeams(cfg);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.repositories).toEqual(['/a', '/b']);
  });

  it('running twice changes nothing', async () => {
    await savePaths(cfg, ['/a']);
    await ensureTeams(cfg);
    const first = await readFile(join(cfg, 'teams.json'), 'utf8');
    await ensureTeams(cfg);
    expect(await readFile(join(cfg, 'teams.json'), 'utf8')).toBe(first);
    expect(await listTeams(cfg)).toHaveLength(1);
  });

  it('rebuilds from the project list when the teams file is corrupt, keeping a copy and leaving projects intact', async () => {
    await savePaths(cfg, ['/a', '/b']);
    await writeFile(join(cfg, 'teams.json'), '{not json');
    const teams = await ensureTeams(cfg);
    expect(teams[0]!.repositories).toEqual(['/a', '/b']);
    expect(await readFile(join(cfg, 'teams.json.corrupt'), 'utf8')).toBe('{not json');
    expect(JSON.parse(await readFile(join(cfg, 'projects.json'), 'utf8'))).toEqual(['/a', '/b']);
  });

  it('keeps other teams and re-syncs the default team after add/remove', async () => {
    await savePaths(cfg, ['/a']);
    const [def] = await ensureTeams(cfg);
    await saveTeams(cfg, [def!, { id: 'x', name: 'X', members: [{ login: 'bob', role: 'member' }], repositories: ['/q'] }]);
    await savePaths(cfg, ['/b']);
    const teams = await listTeams(cfg);
    expect(teams[0]!.repositories).toEqual(['/b']);
    expect(teams[1]!.members).toEqual([{ login: 'bob', role: 'member' }]);
  });

  it('reads never write the teams file', async () => {
    await savePaths(cfg, ['/a']);
    expect(await listTeams(cfg)).toEqual([{ id: 'default', name: 'Default', members: [], repositories: ['/a'] }]);
    expect(await getTeam(cfg, 'default')).toMatchObject({ repositories: ['/a'] });
    await expect(readFile(join(cfg, 'teams.json'), 'utf8')).rejects.toThrow();
  });

  it('survives concurrent first reads', async () => {
    await savePaths(cfg, ['/a']);
    const r = await Promise.all(Array.from({ length: 8 }, () => listTeams(cfg)));
    expect(r.every((t) => t.length === 1)).toBe(true);
  });

  it('throws on a non-ENOENT read error instead of overwriting', async () => {
    await mkdir(join(cfg, 'teams.json'));
    await expect(ensureTeams(cfg)).rejects.toThrow();
  });

  it('works with no projects and no teams file', async () => {
    expect(await ensureTeams(cfg)).toEqual([{ id: 'default', name: 'Default', members: [], repositories: [] }]);
  });
});

describe('team edits', () => {
  const team = {
    id: 't',
    name: 'T',
    members: [
      { login: 'ann', role: 'admin' as const },
      { login: 'bob', role: 'member' as const },
    ],
    repositories: ['/a'],
  };

  it('adds, re-roles and removes members', () => {
    const added = withMember(team, '@cy', 'member');
    expect(added.members.map((m) => m.login)).toEqual(['ann', 'bob', 'cy']);
    expect(() => withMember(added, 'CY', 'member')).toThrow(/already/);
    expect(withRole(team, 'bob', 'admin').members[1]!.role).toBe('admin');
    expect(withoutMember(team, 'bob').members).toHaveLength(1);
  });

  it('never removes or demotes the last admin', () => {
    expect(() => withoutMember(team, 'ann')).toThrow(/last admin/);
    expect(() => withRole(team, 'ann', 'member')).toThrow(/last admin/);
    const two = withRole(team, 'bob', 'admin');
    expect(withoutMember(two, 'ann').members).toEqual([{ login: 'bob', role: 'admin' }]);
    expect(withRole(two, 'ann', 'member').members[0]!.role).toBe('member');
  });

  it('adds and removes repositories, except on the default team', () => {
    expect(withRepository(team, '/b').repositories).toEqual(['/a', '/b']);
    expect(withoutRepository(team, '/a').repositories).toEqual([]);
    expect(() => withRepository({ ...team, id: 'default' }, '/b')).toThrow(/default team/);
  });

  it('updateTeam persists the edit', async () => {
    await saveTeams(cfg, [team]);
    await updateTeam(cfg, 't', (t) => withMember(t, 'cy', 'member'));
    expect((await getTeam(cfg, 't'))!.members).toHaveLength(3);
    await expect(updateTeam(cfg, 't', (t) => withoutMember(t, 'ann'))).rejects.toThrow(/last admin/);
  });

  it('roleOf matches the provider login case-insensitively, and nothing else', () => {
    expect(roleOf(team, 'github:BOB')).toBe('member');
    expect(roleOf(team, 'gitlab:ann')).toBe('admin');
    expect(roleOf(team, 'github:zed')).toBeUndefined();
    expect(roleOf(team, undefined)).toBeUndefined();
  });

  it('visibleTeams: member teams plus teams with no members', () => {
    const empty = { ...team, id: 'e', members: [] };
    expect(visibleTeams([team, empty], 'github:bob').map((t) => t.id)).toEqual(['t', 'e']);
    expect(visibleTeams([team, empty], 'github:zed').map((t) => t.id)).toEqual(['e']);
  });

  it('login edits normalise like adds', () => {
    expect(withRole(team, '@BOB', 'admin').members[1]!.role).toBe('admin');
    expect(withoutMember(team, ' @bob ').members).toHaveLength(1);
  });
});
