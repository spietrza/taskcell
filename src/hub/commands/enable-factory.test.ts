import { describe, expect, test, vi } from 'vitest';
import * as enableFactoryModule from '../enable-factory.js';
import { BadRequestError } from '../../sidecar/sidecar.js';
import type { FactoryPlan } from '../enable-factory.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

describe('enable_factory RPCs', () => {
  const validPlan = {
    provider: 'github',
    repoSlug: 'acme/widgets',
    defaultBranch: 'main',
    login: 'octocat',
    packageManager: 'pnpm',
    scripts: { typecheck: true, lint: true, test: true, build: true },
  };

  function spyProvider(): { seen: FactoryPlan[]; mock: ReturnType<typeof vi.spyOn> } {
    const seen: FactoryPlan[] = [];
    const mock = vi.spyOn(enableFactoryModule, 'enableFactory').mockImplementation(() => ({
      plan: async () => ({ ...validPlan, ...enableFactoryModule.factoryPlanTargets() }) as FactoryPlan,
      apply: async (plan) => {
        seen.push(plan);
        return { branch: 'vanguard/enable-factory', prUrl: 'https://example/pr/1', labelsCreated: [] };
      },
      secretCommand: (plan) => {
        seen.push(plan);
        return enableFactoryModule.githubSecretCommand(plan);
      },
      verify: async (plan) => {
        seen.push(plan);
        return { dispatched: true };
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

  test.each(['enable_factory_apply', 'enable_factory_verify'])('%s enforces mutation permissions', async (cmd) => {
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
});
