import type { Caller } from './teams.js';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { classifyError, type RpcContext } from './rpc.js';
import { loadPaths, savePaths } from './projects.js';
import { saveTeams } from './teams.js';
import { ProjectAllowlist } from './allowlist.js';
import { writeAppConfig } from './app-config.js';
import { BadRequestError, runSidecar, type SidecarDeps } from '../sidecar/sidecar.js';
import { TaskcellError } from '../core/errors.js';
import { fakeDeps, dispatchRpc, makeCtx, tmpRepo, tmpGitRepo, cleanups } from './test-kit.js';

describe('dispatchRpc team scoping', () => {
  const user = (login: string, extra: { name?: string; verified?: boolean } = {}): Caller => ({
    user: { id: login, email: `${login}@x.test`, name: extra.name ?? login, emailVerified: extra.verified ?? false },
    owner: false,
  });

  async function setup() {
    const a = await tmpGitRepo();
    const b = await tmpGitRepo();
    const { ctx } = await makeCtx(a, { depsOverrides: { listTasks: async () => ({ tasks: [{ id: 't' }] as never, capped: false }) } });
    ctx.allowlist = new ProjectAllowlist(async () => [a, b]);
    await savePaths(ctx.configDir, [a, b]);
    await saveTeams(ctx.configDir, [
      { id: 'one', name: 'One', members: [{ login: 'ann', role: 'admin' }, { login: 'mia', role: 'member' }], repositories: [a] },
      { id: 'two', name: 'Two', members: [{ login: 'bob', role: 'admin' }], repositories: [b] },
    ]);
    return { ctx, a, b };
  }

  test('every list returns only the selected team\'s repositories', async () => {
    const { ctx, a } = await setup();
    const ann = user('ann');
    const read = async (cmd: string, caller: Caller): Promise<string[]> => {
      const r = (await dispatchRpc(ctx, cmd, {}, caller)) as Record<string, { repoPath: string }[]>;
      return [...(r.tasks ?? r.runs ?? r.items ?? []), ...(r.failures ?? [])].map((i) => i.repoPath);
    };
    expect(((await dispatchRpc(ctx, 'list_projects', {}, ann)) as { path: string }[]).map((p) => p.path)).toEqual([a]);
    expect(await read('list_tasks_all', ann)).toEqual([a]);
    expect(await read('list_runs_all', ann)).toEqual([]);
    expect(await read('list_needs_you_all', ann)).toEqual([]);
    expect(await dispatchRpc(ctx, 'list_projects', {}, user('nobody'))).toEqual([]);
  });

  test('a repository outside the caller\'s teams is refused, including a run, a session and a file', async () => {
    const { ctx, b } = await setup();
    const ann = user('ann');
    const refused = /not in any of your teams/;
    await expect(dispatchRpc(ctx, 'list_runs', { repoPath: b }, ann)).rejects.toThrow(refused);
    await expect(dispatchRpc(ctx, 'read_run', { repoPath: b, taskId: 't', timestamp: 'x', source: { kind: 'local' } }, ann)).rejects.toThrow(refused);
    await expect(dispatchRpc(ctx, 'api_read_repo_file', { repoPath: b, path: 'README.md' }, ann)).rejects.toThrow(refused);
    const session = join(b, '.taskcell', 'sessions', 't', 's.jsonl');
    await mkdir(dirname(session), { recursive: true });
    await writeFile(session, '');
    await expect(dispatchRpc(ctx, 'read_session', { sessionFile: session }, ann)).rejects.toThrow(refused);
    await expect(dispatchRpc(ctx, 'list_projects', { teamId: 'two' }, ann)).rejects.toThrow(/not a member of team/);
  });

  test('membership is the id or a verified e-mail, never the editable display name', async () => {
    const { ctx, a } = await setup();
    const spoof = user('evil', { name: 'ANN' });
    expect(await dispatchRpc(ctx, 'list_projects', {}, spoof)).toEqual([]);
    await expect(dispatchRpc(ctx, 'add_team_member', { teamId: 'one', login: 'x', role: 'admin' }, spoof)).rejects.toThrow(/not a member/);
    const unverified = { user: { id: 'u1', email: 'ann', name: 'u1', emailVerified: false }, owner: false };
    expect(await dispatchRpc(ctx, 'list_projects', {}, unverified)).toEqual([]);
    const verified = { user: { id: 'u1', email: 'ann', name: 'u1', emailVerified: true }, owner: false };
    expect(((await dispatchRpc(ctx, 'list_projects', {}, verified)) as { path: string }[]).map((p) => p.path)).toEqual([a]);
  });

  test('a member cannot change members or repositories; an admin can', async () => {
    const { ctx, a, b } = await setup();
    const mia = user('mia');
    const ann = user('ann');
    const admin = /only a team admin/;
    await expect(dispatchRpc(ctx, 'add_team_member', { teamId: 'one', login: 'zed', role: 'member' }, mia)).rejects.toThrow(admin);
    await expect(dispatchRpc(ctx, 'remove_team_member', { teamId: 'one', login: 'ann' }, mia)).rejects.toThrow(admin);
    await expect(dispatchRpc(ctx, 'add_team_repository', { teamId: 'one', path: a }, mia)).rejects.toThrow(admin);
    await expect(dispatchRpc(ctx, 'remove_team_repository', { teamId: 'one', path: a }, mia)).rejects.toThrow(admin);
    const added = (await dispatchRpc(ctx, 'add_team_member', { teamId: 'one', login: 'zed', role: 'member' }, ann)) as { members: { login: string }[] };
    expect(added.members.map((m) => m.login)).toContain('zed');
    const removed = (await dispatchRpc(ctx, 'remove_team_member', { teamId: 'one', login: 'zed' }, ann)) as { members: { login: string }[] };
    expect(removed.members.map((m) => m.login)).not.toContain('zed');
    // ann holds no team with `b`, so she cannot attach it.
    await expect(dispatchRpc(ctx, 'add_team_repository', { teamId: 'one', path: b }, ann)).rejects.toThrow(/not in any of your teams/);
    // The last admin cannot leave or be demoted.
    await expect(dispatchRpc(ctx, 'remove_team_member', { teamId: 'one', login: 'ann' }, ann)).rejects.toThrow(/at least one admin/);
    await expect(dispatchRpc(ctx, 'add_team_member', { teamId: 'one', login: 'ann', role: 'member' }, ann)).rejects.toThrow(/at least one admin/);
  });

  test('project add/remove/clone and credentials are owner-only; a hub-wide remove leaves every team', async () => {
    const { ctx, b } = await setup();
    const ann = user('ann');
    const owner = /only the hub owner/;
    for (const [cmd, args] of [['add_project', { path: b }], ['remove_project', { path: b }], ['clone_project', { url: 'u', parentDir: 'p' }], ['get_credentials', {}], ['set_credential', { provider: 'claude', value: 'x' }], ['delete_credential', { provider: 'claude' }], ['list_spawns', {}], ['browse_dirs', {}]] as const) {
      await expect(dispatchRpc(ctx, cmd, args, ann)).rejects.toThrow(owner);
    }
    await dispatchRpc(ctx, 'remove_project', { path: b });
    expect(((await dispatchRpc(ctx, 'list_teams', {})) as { repositories: string[] }[]).find((t) => t.repositories.includes(b))).toBeUndefined();
  });

  test('run-session commands only reach the caller\'s repositories', async () => {
    const { ctx, a, b } = await setup();
    const ann = user('ann');
    ctx.runSession.activeRun = () => ({ runId: 'rb', repoPath: b });
    ctx.runSession.queued = () => [{ runId: 'ra', repoPath: a, position: 1 }, { runId: 'rb2', repoPath: b, position: 2 }];
    expect(await dispatchRpc(ctx, 'api_active_run', {}, ann)).toBeNull();
    expect(await dispatchRpc(ctx, 'api_queue', {}, ann)).toEqual([{ runId: 'ra', repoPath: a, position: 1 }]);
    await expect(dispatchRpc(ctx, 'api_run_backlog', { runId: 'rb' }, ann)).rejects.toThrow(/not in any of your teams/);
    await expect(dispatchRpc(ctx, 'api_cancel', { runId: 'rb' }, ann)).rejects.toThrow(/not in any of your teams/);
    expect(await dispatchRpc(ctx, 'api_active_run', {})).toEqual({ runId: 'rb', repoPath: b });
  });

  test('a team repository is stored as the registered project path, so a symlink lists and removes', async () => {
    const { ctx, a, b } = await setup();
    const link = `${b}-link`;
    await symlink(b, link);
    cleanups.push(link);
    await saveTeams(ctx.configDir, [{ id: 'one', name: 'One', members: [{ login: 'ann', role: 'admin' }], repositories: [a] }, { id: 'default', name: 'D', members: [], repositories: [] }]);
    const t = (await dispatchRpc(ctx, 'add_team_repository', { teamId: 'one', path: link })) as { repositories: string[] };
    expect(t.repositories).toEqual([a, b]);
    expect(((await dispatchRpc(ctx, 'list_projects', { teamId: 'one' })) as { path: string }[]).map((p) => p.path)).toEqual([a, b]);
    const r = (await dispatchRpc(ctx, 'remove_team_repository', { teamId: 'one', path: link })) as { repositories: string[] };
    expect(r.repositories).toEqual([a]);
  });

  test('the owner (token-only mode) is admin of everything and unfiltered', async () => {
    const { ctx, a, b } = await setup();
    expect(((await dispatchRpc(ctx, 'list_projects', {})) as unknown[]).length).toBe(2);
    await expect(dispatchRpc(ctx, 'list_runs', { repoPath: b })).resolves.toEqual([]);
    const team = (await dispatchRpc(ctx, 'add_team_member', { teamId: 'two', login: 'q', role: 'admin' })) as { members: unknown[] };
    expect(team.members).toHaveLength(2);
    expect(((await dispatchRpc(ctx, 'list_projects', { teamId: 'one' })) as { path: string }[]).map((p) => p.path)).toEqual([a]);
  });
});

