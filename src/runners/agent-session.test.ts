import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openAgentSession, buildSessionSandbox, runCredentialContext } from './agent-session.js';
import { UsageCapError, recordUtilization, resetUtilization } from '../core/usage-cap.js';
import * as registry from '../agents/registry.js';
import type { DockerSandboxProvider } from '../sandbox/docker.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider } from '../agents/provider.js';

const agent = { name: 'claude' } as unknown as AgentProvider;
const injected = { agent, secrets: {}, proxySecrets: {}, injectAnthropicAuth: true };
const fakeSandbox = {} as IsolatedSandboxProvider;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetUtilization();
});

describe('usage cap', () => {
  it('refuses to open a session when the provider is at the cap', async () => {
    vi.stubEnv('TASKCELL_USAGE_CAP_PCT', '80');
    recordUtilization('claude', { pct: 95, resetsAt: new Date(Date.now() + 3_600_000) } as never);
    await expect(openAgentSession({ choice: {}, repoPath: '/x', agents: injected, sandbox: fakeSandbox })).rejects.toBeInstanceOf(UsageCapError);
  });

  it("usageCap 'stages' leaves the check to runStages (a fallback can take over)", async () => {
    vi.stubEnv('TASKCELL_USAGE_CAP_PCT', '80');
    recordUtilization('claude', { pct: 95, resetsAt: new Date(Date.now() + 3_600_000) } as never);
    const s = await openAgentSession({ choice: {}, repoPath: '/x', agents: injected, sandbox: fakeSandbox, usageCap: 'stages' });
    await s.close();
  });

  it('opens when no cap is set', async () => {
    const s = await openAgentSession({ choice: {}, repoPath: '/x', agents: injected, sandbox: fakeSandbox });
    expect(s.agents.agent).toBe(agent);
    await s.close();
  });
});

describe('credential source', () => {
  it('selects agents from the run credential env, not process.env', async () => {
    const providerEnv = { ANTHROPIC_API_KEY: 'run-key' };
    const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue(injected);
    const s = await openAgentSession({ choice: { providerEnv, credentialSource: 'instance' }, repoPath: '/x', sandbox: fakeSandbox });
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), providerEnv, { proxyMode: false });
    expect(s.credentials.env).toBe(providerEnv);
    expect(s.credentials.source).toBe('instance');
    await s.close();
  });

  it('defaults to process.env and passes proxyMode through', async () => {
    const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue(injected);
    const s = await openAgentSession({ choice: {}, repoPath: '/x', sandbox: fakeSandbox, sandboxContext: { proxyMode: true } });
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), process.env, { proxyMode: true });
    await s.close();
  });

  it('masks both the run env and the host env', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-secret-key-value');
    const ctx = runCredentialContext({ providerEnv: { ANTHROPIC_API_KEY: 'run-secret-key-value' } });
    expect(ctx.secretValues()).toEqual(expect.arrayContaining(['host-secret-key-value', 'run-secret-key-value']));
  });
});

describe('teardown', () => {
  const ctxFor = (destroy: () => Promise<void>): never => ({ sandbox: { destroy }, log: { warn: vi.fn() }, wm: { isDirty: async () => true }, worktreePath: '/w' }) as never;

  it('close disposes the prepared context once and is idempotent', async () => {
    const destroy = vi.fn(async () => {});
    const core = await import('../core/taskcell.js');
    vi.spyOn(core, 'prepareContext').mockResolvedValue(ctxFor(destroy));
    const s = await openAgentSession({ choice: {}, repoPath: '/x', agents: injected, sandbox: fakeSandbox });
    await s.prepare({ taskId: 't', localRepoPath: '/x', baseBranch: 'main', start: 'base' });
    await s.close();
    expect(destroy).toHaveBeenCalledTimes(1);
    await s.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('prepare is single-use: a second call throws instead of leaking the first context', async () => {
    const core = await import('../core/taskcell.js');
    vi.spyOn(core, 'prepareContext').mockResolvedValue(ctxFor(vi.fn(async () => {})));
    const s = await openAgentSession({ choice: {}, repoPath: '/x', agents: injected, sandbox: fakeSandbox });
    const input = { taskId: 't', localRepoPath: '/x', baseBranch: 'main', start: 'base' } as const;
    await s.prepare(input);
    await expect(s.prepare(input)).rejects.toThrow();
    await s.close();
  });

  it('close without a prepared context does not throw', async () => {
    const s = await openAgentSession({ choice: {}, repoPath: '/x', agents: injected, sandbox: fakeSandbox });
    await expect(s.close()).resolves.toBeUndefined();
  });
});

describe('sandbox', () => {
  beforeEach(() => {
    vi.stubEnv('TASKCELL_SANDBOX_READONLY', undefined);
    vi.stubEnv('TASKCELL_SANDBOX_MEMORY_MB', undefined);
    vi.stubEnv('TASKCELL_PNPM_STORE', undefined);
  });
  const runArgs = (opts: Partial<Parameters<typeof buildSessionSandbox>[0]>): string[] =>
    (buildSessionSandbox({ repoPath: '/nowhere', ...opts }, {}, {}, false) as DockerSandboxProvider).buildRunArgs();

  it('read-only rootfs stays opt-in with an enclave network', () => {
    expect(runArgs({ sandboxContext: { network: 'vg-egr-1', proxyMode: false } })).not.toContain('--read-only');
    vi.stubEnv('TASKCELL_SANDBOX_READONLY', '1');
    expect(runArgs({ sandboxContext: { network: 'vg-egr-1', proxyMode: false } })).toContain('--read-only');
  });

  it('mounts the pnpm store only when asked', () => {
    expect(runArgs({}).join(' ')).not.toMatch(/pnpm/i);
    expect(runArgs({ pnpmStore: true }).join(' ')).toMatch(/pnpm/i);
  });
});
