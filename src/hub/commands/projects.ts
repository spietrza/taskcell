// Hub commands: the hub project list: add, remove, clone, browse. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { assertGitWorkTreeDir, assertMutationsAllowed } from '../allowlist.js';
import { assertWithinBrowseRoot, browseDirs } from '../browse.js';
import { cloneProject } from '../clone.js';
import * as projects from '../projects.js';
import * as teams from '../teams.js';
import type { DirListing, Project } from '../../wire.js';
import { defineCommands, requireString, optionalString } from '../command-kit.js';

export interface ProjectsCommands {
  list_projects: { args: { teamId?: string } | undefined; result: Project[] };
  add_project: { args: { path: string }; result: Project[] };
  /** HUB_ONLY: clone a repository under the browse root and register it. */
  clone_project: { args: { url: string; parentDir: string; name?: string }; result: Project };
  remove_project: { args: { path: string }; result: Project[] };
  /** HUB_ONLY: no native folder dialog in a browser (src/hub/browse.ts stands in for one). */
  browse_dirs: { args: { path?: string }; result: DirListing };
}

export const commands = defineCommands<ProjectsCommands>({
  list_projects: async ({ ctx, scope }) => {
    return projects.list(ctx.configDir, await scope());
  },
  add_project: async ({ ctx, args, caller }) => {
    assertMutationsAllowed(ctx.bind);
    teams.assertOwner(caller);
    const real = await assertWithinBrowseRoot(ctx.browseRoot, requireString(args, 'path'));
    await assertGitWorkTreeDir(real);
    return projects.add(ctx.configDir, real);
  },
  clone_project: async ({ ctx, args, caller }) => {
    assertMutationsAllowed(ctx.bind);
    teams.assertOwner(caller);
    const url = requireString(args, 'url');
    const parentDir = requireString(args, 'parentDir');
    const name = optionalString(args, 'name');
    const target = await cloneProject(
      ctx.browseRoot,
      { url, parentDir, name },
      { allowedHosts: ctx.cloneHosts, onProgress: (line) => ctx.publish('vanguard:clone-progress', { line }) },
    );
    await assertGitWorkTreeDir(target);
    await projects.add(ctx.configDir, target);
    return projects.aggregate(target);
  },
  remove_project: async ({ ctx, args, caller }) => {
    teams.assertOwner(caller);
    const path = requireString(args, 'path');
    await teams.purgeRepository(ctx.configDir, path);
    return projects.remove(ctx.configDir, path);
  },
  browse_dirs: async ({ ctx, args, caller }) => {
    assertMutationsAllowed(ctx.bind);
    // Feeds add_project / clone_project only, which are the owner's: a member must not list the host.
    teams.assertOwner(caller);
    return browseDirs(ctx.browseRoot, optionalString(args, 'path'));
  },
}, {
  add_project: { action: 'project-add', target: (a) => optionalString(a, 'path') },
  clone_project: { action: 'clone', target: (a) => optionalString(a, 'url') },
  remove_project: { action: 'project-remove', target: (a) => optionalString(a, 'path') },
});
