import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { SpawnRegistry } from '../spawn.js';
import { createCredentialService } from '../credentials.js';
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

  test('a saved instance credential reaches a Fleet spawn explicitly; an unsaved one and process.env do not change', async () => {
    const repo = await tmpRepo();
    const { ctx, published } = await makeCtx(repo);
    ctx.spawnRegistry = new SpawnRegistry(ctx.publish);
    ctx.userCredentials = createCredentialService(ctx.configDir);
    const saved = { ZAI_API_KEY: process.env.ZAI_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    delete process.env.ZAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await ctx.userCredentials.store.put('instance', 'ZAI_API_KEY', 'zai-saved');
      const pid = (await dispatchRpc(ctx, 'spawn_run', { cwd: repo, argv: [process.execPath, '-e', 'console.log(`${process.env.ZAI_API_KEY}|${process.env.OPENROUTER_API_KEY}`)'] })) as number;
      await vi.waitFor(() => expect(published.some((e) => e.name === 'spawn:exit')).toBe(true));
      expect(published).toContainEqual({ name: 'spawn:output', payload: { pid, line: 'zai-saved|undefined' } });
      expect(process.env.ZAI_API_KEY).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
