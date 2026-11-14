// Hub commands: a repository's app.json. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertSafeBaseBranch } from '../../core/base-branch.js';
import { readAppConfig, readAppConfigStrict, writeAppConfig, type AppConfig as HubAppConfig } from '../app-config.js';
import { appConfigRangeErrors, type AppConfig } from '../../wire.js';
import { type Args, defineCommands, requireString, changedKeys, repoTarget } from '../command-kit.js';

export interface AppConfigCommands {
  read_app_config: { args: { repoPath: string }; result: AppConfig };
  read_app_config_strict: { args: { repoPath: string }; result: AppConfig };
  write_app_config: { args: { repoPath: string; config: AppConfig }; result: void };
}

export const commands = defineCommands<AppConfigCommands>({
  read_app_config: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return readAppConfig(real);
  },
  read_app_config_strict: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return readAppConfigStrict(real);
  },
  write_app_config: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const config = args.config;
    if (typeof config !== 'object' || config === null) throw new BadRequestError('config is required');
    // A repository default or label-allowlist entry that git would misread is refused before it is saved,
    // not at the next run (one unsafe allowlist entry would refuse every labelled run and list_branches).
    const { baseBranch, baseBranches } = config as HubAppConfig;
    for (const b of [baseBranch, ...(Array.isArray(baseBranches) ? baseBranches : [])]) {
      if (typeof b === 'string' && b.trim() !== '') assertSafeBaseBranch(b.trim());
    }
    const rangeErrors = Object.values(appConfigRangeErrors(config as AppConfig));
    if (rangeErrors.length > 0) throw new BadRequestError(rangeErrors.join(' '));
    await writeAppConfig(real, config as HubAppConfig);
    return null;
  },
}, {
  write_app_config: {
    action: 'settings-change',
    target: repoTarget,
    detail: async (ctx, a) => {
      if (typeof a.config !== 'object' || a.config === null) return [];
      try {
        const prev = await readAppConfig(await ctx.allowlist.assertAllowed(requireString(a, 'repoPath')));
        return changedKeys(prev as Args, a.config as Args);
      } catch {
        return [];
      }
    },
  },
});
