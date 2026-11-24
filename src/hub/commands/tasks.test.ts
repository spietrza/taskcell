import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { classifyError, type RpcContext } from '../rpc.js';
import { writeAppConfig } from '../app-config.js';
import { dispatchRpc, makeCtx, tmpRepo, tmpGitRepo } from '../test-kit.js';
import { NO_REMOTE_MESSAGE } from '../../wire.js';

vi.mock('../paused.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paused.js')>();
  return {
    ...actual,
    retryPausedTask: vi.fn(actual.retryPausedTask),
    withPausedTasks: vi.fn(actual.withPausedTasks),
  };
});

import { retryPausedTask, withPausedTasks } from '../paused.js';
import { forgetBoardWaiting } from '../asking.js';

describe('tasks', () => {
  test('list_tasks wires paused marker details into the command result', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const base = { id: 'gh-7', title: 'Paused', column: 'queued' as const, state: 'taskcell:rate-limited', paused: { reason: 'provider-limit' as const } };
    const enriched = { ...base, paused: { ...base.paused, until: '2026-11-15T12:00:00.000Z', trigger: 'ready for agent' } };
    vi.mocked(withPausedTasks).mockResolvedValueOnce([enriched]);
    const { ctx } = await makeCtx(repo, { depsOverrides: { listTasks: async () => ({ tasks: [base], capped: false }) } });
    const result = await dispatchRpc(ctx, 'list_tasks', { repoPath: repo });
    expect(result).toEqual({ tasks: [{ ...enriched, view: { place: { at: 0, failed: false } } }], capped: false });
    expect(withPausedTasks).toHaveBeenCalledWith('allowed/repo', [base], ctx.gh, expect.objectContaining({ remaining: 30 }));
  });

  test('list_tasks reads paused pull requests through the injected gh runner, only for a GitHub task source', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return '[]';
    };
    const { ctx } = await makeCtx(repo, { gh, depsOverrides: { listTasks: async () => ({ tasks: [], capped: false }) } });
    expect(await dispatchRpc(ctx, 'list_tasks', { repoPath: repo })).toEqual({ tasks: [], capped: false });
    // The paused reads (two `pr list`) and the cards' waiting items (needs-you: one `issue list`, two `pr list`).
    expect(calls.map((c) => c.slice(0, 2).join(' ')).sort()).toEqual(['issue list', 'pr list', 'pr list', 'pr list', 'pr list']);
    // A project whose task source is not GitHub spawns nothing, github.com origin or not.
    calls.length = 0;
    await writeAppConfig(repo, { source: 'linear' });
    // Not even the cards' waiting items: with the kept read dropped, a Linear project reads its run records only.
    forgetBoardWaiting(repo);
    await dispatchRpc(ctx, 'list_tasks', { repoPath: repo });
    expect(calls).toEqual([]);
  });

  test('the cards\' waiting items are kept briefly, shared, and dropped by a reply or a merge', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return '[]';
    };
    const { ctx } = await makeCtx(repo, { gh, depsOverrides: { listTasks: async () => ({ tasks: [], capped: false }) } });
    const needsYouReads = (): number => calls.filter((c) => c[0] === 'issue' && c[1] === 'list').length;
    await dispatchRpc(ctx, 'list_tasks', { repoPath: repo });
    await dispatchRpc(ctx, 'list_tasks', { repoPath: repo });
    expect(needsYouReads()).toBe(1);
    // A merge (refused here: no such PR) still drops the kept read, so the next board load sees what changed.
    await dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'allowed/repo#1' }).catch(() => {});
    await dispatchRpc(ctx, 'list_tasks', { repoPath: repo });
    expect(needsYouReads()).toBe(2);
  });

  test('T-60 api_create_task substitutes source/team/label from app.json and ignores client values', async () => {
    const repo = await tmpRepo();
    let captured: unknown;
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        createTask: async (p) => {
          captured = p;
          return { id: 'x', url: 'https://x' };
        },
      },
    });
    await writeAppConfig(repo, { source: 'linear', team: 'DEV', label: 'vanguard-ready' });
    await dispatchRpc(ctx, 'api_create_task', {
      repoPath: repo,
      title: 'hello',
      body: 'world',
      // A client-supplied source/team/label must be ignored entirely (not even read).
      source: 'github',
      team: 'ATTACKER',
      label: 'nope',
    });
    expect(captured).toMatchObject({ source: 'linear', team: 'DEV', labels: ['vanguard-ready'], title: 'hello', body: 'world' });
  });

  test('api_create_task forwards dependsOn; api_create_tasks creates in order and turns positions into the created ids', async () => {
    const repo = await tmpRepo();
    const seen: { title: string; dependsOn?: string[] }[] = [];
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        createTask: async (p) => {
          seen.push({ title: p.title, ...(p.dependsOn !== undefined ? { dependsOn: p.dependsOn } : {}) });
          return { id: `ENG-${seen.length}`, url: 'https://x' };
        },
      },
    });
    await writeAppConfig(repo, { source: 'linear', team: 'DEV' });
    await dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 'one', body: 'b', dependsOn: ['ENG-7'] });
    const out = await dispatchRpc(ctx, 'api_create_tasks', {
      repoPath: repo,
      tasks: [{ title: 'a', body: '' }, { title: 'b', body: '', dependsOn: [0] }, { title: 'c', body: '', dependsOn: [0, 1, 1] }],
    });
    expect(seen).toEqual([{ title: 'one', dependsOn: ['ENG-7'] }, { title: 'a' }, { title: 'b', dependsOn: ['ENG-2'] }, { title: 'c', dependsOn: ['ENG-2', 'ENG-3'] }]);
    expect(out).toMatchObject({ tasks: [{ id: 'ENG-2' }, { id: 'ENG-3' }, { id: 'ENG-4' }] });
  });

  test.each([
    ['a forward reference', [{ title: 'a', body: '', dependsOn: [1] }, { title: 'b', body: '' }]],
    ['a self reference', [{ title: 'a', body: '', dependsOn: [0] }]],
    ['a task without a title', [{ title: 'a', body: '' }, { title: ' ', body: '' }]],
    ['an empty list', []],
    ['too many tasks', Array.from({ length: 21 }, () => ({ title: 'a', body: '' }))],
    ['too many dependencies', Array.from({ length: 20 }, (_, i) => ({ title: 'a', body: '', dependsOn: Array.from({ length: i }, (_, j) => j) }))],
  ])('api_create_tasks refuses %s before creating anything', async (_name, tasks) => {
    const repo = await tmpRepo();
    let created = 0;
    const { ctx } = await makeCtx(repo, { depsOverrides: { createTask: async () => (created++, { id: 'x', url: 'https://x' }) } });
    await writeAppConfig(repo, { source: 'linear', team: 'DEV' });
    await expect(dispatchRpc(ctx, 'api_create_tasks', { repoPath: repo, tasks })).rejects.toThrow(/tasks/);
    expect(created).toBe(0);
  });

  test('api_create_tasks accepts 40 dependencies and refuses 41', async () => {
    // task i may depend on tasks 0..i-1; spread n dependencies over 20 tasks
    const plan = (n: number): { title: string; body: string; dependsOn: number[] }[] => {
      let left = n;
      return Array.from({ length: 20 }, (_, i) => {
        const take = Math.min(i, left);
        left -= take;
        return { title: 't', body: '', dependsOn: Array.from({ length: take }, (_, j) => j) };
      });
    };
    for (const [n, ok] of [[40, true], [41, false]] as const) {
      const repo = await tmpRepo();
      let created = 0;
      const { ctx } = await makeCtx(repo, { depsOverrides: { createTask: async () => ({ id: `ENG-${++created}`, url: 'https://x' }) } });
      await writeAppConfig(repo, { source: 'linear', team: 'DEV' });
      const call = dispatchRpc(ctx, 'api_create_tasks', { repoPath: repo, tasks: plan(n) });
      if (ok) await expect(call).resolves.toBeDefined();
      else await expect(call).rejects.toThrow(/at most 40 dependencies/);
      expect(created).toBe(ok ? 20 : 0);
    }
  });

  test('api_create_tasks names what was already created when a later task fails', async () => {
    const repo = await tmpRepo();
    let n = 0;
    const { ctx } = await makeCtx(repo, { depsOverrides: { createTask: async () => (++n === 2 ? Promise.reject(new Error('tracker down')) : { id: `ENG-${n}`, url: 'https://x' }) } });
    await writeAppConfig(repo, { source: 'linear', team: 'DEV' });
    await expect(dispatchRpc(ctx, 'api_create_tasks', { repoPath: repo, tasks: [{ title: 'a', body: '' }, { title: 'b', body: '' }] })).rejects.toThrow(/task 2 of 2 .*tracker down.*ENG-1/);
  });

  test.each([
    ['api_create_task', { title: 't', body: 'b' }],
    ['enable_factory_plan', { provider: 'github' }],
    ['list_remote_runs', {}],
  ])('%s on a repository with no git remote is refused with one sentence, before gh runs', async (cmd, extra) => {
    const repo = await tmpGitRepo();
    let created = false;
    const { ctx } = await makeCtx(repo, { depsOverrides: { createTask: async () => ((created = true), { id: 'x', url: 'https://x' }) } });
    vi.stubEnv('GH_REPO', '');
    const err: unknown = await dispatchRpc(ctx, cmd, { repoPath: repo, ...extra }).catch((e: unknown) => e).finally(() => vi.unstubAllEnvs());
    expect(classifyError(err)).toMatchObject({ kind: 'bad-request', message: NO_REMOTE_MESSAGE });
    expect(created).toBe(false);
  });

  test('with GH_REPO set, gh needs no git remote: a GitHub card is created; a GitLab one is still refused', async () => {
    const repo = await tmpGitRepo();
    let created = 0;
    const { ctx } = await makeCtx(repo, { depsOverrides: { createTask: async () => (created++, { id: 'x', url: 'https://x' }) } });
    vi.stubEnv('GH_REPO', 'o/r');
    try {
      await dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' });
      expect(created).toBe(1);
      await writeAppConfig(repo, { source: 'gitlab' });
      await expect(dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' })).rejects.toThrow(NO_REMOTE_MESSAGE);
      expect(created).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe('target branch', () => {
    async function createWith(cfg: Record<string, string>, extra: Record<string, unknown>): Promise<{ captured: unknown; call: Promise<unknown> }> {
      const repo = await tmpRepo();
      const out: { captured: unknown } = { captured: undefined };
      const { ctx } = await makeCtx(repo, {
        depsOverrides: {
          createTask: async (p) => {
            out.captured = p;
            return { id: 'x', url: 'https://x' };
          },
        },
      });
      await writeAppConfig(repo, cfg);
      return Object.assign(out, { call: dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b', ...extra }) });
    }

    test('api_create_task carries baseBranch as a taskcell:base= label next to the trigger label', async () => {
      const r = await createWith({ label: 'ready', baseBranch: 'dev' }, { baseBranch: ' dev ' });
      await r.call;
      expect(r.captured).toMatchObject({ labels: ['ready', 'taskcell:base=dev'] });
    });

    test('api_create_task adds no base label when baseBranch is absent or blank', async () => {
      const a = await createWith({ label: 'ready' }, {});
      await a.call;
      expect(a.captured).toMatchObject({ labels: ['ready'] });
      const b = await createWith({}, { baseBranch: '  ' });
      await b.call;
      expect((b.captured as { labels?: string[] }).labels).toBeUndefined();
    });

    test.each([
      ['an unsafe name', { baseBranch: '--upload-pack=x' }, /Invalid base branch/],
      ['a name too long for a GitHub label', { baseBranch: 'x'.repeat(40) }, /cannot be carried as a label/],
      ['a name with a comma (GitLab label list)', { baseBranch: 'a,b' }, /cannot be carried as a label/],
    ])('api_create_task refuses %s before anything is created', async (_n, extra, message) => {
      const r = await createWith({}, extra);
      await expect(r.call).rejects.toThrow(message);
      expect(r.captured).toBeUndefined();
    });

    test('api_create_task refuses a target branch outside the committed allowlist', async () => {
      const r = await createWith({}, { baseBranch: 'uat' });
      await expect(r.call).rejects.toThrow(/is not allowed/);
      expect(r.captured).toBeUndefined();
    });

    test('api_create_task refuses a target branch on a Linear card', async () => {
      const r = await createWith({ source: 'linear', team: 'DEV' }, { baseBranch: 'dev' });
      await expect(r.call).rejects.toThrow(/Linear/);
      expect(r.captured).toBeUndefined();
    });

    test('write_app_config refuses an unsafe baseBranch and saves a safe one', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranch: 'a:b' } })).rejects.toThrow(/Invalid base branch/);
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranch: 'dev' } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ baseBranch: 'dev' });
    });

    test.each([
      [{ concurrency: -5 }, /Parallel runs must be a whole number, 1 or more/],
      [{ concurrency: 1.5 }, /Parallel runs/],
      [{ budgetUsd: -1 }, /Budget cap per Run must be 0 or more/],
      [{ usageCapPct: 500 }, /Usage cap % must be from 1 to 100/],
      [{ concurrency: 'two' }, /Parallel runs must be a number/],
      [{ concurrency: 0, usageCapPct: 500 }, /Parallel runs must be a whole number, 1 or more\. Usage cap % must be from 1 to 100/],
    ])('write_app_config refuses the out-of-range number in %j and writes nothing', async (config, message) => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config })).rejects.toThrow(message);
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toEqual({});
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { concurrency: 2, budgetUsd: 2.5, usageCapPct: 80 } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ concurrency: 2, usageCapPct: 80 });
      // A hand-edited numeric string saved on main; it still does.
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { concurrency: '2', label: 'x' } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ concurrency: '2', label: 'x' });
    });

    test('write_app_config refuses an unsafe baseBranches entry', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranches: ['uat', '-x'] } })).rejects.toThrow(/Invalid base branch/);
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranches: ['uat'] } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ baseBranches: ['uat'] });
    });

    test('list_skills names the skills a run of the project can load', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await mkdir(join(repo, '.github/vanguard-skills/db'), { recursive: true });
      await writeFile(join(repo, '.github/vanguard-skills/db/SKILL.md'), '---\nname: db\n---\n');
      expect(((await dispatchRpc(ctx, 'list_skills', { repoPath: repo })) as { skills: string[] }).skills).toContain('db');
    });
    test('list_skills says the skills dir cannot be read, instead of an empty list, without naming a host path', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      vi.stubEnv('SKILLS_DIR', join(repo, 'no-such-dir'));
      const err: unknown = await dispatchRpc(ctx, 'list_skills', { repoPath: repo }).catch((e: unknown) => e).finally(() => vi.unstubAllEnvs());
      expect(classifyError(err)).toMatchObject({ kind: 'bad-request', message: expect.stringMatching(/^Skills cannot be listed: /) });
      expect((err as Error).message).not.toContain('no-such-dir');
      expect((err as Error).message).not.toContain(repo);
    });
    test.each([
      ['a value that is not a list', { taskId: 'gh-1', skills: 'db' }, 'skills must be an array'],
      ['a value that is not a skill id', { taskId: 'gh-1', skills: ['../x'] }, 'expects a skill id'],
      ['a card of no tracker', { taskId: 'draft-1', skills: [] }, 'names no GitHub, GitLab or Linear task'],
      ['a skill that is not installed', { taskId: 'gh-1', skills: ['nope'] }, 'Unknown skill: nope. Installed skills: db.'],
      ['a card of another tracker than the project\'s', { taskId: 'linear-dev-9', skills: ['db'] }, 'not on the project\'s task source'],
    ])('set_task_skills refuses %s before any write', async (_n, extra, message) => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await mkdir(join(repo, '.github/vanguard-skills/db'), { recursive: true });
      await writeFile(join(repo, '.github/vanguard-skills/db/SKILL.md'), '---\nname: db\n---\n');
      const err: unknown = await dispatchRpc(ctx, 'set_task_skills', { repoPath: repo, ...extra }).catch((e: unknown) => e);
      expect(classifyError(err)).toMatchObject({ kind: 'bad-request', message: expect.stringContaining(message) });
    });
    test('list_branches offers only the allowlisted targets plus the configured default', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      expect(await dispatchRpc(ctx, 'list_branches', { repoPath: repo })).toEqual({ branches: ['main'] });
      await writeAppConfig(repo, { baseBranch: 'dev', baseBranches: ['uat', 'main'] });
      expect(await dispatchRpc(ctx, 'list_branches', { repoPath: repo })).toEqual({ branches: ['dev', 'main', 'uat'], default: 'dev' });
    });
  });

  test('api_create_task requires a Linear team key when source is linear and none is configured', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await writeAppConfig(repo, { source: 'linear' });
    await expect(dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' })).rejects.toThrow(/Linear team/);
  });

  test('api_create_task rejects an invalid configured source as bad-request (#493)', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    // app.json can hold any string (no enum at that boundary) — a stale/hand-edited value must still
    // be caught by createTask's own validator, not silently forwarded to the transport.
    await writeAppConfig(repo, { source: 'not-a-real-tracker' });
    try {
      await dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('bad-request');
    }
  });
});

