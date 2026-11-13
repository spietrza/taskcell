import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as enableFactoryModule from '../enable-factory.js';
import { BadRequestError } from '../../sidecar/sidecar.js';
import type { FactoryPlan } from '../enable-factory.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

describe('enable_factory RPCs', () => {
  // The checklist is persisted in the hub config dir.
  beforeEach(async () => {
    process.env.VANGUARD_HUB_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'factory-cfg-'));
  });

  const validPlan = {
    provider: 'github',
    repoSlug: 'acme/widgets',
    defaultBranch: 'main',
    login: 'octocat',
    packageManager: 'pnpm',
    scripts: { typecheck: true, lint: true, test: true, build: true },
  };

  function spyProvider(existing?: string[]): { seen: FactoryPlan[]; mock: ReturnType<typeof vi.spyOn> } {
    const seen: FactoryPlan[] = [];
    const mock = vi.spyOn(enableFactoryModule, 'enableFactory').mockImplementation(() => ({
      plan: async () => ({ ...validPlan, ...enableFactoryModule.factoryPlanTargets(), ...(existing ? { existingCallerFiles: existing } : {}) }) as FactoryPlan,
      apply: async (plan) => {
        seen.push(plan);
        return { branch: 'vanguard/enable-factory', prUrl: 'https://github.com/acme/widgets/pull/1', labelsCreated: [] };
      },
      secretCommand: (plan) => {
        seen.push(plan);
        return enableFactoryModule.githubSecretCommand(plan);
      },
      verify: async (plan) => {
        seen.push(plan);
        return { dispatched: true, run: { url: 'https://github.com/acme/widgets/actions/runs/5', status: 'queued', conclusion: '' } };
      },
    }));
    return { seen, mock };
  }

  test.each([
    ['login', "octocat'\n    evil: true"],
    ['login', '-octocat'],
    ['login', 'a'.repeat(40)],
    ['repoSlug', 'acme/widgets; rm -rf ~'],
    ['repoSlug', 'acme'],
    ['defaultBranch', '--upload-pack=evil'],
    ['packageManager', 'bun'],
    ['scripts', { typecheck: 'yes' }],
  ] as [string, unknown][])('rejects a plan whose %s is not a valid shape (%s)', async (field, value) => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_secret', { repoPath: repo, plan: { ...validPlan, [field]: value } }))
        .rejects.toThrow(BadRequestError);
      expect(seen).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test('discards client-supplied callerFiles and labels', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_apply', {
        repoPath: repo,
        plan: { ...validPlan, callerFiles: ['../../etc/passwd', '.'], labels: ['evil'] },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.callerFiles).toEqual(enableFactoryModule.factoryPlanTargets().callerFiles);
      expect(seen[0]?.labels).toEqual(enableFactoryModule.factoryPlanTargets().labels);
    } finally {
      mock.mockRestore();
    }
  });

  test('accepts an Enterprise Managed User login (underscore)', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_secret', { repoPath: repo, plan: { ...validPlan, login: 'octo_corp' } });
      expect(seen[0]?.login).toBe('octo_corp');
    } finally {
      mock.mockRestore();
    }
  });

  test.each([
    ['login', 'mallory'],
    ['repoSlug', 'acme/other'],
    ['defaultBranch', 'develop'],
  ])('apply refuses a client plan whose %s differs from the server-side plan', async (field, value) => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: { ...validPlan, [field]: value } }))
        .rejects.toThrow('the plan no longer matches');
      expect(seen).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test('apply uses the server-side plan, not the client echo', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: { ...validPlan, packageManager: 'npm' } });
      expect(seen[0]?.packageManager).toBe('pnpm');
    } finally {
      mock.mockRestore();
    }
  });

  test('requires the plan provider to be github', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: { ...validPlan, provider: 'gitlab' } }))
        .rejects.toThrow('plan.provider must be github');
      expect(seen).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test.each(['enable_factory_apply', 'enable_factory_verify', 'enable_factory_start'])('%s enforces mutation permissions', async (cmd) => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
    const { mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, cmd, { repoPath: repo, plan: validPlan })).rejects.toThrow('disabled on a non-loopback bind');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });

  test('apply and verify persist the checklist; factory_state reads it back', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { mock } = spyProvider();
    try {
      expect(await dispatchRpc(ctx, 'factory_state', { repoPath: repo })).toMatchObject({ state: 'none' });
      await dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: validPlan });
      expect(await dispatchRpc(ctx, 'factory_state', { repoPath: repo })).toMatchObject({
        state: 'setting-up',
        step: 'secret',
        prUrl: 'https://github.com/acme/widgets/pull/1',
      });
    } finally {
      mock.mockRestore();
    }
  });

  test('verify records the dispatched run and marks the callers as on the base', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_verify', { repoPath: repo, plan: validPlan });
      const state = (await dispatchRpc(ctx, 'factory_state', { repoPath: repo })) as { steps: Array<{ id: string; status: string }>; doctor?: { status: string } };
      expect(state.doctor?.status).toBe('queued');
      expect(state.steps.find((x) => x.id === 'merged')?.status).toBe('done');
    } finally {
      mock.mockRestore();
    }
  });

  test('verify with a foreign slug is refused and never changes the stored slug or secret command', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      const foreign = { ...validPlan, repoSlug: 'attacker/sink' };
      // No record yet: nothing is seeded from the client slug.
      await expect(dispatchRpc(ctx, 'enable_factory_verify', { repoPath: repo, plan: foreign })).rejects.toThrow('the plan no longer matches');
      expect(await dispatchRpc(ctx, 'factory_state', { repoPath: repo })).toMatchObject({ state: 'none' });
      // An existing record keeps its slug and command.
      await dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: validPlan });
      await expect(dispatchRpc(ctx, 'enable_factory_verify', { repoPath: repo, plan: foreign })).rejects.toThrow('the plan no longer matches');
      expect(seen.every((p) => p.repoSlug === 'acme/widgets')).toBe(true);
      expect(await dispatchRpc(ctx, 'factory_state', { repoPath: repo })).toMatchObject({
        plan: { repoSlug: 'acme/widgets' },
        secret: { command: 'gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme/widgets' },
      });
    } finally {
      mock.mockRestore();
    }
  });

  test('enable_factory_start needs every caller on the base, then starts at the secret step', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    let { mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_start', { repoPath: repo, plan: validPlan })).rejects.toThrow('not all on the default branch');
      expect(await dispatchRpc(ctx, 'factory_state', { repoPath: repo })).toMatchObject({ state: 'none' });
    } finally {
      mock.mockRestore();
    }
    ({ mock } = spyProvider(enableFactoryModule.factoryPlanTargets().callerFiles));
    try {
      expect(await dispatchRpc(ctx, 'enable_factory_start', { repoPath: repo, plan: validPlan })).toMatchObject({ state: 'setting-up', step: 'secret' });
    } finally {
      mock.mockRestore();
    }
  });

  test('factory_refresh with no checklist is a no-op', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    expect(await dispatchRpc(ctx, 'factory_refresh', { repoPath: repo })).toMatchObject({ state: 'none' });
  });
});
