// Hub commands: teams and their members/repositories. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import * as projects from '../projects.js';
import * as teams from '../teams.js';
import type { Team, TeamRole } from '../../wire.js';
import { defineCommands, requireString, requireOneOf } from '../command-kit.js';

export interface TeamsCommands {
  /** HUB_ONLY: token-only mode has exactly one team and the caller acts as its admin. */
  list_teams: { args: undefined; result: Team[] };
  /** HUB_ONLY: one team by id (`null` when unknown). */
  get_team: { args: { id: string }; result: Team | null };
  /** HUB_ONLY: the caller's role in a team they belong to (`null` otherwise); the hub owner is an admin of every team. */
  team_role: { args: { id: string }; result: TeamRole | null };
  /** HUB_ONLY, team admin only (a member is refused). */
  add_team_member: { args: { teamId: string; login: string; role: TeamRole }; result: Team };
  /** HUB_ONLY, team admin only. */
  remove_team_member: { args: { teamId: string; login: string }; result: Team };
  /** HUB_ONLY, team admin only: attach an existing hub project to a non-default team. */
  add_team_repository: { args: { teamId: string; path: string }; result: Team };
  /** HUB_ONLY, team admin only. */
  remove_team_repository: { args: { teamId: string; path: string }; result: Team };
}

export const commands = defineCommands<TeamsCommands>({
  list_teams: async ({ ctx, caller }) => {
    return teams.callerTeams(ctx.configDir, caller);
  },
  get_team: async ({ ctx, args, caller }) => {
    const id = requireString(args, 'id');
    return (await teams.callerTeams(ctx.configDir, caller)).find((t) => t.id === id) ?? null;
  },
  team_role: async ({ ctx, args, caller }) => {
    return (await teams.callerRole(ctx.configDir, caller, requireString(args, 'id'))) ?? null;
  },
  add_team_member: async ({ ctx, args, caller }) => {
    const role = requireOneOf(args, 'role', ['admin', 'member']) as TeamRole;
    return teams.addMember(ctx.configDir, caller, requireString(args, 'teamId'), { login: requireString(args, 'login').trim(), role });
  },
  remove_team_member: async ({ ctx, args, caller }) => {
    return teams.removeMember(ctx.configDir, caller, requireString(args, 'teamId'), requireString(args, 'login').trim());
  },
  add_team_repository: async ({ ctx, args, caller, allow }) => {
    // Only a project registered on the hub that the caller already holds can be attached.
    const real = await allow(requireString(args, 'path'));
    const path = (await projects.registeredPath(ctx.configDir, real)) ?? real;
    return teams.addRepository(ctx.configDir, caller, requireString(args, 'teamId'), path);
  },
  remove_team_repository: async ({ ctx, args, caller }) => {
    const input = requireString(args, 'path');
    const path = (await projects.registeredPath(ctx.configDir, input)) ?? input;
    return teams.removeRepository(ctx.configDir, caller, requireString(args, 'teamId'), path);
  },
});
