import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { SpawnRegistry } from '../spawn.js';
import { FLEET_DISABLED_MESSAGE } from '../rpc.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

describe('fleet', () => {
  test('T-58 Fleet commands are refused unless the hub enabled fleet', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    for (const cmd of ['spawn_run', 'kill_run', 'list_spawns']) {
      await expect(dispatchRpc(ctx, cmd, {})).rejects.toThrow(FLEET_DISABLED_MESSAGE);
    }
  });

  test('Fleet commands spawn, list and report exit when fleet is enabled, and respect the allowlist', async () => {
    const repo = await tmpRepo();
    const { ctx, published } = await makeCtx(repo);
    ctx.spawnRegistry = new SpawnRegistry(ctx.publish);
    const pid = (await dispatchRpc(ctx, 'spawn_run', { cwd: repo, argv: [process.execPath, '-e', 'console.log("hi")'] })) as number;
    expect(typeof pid).toBe('number');
    await vi.waitFor(() => expect(published.some((e) => e.name === 'spawn:exit')).toBe(true));
    expect(published).toContainEqual({ name: 'spawn:output', payload: { pid, line: 'hi' } });
    expect(published).toContainEqual({ name: 'spawn:exit', payload: { pid, code: 0 } });
    expect(await dispatchRpc(ctx, 'list_spawns', {})).toEqual([]);
    await expect(dispatchRpc(ctx, 'spawn_run', { cwd: tmpdir(), argv: ['true'] })).rejects.toThrow();
    await expect(dispatchRpc(ctx, 'spawn_run', { cwd: repo, argv: [] })).rejects.toThrow(/argv/);
  });
});
