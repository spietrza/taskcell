// Hub commands: filesystem watch of a project. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { defineCommands, requireString, repoTarget } from '../command-kit.js';

export interface WatchCommands {
  watch_project: { args: { repoPath: string }; result: void };
  unwatch_project: { args: { repoPath: string }; result: void };
}

export const commands = defineCommands<WatchCommands>({
  watch_project: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    ctx.watchRegistry.watchProject(real, (p) => ctx.publish('vanguard:changed', p));
    return null;
  },
  unwatch_project: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    ctx.watchRegistry.unwatchProject(real);
    return null;
  },
}, {
  watch_project: { write: true, repo: 'repoPath' },
  unwatch_project: { write: true, repo: 'repoPath' },
}, {
  watch_project: { action: 'project-watch', target: repoTarget },
  unwatch_project: { action: 'project-unwatch', target: repoTarget },
});
