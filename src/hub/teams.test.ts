import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { savePaths } from './projects.js';
import { ensureTeams, listTeams, loadTeams, saveTeams } from './teams.js';

let cfg: string;
beforeEach(async () => {
  cfg = await mkdtemp(join(tmpdir(), 'vanguard-hub-teams-'));
});

describe('teams storage', () => {
  it('round-trips members and repositories', async () => {
    const t = [{ id: 'a', name: 'A', members: [{ login: 'bob', role: 'admin' as const }], repositories: ['/r'] }];
    await saveTeams(cfg, t);
    expect(await loadTeams(cfg)).toEqual(t);
    expect((await listTeams(cfg)).find((x) => x.id === 'a')).toEqual(t[0]);
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
    expect((await listTeams(cfg)).find((x) => x.id === 'default')).toMatchObject({ repositories: ['/a'] });
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
