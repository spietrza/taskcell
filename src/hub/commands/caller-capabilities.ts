// Hub command: what the caller may do. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
// Every desktop UI gate reads this and nothing else; the handlers it mirrors still enforce for themselves.
import { realpath } from 'node:fs/promises';
import { assertMutationsAllowed } from '../allowlist.js';
import * as teams from '../teams.js';
import type { CallerCapabilities, CallerCapability, TeamRole } from '../../wire.js';
import { defineCommands, optionalString } from '../command-kit.js';

export interface CallerCapabilitiesCommands {
  /** HUB_ONLY, read-only: what the caller may do on the hub and, with `repoPath`, on that project. Every `false` carries its reason. */
  caller_capabilities: { args: { repoPath?: string } | undefined; result: CallerCapabilities };
}

const OWNER_ONLY = 'only the hub owner can do this';
const OWNER_OR_ADMIN = 'only the hub owner or a hub admin can do this';

const capability = (allowed: boolean, reason: string | undefined): CallerCapability => (allowed || reason === undefined ? { allowed } : { allowed, reason });

export const commands = defineCommands<CallerCapabilitiesCommands>({
  caller_capabilities: async ({ ctx, args, caller, allow }) => {
    let mutationsReason: string | undefined;
    try {
      assertMutationsAllowed(ctx.bind);
    } catch (e) {
      mutationsReason = e instanceof Error ? e.message : String(e);
    }
    const mutationsAllowed = mutationsReason === undefined;
    const owner = caller.owner;
    const ownerWrite = capability(mutationsAllowed && owner, mutationsAllowed ? OWNER_ONLY : mutationsReason);
    // add_project is the owner's; clone_project (the picker's clone-only mode) is also a hub admin's.
    const canAdd = capability(mutationsAllowed && (owner || caller.hubAdmin === true), mutationsAllowed ? OWNER_OR_ADMIN : mutationsReason);
    const out: CallerCapabilities = {
      mutationsAllowed,
      ...(mutationsReason !== undefined ? { mutationsReason } : {}),
      owner,
      admin: owner || caller.hubAdmin === true || ctx.userCredentials?.isAdmin(ctx.user) === true,
      canAddProject: canAdd,
      teamRoles: {},
    };
    const mine = await teams.callerTeams(ctx.configDir, caller);
    for (const t of mine) {
      const role = await teams.callerRole(ctx.configDir, caller, t.id);
      if (role !== undefined) out.teamRoles[t.id] = role;
    }
    const repoPath = optionalString(args ?? {}, 'repoPath');
    if (repoPath === undefined) return out;
    const real = await allow(repoPath);
    const holding: string[] = [];
    for (const t of mine) {
      const reals = await Promise.all(t.repositories.map((r) => realpath(r).catch(() => r)));
      if (reals.includes(real)) holding.push(t.id);
    }
    const roles = holding.map((id) => out.teamRoles[id]);
    const teamRole: TeamRole | null = owner || roles.includes('admin') ? 'admin' : roles.length > 0 ? 'member' : null;
    const write = capability(mutationsAllowed, mutationsReason);
    out.project = { teamRole, canReply: write, canMerge: write, canEnableFactory: write, canUpdateSkill: write, canEditSkills: ownerWrite };
    return out;
  },
});