describe('dispatchRpc', () => {
  test('T-54 dispatches commands with their exact camelCase args to the right handler', async () => {
    const repo = await tmpRepo();
    let seenCapabilities = false;
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        capabilities: () => {
          seenCapabilities = true;
          return { providers: [], flows: [], stages: [], transports: [], defaults: { provider: 'claude', maxTurns: 1, maxCostUsd: 1, baseBranch: 'main' } };
        },
        listFlows: async (p) => {
          expect(p.repoPath).toBe(await ctx.allowlist.assertAllowed(repo));
          return { flows: [] };
        },
      },
    });
    await dispatchRpc(ctx, 'api_capabilities', {});
    expect(seenCapabilities).toBe(true);
    await dispatchRpc(ctx, 'api_list_flows', { repoPath: repo });
    const runs = await dispatchRpc(ctx, 'list_runs', { repoPath: repo });
    expect(runs).toEqual([]);
  });

  test('T-55 unknown command classifies as a 404-flavored bad-request', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await expect(dispatchRpc(ctx, 'totally_bogus', {})).rejects.toThrow(/unknown command/);
    try {
      await dispatchRpc(ctx, 'totally_bogus', {});
      expect.unreachable();
    } catch (e) {
      const classified = classifyError(e);
      expect(classified.kind).toBe('bad-request');
      expect(classified.notFound).toBe(true);
    }
  });

  test('T-56 BadRequestError classifies bad-request, other throws classify internal', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    try {
      await dispatchRpc(ctx, 'list_runs', { repoPath: '/not/allowed' });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('bad-request');
    }

    const { ctx: ctx2 } = await makeCtx(repo, {
      depsOverrides: {
        listFlows: async () => {
          throw new Error('fault');
        },
      },
    });
    try {
      await dispatchRpc(ctx2, 'api_list_flows', { repoPath: repo });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('internal');
    }
  });

  test('T-57 void commands return null, never undefined', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await writeAppConfig(repo, {});
    const result = await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'x' } });
    expect(result).toBeNull();
    const cancelResult = await dispatchRpc(ctx, 'api_cancel', { runId: 'run-unknown' });
    expect(cancelResult).toBeNull();
  });

  test('api_cancel requires a runId instead of falling back to the active run', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    for (const args of [{}, { runId: 123 }, { runId: null }, { runId: '  ' }]) {
      await expect(dispatchRpc(ctx, 'api_cancel', args)).rejects.toThrow(/runId is required/);
    }
  });

  test('api_queue returns the session queue', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    expect(await dispatchRpc(ctx, 'api_queue', {})).toEqual([]);
  });

  test('T-59 a repoPath outside the allowlist is refused for every path-taking command', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const outside = await mkdtemp(join(tmpdir(), 'vanguard-hub-outside-'));
    cleanups.push(outside);
    const cases: [string, Record<string, unknown>][] = [
      ['list_runs', { repoPath: outside }],
      ['list_active', { repoPath: outside }],
      ['read_app_config', { repoPath: outside }],
      ['list_drafts', { repoPath: outside }],
      ['list_remote_runs', { repoPath: outside }],
      ['list_tasks', { repoPath: outside }],
      ['api_list_flows', { repoPath: outside }],
      ['api_repo_ok', { repoPath: outside }],
      ['watch_project', { repoPath: outside }],
    ];
    for (const [cmd, args] of cases) {
      if (cmd === 'api_repo_ok') {
        await expect(dispatchRpc(ctx, cmd, args)).resolves.toBe(false);
        continue;
      }
      await expect(dispatchRpc(ctx, cmd, args)).rejects.toThrow(/not an allowed project/);
    }
  });

  test('BadRequestError, TaskcellError and a generic Error classify identically on the sidecar and hub paths', async () => {
    const repo = await tmpRepo();
    async function* lines(...ls: string[]): AsyncIterable<string> {
      for (const l of ls) yield l;
    }
    const cases = [new BadRequestError('bad request'), new TaskcellError('vanguard failure'), new Error('generic failure')];
    for (const err of cases) {
      const out: string[] = [];
      await runSidecar(
        lines(JSON.stringify({ id: 'x', method: 'listFlows', params: { repoPath: '/abs' } })),
        (l) => out.push(l),
        fakeDeps({
          listFlows: async () => {
            throw err;
          },
        }),
      );
      const sidecarKind = (JSON.parse(out[0]!) as { error: { kind: string } }).error.kind;

      const { ctx } = await makeCtx(repo, {
        depsOverrides: {
          listFlows: async () => {
            throw err;
          },
        },
      });
      let hubKind: string | undefined;
      try {
        await dispatchRpc(ctx, 'api_list_flows', { repoPath: repo });
        expect.unreachable();
      } catch (e) {
        hubKind = classifyError(e).kind;
      }
      expect(hubKind).toBe(sidecarKind);
    }
  });
});

