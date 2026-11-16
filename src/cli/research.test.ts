vi.mock('../sandbox/sandbox-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/sandbox-context.js')>()),
  startSandboxContext: vi.fn(async () => ({ destroy: async () => undefined })),
}));
vi.mock('../sandbox/llm-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/llm-proxy.js')>()),
  startProviderProxies: vi.fn(async () => ({ destroy: async () => undefined })),
}));
vi.mock('../core/taskcell.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/taskcell.js')>()),
  prepareContext: vi.fn(async () => ({})),
  runAgent: vi.fn(),
  disposeContext: vi.fn(async () => undefined),
}));
vi.mock('../runners/research.js', () => ({
  runResearch: vi.fn(async (_ref: string, deps: { researcher: (p: string) => Promise<string> }) => {
    await deps.researcher('prompt');
    return { iteration: 1 };
  }),
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../core/taskcell.js';
import { recordUtilization, resetUtilization, UsageCapError } from '../core/usage-cap.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { fakeSessionOpener } from './fake-session.fixture.js';
import { researchCommand } from './research.js';

describe('researchCommand usage cap', () => {
  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test');
    vi.stubEnv('TASKCELL_USAGE_CAP_PCT', '80');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetUtilization();
  });

  const cmd = { kind: 'research', issueRef: 'o/r#1', repoPath: '/repo', egress: false } as never;

  it('starts no agent when the provider is over the cap', async () => {
    recordUtilization('claude-code', { pct: 95, resetsAt: new Date(Date.now() + 3_600_000) });
    await expect(researchCommand(cmd, { log: () => undefined })).rejects.toBeInstanceOf(UsageCapError);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('runs the agent when the provider is under the cap', async () => {
    recordUtilization('claude-code', { pct: 10, resetsAt: new Date(Date.now() + 3_600_000) });
    vi.mocked(runAgent).mockResolvedValue({ finalText: 'findings' } as never);
    await researchCommand(cmd, { log: () => undefined });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('hands the sandbox context to the session as one value, proxy mode included', async () => {
    const context = { proxyUrl: 'http://p', network: 'n', proxyMode: true, destroy: async () => undefined };
    vi.mocked(startSandboxContext).mockResolvedValueOnce(context);
    vi.mocked(runAgent).mockResolvedValue({ finalText: 'findings' } as never);
    const session = fakeSessionOpener();
    await researchCommand(cmd, { log: () => undefined, openSession: session.open });
    expect(session.opened[0]?.sandboxContext).toBe(context);
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