describe('start_task', () => {
  const call = (ctx: RpcContext, repo: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    dispatchRpc(ctx, 'start_task', { repoPath: repo, number: 1, label: 'ready for agent', ...extra });

  test('refuses on a non-loopback bind without mutations allowed', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
    await expect(call(ctx, repo)).rejects.toThrow('disabled on a non-loopback bind');
  });

  test.each(['gitlab', 'linear'])('says %s is not supported yet', async (source) => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    await writeAppConfig(repo, { source });
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo)).rejects.toThrow(`start_task: ${source} is not supported yet`);
  });

  test('refuses a project with no GitHub remote', async () => {
    const repo = await tmpRepo();
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo)).rejects.toThrow('no GitHub remote');
  });

  test('requires a numeric issue number', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo, { number: '1' })).rejects.toThrow('number is required and must be a number');
  });

  test("offers the project's configured trigger label alongside the defaults", async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    await writeAppConfig(repo, { label: 'go' });
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo, { label: 'bug' })).rejects.toThrow('"bug" is not a trigger label of this project (ready for agent, ready for spec, go)');
  });
});

describe('retry_paused_task', () => {
  const call = (ctx: RpcContext, repo: string): Promise<unknown> =>
    dispatchRpc(ctx, 'retry_paused_task', { repoPath: repo, number: 7 });

  test('refuses on a non-loopback bind before touching GitHub', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
    vi.mocked(retryPausedTask).mockClear();
    await expect(call(ctx, repo)).rejects.toThrow('disabled on a non-loopback bind');
    expect(retryPausedTask).not.toHaveBeenCalled();
  });

  test.each(['gitlab', 'linear'])('refuses the %s source before touching GitHub', async (source) => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    await writeAppConfig(repo, { source });
    const { ctx } = await makeCtx(repo);
    vi.mocked(retryPausedTask).mockClear();
    await expect(call(ctx, repo)).rejects.toThrow(`retry_paused_task: ${source} is not supported yet`);
    expect(retryPausedTask).not.toHaveBeenCalled();
  });

  test('delegates with the project trigger labels', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    await writeAppConfig(repo, { label: 'ship it' });
    const { ctx } = await makeCtx(repo);
    vi.mocked(retryPausedTask).mockResolvedValueOnce({ label: 'ship it' });
    await expect(call(ctx, repo)).resolves.toEqual({ label: 'ship it' });
    expect(retryPausedTask).toHaveBeenCalledWith('allowed/repo', 7, ['ready for agent', 'ready for spec', 'ship it']);
  });
});