describe('all-repositories lists', () => {
  async function twoRepoCtx(listTasks: SidecarDeps['listTasks']): Promise<{ ctx: RpcContext; a: string; b: string }> {
    const a = await tmpRepo();
    const b = await tmpRepo();
    const { ctx } = await makeCtx(a, { depsOverrides: { listTasks } });
    await savePaths(ctx.configDir, [a, b]);
    ctx.allowlist = new ProjectAllowlist(() => loadPaths(ctx.configDir), a);
    return { ctx, a, b };
  }
  const task = (id: string): { id: string; title: string; column: 'queued'; state: string } => ({ id, title: id, column: 'queued', state: 'queued' });
  const noTasks: SidecarDeps['listTasks'] = async () => ({ tasks: [], capped: false });

  test('list_tasks_all stamps every card with its repository', async () => {
    const { ctx, a, b } = await twoRepoCtx(async (p) => ({ tasks: [task(p.repoPath.includes('x') ? 'x' : 't')], capped: false }));
    const out = (await dispatchRpc(ctx, 'list_tasks_all', {})) as { tasks: { repoPath: string; repoName: string }[]; failures: unknown[] };
    expect(out.failures).toEqual([]);
    expect(out.tasks.map((t) => t.repoPath).sort()).toEqual([a, b].sort());
    expect(out.tasks.every((t) => t.repoName.length > 0)).toBe(true);
  });

  test('list_tasks_all returns the other repositories and names the failing one', async () => {
    const { ctx, a, b } = await twoRepoCtx(async (p) => {
      if (p.repoPath === b) throw new Error('tracker down');
      return { tasks: [task('ok')], capped: true };
    });
    const out = (await dispatchRpc(ctx, 'list_tasks_all', {})) as { tasks: { repoPath: string }[]; capped: boolean; failures: { repoPath: string; error: string }[] };
    expect(out.tasks.map((t) => t.repoPath)).toEqual([a]);
    expect(out.capped).toBe(true);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ repoPath: b, error: 'tracker down' });
  });

  const writeRun = async (repo: string, taskId: string, timestamp: string): Promise<void> => {
    const dir = join(repo, '.taskcell', 'runs', taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${timestamp.replace(/[:.]/g, '-')}-implement.json`),
      JSON.stringify({ taskId, completed: true, exitReason: 'completed', turns: 1, worktreePath: '/tmp/wt', worktreePreserved: false, finalText: 'ok', costUsd: 0.1, timestamp, stage: 'implement' }),
    );
  };

  test('list_runs_all stamps each run with its repository', async () => {
    const a = await tmpRepo();
    const { ctx } = await makeCtx(a);
    await savePaths(ctx.configDir, [a]);
    ctx.allowlist = new ProjectAllowlist(() => loadPaths(ctx.configDir), a);
    await writeRun(a, 'task-1', '2026-07-06T19:12:02.123Z');
    const out = (await dispatchRpc(ctx, 'list_runs_all', {})) as { runs: { taskId: string; repoPath: string; repoName: string }[] };
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ taskId: 'task-1', repoPath: a });
    expect(out.runs[0]?.repoName.length).toBeGreaterThan(0);
  });

  test('list_runs_all lists every repository newest-first', async () => {
    const { ctx, a, b } = await twoRepoCtx(noTasks);
    await writeRun(a, 'old-a', '2026-07-01T10:00:00.000Z');
    await writeRun(b, 'mid-b', '2026-07-02T10:00:00.000Z');
    await writeRun(a, 'new-a', '2026-07-03T10:00:00.000Z');
    const out = (await dispatchRpc(ctx, 'list_runs_all', {})) as { runs: { taskId: string; repoPath: string }[] };
    expect(out.runs.map((r) => [r.taskId, r.repoPath])).toEqual([
      ['new-a', a],
      ['mid-b', b],
      ['old-a', a],
    ]);
  });

  test('list_runs_all isolates a repository outside the allowlist', async () => {
    const a = await tmpRepo();
    const { ctx } = await makeCtx(a);
    await savePaths(ctx.configDir, [a, '/not/allowed/anywhere']);
    const out = (await dispatchRpc(ctx, 'list_runs_all', {})) as { runs: unknown[]; failures: { repoPath: string }[] };
    expect(out.runs).toEqual([]);
    expect(out.failures.map((f) => f.repoPath)).toEqual(['/not/allowed/anywhere']);
  });

  test('list_needs_you_all is empty for repositories without a GitHub remote', async () => {
    const { ctx } = await twoRepoCtx(noTasks);
    expect(await dispatchRpc(ctx, 'list_needs_you_all', {})).toEqual({ items: [], failures: [] });
  });
});
