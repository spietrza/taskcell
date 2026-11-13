import { execa } from 'execa';
import { describe, expect, test } from 'vitest';
import { classifyError, type RpcContext } from '../rpc.js';
import { writeAppConfig } from '../app-config.js';
import { dispatchRpc, makeCtx, tmpRepo, tmpGitRepo } from '../test-kit.js';

describe('tasks', () => {
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

    test('api_create_task carries baseBranch as a vanguard:base= label next to the trigger label', async () => {
      const r = await createWith({ label: 'ready', baseBranch: 'dev' }, { baseBranch: ' dev ' });
      await r.call;
      expect(r.captured).toMatchObject({ labels: ['ready', 'vanguard:base=dev'] });
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

    test('write_app_config refuses an unsafe baseBranches entry', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranches: ['uat', '-x'] } })).rejects.toThrow(/Invalid base branch/);
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranches: ['uat'] } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ baseBranches: ['uat'] });
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
