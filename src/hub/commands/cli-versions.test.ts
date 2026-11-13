import { describe, expect, test, vi } from 'vitest';
import * as cliVersions from '../../sandbox/cli-versions.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

describe('cli-versions', () => {
  test('agent_cli_versions reports a disabled check without any lookup when the switch is off', async () => {
    vi.stubEnv('TASKCELL_CLI_VERSION_CHECK', 'off');
    try {
      const { ctx } = await makeCtx(await tmpRepo());
      expect(await dispatchRpc(ctx, 'agent_cli_versions', {})).toEqual({ enabled: false, clis: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('agent_cli_versions returns the version report for the hub config dir', async () => {
    const { ctx } = await makeCtx(await tmpRepo());
    const report = { enabled: true, clis: [{ name: 'claude' as const, installed: '1.0.0', changelog: 'https://c', outdated: false, updatable: false }] };
    const mock = vi.spyOn(cliVersions, 'checkCliVersions').mockResolvedValue(report);
    try {
      expect(await dispatchRpc(ctx, 'agent_cli_versions', {})).toEqual(report);
      expect(mock).toHaveBeenCalledWith({ cwd: ctx.configDir });
    } finally {
      mock.mockRestore();
    }
  });

  test('agent_cli_versions is refused on a non-loopback bind without the opt-in', async () => {
    const { ctx } = await makeCtx(await tmpRepo(), { bind: { isLoopback: false, allowAdd: false } });
    const mock = vi.spyOn(cliVersions, 'checkCliVersions');
    try {
      await expect(dispatchRpc(ctx, 'agent_cli_versions', {})).rejects.toThrow('disabled on a non-loopback bind');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });
});
