// Hub commands: a repository's app.json. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertSafeBaseBranch } from '../../core/base-branch.js';
import { readAppConfig, readAppConfigStrict, writeAppConfig, type AppConfig as HubAppConfig } from '../app-config.js';
import { appConfigRangeErrors, type AppConfig, type ChatModelList } from '../../wire.js';
import { listChatModels } from '../chat-models.js';
import { type Args, defineCommands, requireString, changedKeys, repoTarget } from '../command-kit.js';
import { settingsValueChanges } from '../audit.js';
import type { RpcContext } from '../rpc.js';

/** The saved app.json before a write, or undefined when the call carries no config or the read fails. */
async function savedBefore(ctx: RpcContext, a: Args): Promise<Args | undefined> {
  if (typeof a.config !== 'object' || a.config === null) return undefined;
  try {
    return (await readAppConfig(await ctx.allowlist.assertAllowed(requireString(a, 'repoPath')))) as Args;
  } catch {
    return undefined;
  }
}

export interface AppConfigCommands {
  read_app_config: { args: { repoPath: string }; result: AppConfig };
  read_app_config_strict: { args: { repoPath: string }; result: AppConfig };
  write_app_config: { args: { repoPath: string; config: AppConfig }; result: void };
  /** HUB_ONLY, read-only: the model ids the repository's saved doc-chat endpoint or provider offers (Settings → Fetch models). A key named by `keyEnv` stays on the hub. */
  list_chat_models: { args: { repoPath: string }; result: ChatModelList };
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
  list_chat_models: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return listChatModels(real, await readAppConfig(real));
  },
}, {
  read_app_config: { write: false, repo: 'repoPath' },
  list_chat_models: { write: false, repo: 'repoPath' },
  read_app_config_strict: { write: false, repo: 'repoPath' },
  // app.json steers the tracker, labels and target branches the hub acts on, so it is a server write like the others.
  write_app_config: { write: true, remote: true, repo: 'repoPath' },
}, {
  write_app_config: {
    action: 'settings-change',
    target: repoTarget,
    detail: async (ctx, a) => {
      const prev = await savedBefore(ctx, a);
      return prev === undefined ? [] : changedKeys(prev, a.config as Args);
    },
    changes: async (ctx, a) => {
      const prev = await savedBefore(ctx, a);
      return prev === undefined ? [] : settingsValueChanges(prev, a.config as Args);
    },
  },
});
