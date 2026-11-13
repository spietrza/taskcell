import { describe, expect, test, vi } from 'vitest';
import * as setupStatus from '../setup-status.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

describe('setup_status', () => {
  const member = { user: { id: 'u1', email: 'm@hub.invalid', name: 'Member' }, owner: false };

  test('returns the detection for the owner', async () => {
    const { ctx } = await makeCtx(await tmpRepo());
    const report = { tools: [{ id: 'gh' as const, state: 'ready' as const }], models: { claude: false, codex: true } };
    const mock = vi.spyOn(setupStatus, 'detectSetup').mockResolvedValue(report);
    try {
      expect(await dispatchRpc(ctx, 'setup_status', undefined)).toEqual(report);
    } finally {
      mock.mockRestore();
    }
  });

  test('is refused for a member and on a non-loopback bind without the opt-in, without probing', async () => {
    const mock = vi.spyOn(setupStatus, 'detectSetup');
    try {
      const { ctx } = await makeCtx(await tmpRepo());
      await expect(dispatchRpc(ctx, 'setup_status', undefined, member)).rejects.toThrow('only the hub owner');
      const open = await makeCtx(await tmpRepo(), { bind: { isLoopback: false, allowAdd: false } });
      await expect(dispatchRpc(open.ctx, 'setup_status', undefined)).rejects.toThrow('disabled on a non-loopback bind');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });
});
