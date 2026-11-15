// Hub commands: the hub project list: add, remove, clone, browse. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { assertGitWorkTreeDir } from '../allowlist.js';
import { assertWithinBrowseRoot, browseDirs } from '../browse.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../../sidecar/sidecar.js';
import { cloneProject, repoNameFromUrl } from '../clone.js';
import * as projects from '../projects.js';
import * as teams from '../teams.js';
import type { DirListing, Project } from '../../wire.js';
import { defineCommands, requireString, optionalString } from '../command-kit.js';

/** Where a hub admin's clones go: one folder under the browse root. */
const HUB_ADMIN_CLONE_DIR = 'taskcell-repos';

const repoNameOrUndefined = (url: string): string | undefined => {
  try {
    return repoNameFromUrl(url.trim());
  } catch {
    return undefined;
  }
};

export interface ProjectsCommands {
  list_projects: { args: { teamId?: string } | undefined; result: Project[] };
  add_project: { args: { path: string }; result: Project[] };
  /** HUB_ONLY: clone a repository under the browse root and register it. The owner picks `parentDir`; a hub admin
   * (`TASKCELL_HUB_ADMINS`) clones under the browse root into `teamId` (default: their first team). */
  clone_project: { args: { url: string; parentDir?: string; name?: string; teamId?: string }; result: Project };
  remove_project: { args: { path: string }; result: Project[] };
  /** HUB_ONLY: no native folder dialog in a browser (src/hub/browse.ts stands in for one). */
  browse_dirs: { args: { path?: string }; result: DirListing };
}

export const commands = defineCommands<ProjectsCommands>({
  list_projects: async ({ ctx, scope }) => {
    return projects.list(ctx.configDir, await scope());
  },
  add_project: async ({ ctx, args }) => {
    const real = await assertWithinBrowseRoot(ctx.browseRoot, requireString(args, 'path'), ctx.browseAnywhere);
    await assertGitWorkTreeDir(real);
    return projects.add(ctx.configDir, real);
  },
  clone_project: async ({ ctx, args, caller }) => {
    const url = requireString(args, 'url');
    // A hub admin does not choose where on the server's disk: the clone goes into one folder under the browse
    // root, never a dot-folder (`.ssh`) of it.
    const name = optionalString(args, 'name');
    if (!caller.owner && (name?.trim().startsWith('.') === true || repoNameOrUndefined(url)?.startsWith('.') === true)) {
      throw new BadRequestError('a repository folder name cannot start with a dot');
    }
    const parentDir = caller.owner ? requireString(args, 'parentDir') : join(ctx.browseRoot, HUB_ADMIN_CLONE_DIR);
    if (!caller.owner) await mkdir(parentDir, { recursive: true });
    // Resolved before cloning, so a hub admin with no team is refused without fetching anything.
    const team = caller.owner ? undefined : await teams.selectTeam(ctx.configDir, caller, optionalString(args, 'teamId'));
    const target = await cloneProject(
      ctx.browseRoot,
      { url, parentDir, name },
      { allowedHosts: ctx.cloneHosts, anywhere: ctx.browseAnywhere, onProgress: (line) => ctx.publish('vanguard:clone-progress', { line, cloneBy: caller.user.id }) },
    );
    await assertGitWorkTreeDir(target);
    await projects.add(ctx.configDir, target);
    if (team !== undefined) {
      // No half state: a clone that cannot join the team is not left registered outside it.
      await teams.joinRepository(ctx.configDir, caller, team.id, target).catch(async (error: unknown) => {
        await projects.remove(ctx.configDir, target).catch(() => undefined);
        throw error;
      });
    }
    return projects.aggregate(target);
  },
  remove_project: async ({ ctx, args }) => {
    const path = requireString(args, 'path');
    await teams.purgeRepository(ctx.configDir, path);
    return projects.remove(ctx.configDir, path);
  },
  browse_dirs: async ({ ctx, args }) => {
    return browseDirs(ctx.browseRoot, optionalString(args, 'path'), ctx.browseAnywhere);
  },
}, {
  list_projects: { write: false },
  add_project: { write: true, remote: true, owner: true },
  clone_project: { write: true, remote: true, owner: 'or-hub-admin' },
  remove_project: { write: true, owner: true },
  // Feeds add_project / clone_project only, which are the owner's: a member must not list the host.
  browse_dirs: { write: false, remote: true, owner: true },
}, {
  add_project: { action: 'project-add', target: (a) => optionalString(a, 'path') },
  clone_project: { action: 'clone', target: (a) => optionalString(a, 'url') },
  remove_project: { action: 'project-remove', target: (a) => optionalString(a, 'path') },
});
