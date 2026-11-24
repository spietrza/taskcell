import { test, expect, afterEach, vi } from 'vitest';
import { mockRpc } from './testRpc';
import { apiCapabilitiesCached, listProjects, listRunsAll, readRun } from './ipc';

afterEach(() => vi.unstubAllGlobals());

test('readRun forwards repoPath and the ref flattened into taskId, timestamp and source', async () => {
  const captured: Record<string, unknown> = {};
  mockRpc((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return { taskId: 't', timestamp: 'ts', stages: [] };
  });
  await readRun('/repo', { source: { kind: 'local' }, taskId: 't', timestamp: 'ts' });
  expect(captured.cmd).toBe('read_run');
  expect(captured.args).toMatchObject({ repoPath: '/repo', taskId: 't', timestamp: 'ts', source: { kind: 'local' } });

  await readRun('/repo', { source: { kind: 'ci', runId: 42 }, taskId: 't', timestamp: 'ts' });
  expect(captured.args).toMatchObject({ repoPath: '/repo', source: { kind: 'ci', runId: 42 } });
});

test('apiCapabilitiesCached does not pin a rejected promise — a transient failure recovers on the next call', async () => {
  let fail = true;
  mockRpc((cmd) => {
    if (cmd !== 'api_capabilities') return undefined;
    if (fail) throw new Error('sidecar briefly unavailable');
    return { providers: ['claude'], flows: [], stages: [], transports: [], defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' } };
  });
  await expect(apiCapabilitiesCached()).rejects.toThrow(/briefly unavailable/);
  fail = false;
  await expect(apiCapabilitiesCached()).resolves.toMatchObject({ providers: ['claude'] }); // NOT the pinned rejection
});

test('the hub list wrappers send the selected team id, and nothing without one', async () => {
  const calls: { cmd: unknown; args: unknown }[] = [];
  mockRpc((cmd, args) => {
    calls.push({ cmd, args });
    return cmd === 'list_projects' ? [] : { runs: [], failures: [] };
  });
  await listProjects('b');
  await listRunsAll('b');
  await listProjects();
  expect(calls[0]).toMatchObject({ cmd: 'list_projects', args: { teamId: 'b' } });
  expect(calls[1]).toMatchObject({ cmd: 'list_runs_all', args: { teamId: 'b' } });
  expect((calls[2]!.args as { teamId?: string } | undefined)?.teamId).toBeUndefined();
});
