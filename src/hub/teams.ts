// Teams: a name, members (login + role) and repositories, stored next to projects.json.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { Team, TeamMember, TeamRole } from '../wire.js';
import type { HubUser } from './auth.js';
import { loadPaths } from './projects.js';

const DEFAULT_TEAM_ID = 'default';

function teamsFile(configDir: string): string {
  return join(configDir, 'teams.json');
}

function isMember(m: unknown): m is TeamMember {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return typeof r.login === 'string' && (r.role === 'admin' || r.role === 'member');
}

function isTeam(t: unknown): t is Team {
  if (typeof t !== 'object' || t === null) return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    Array.isArray(r.members) &&
    r.members.every(isMember) &&
    Array.isArray(r.repositories) &&
    r.repositories.every((p) => typeof p === 'string')
  );
}

/** The stored teams; `undefined` when the file is absent or its content is unusable (unparsable /
 * malformed). Any other I/O error (EACCES, EISDIR, ...) is thrown, never mistaken for "no teams". */
export async function loadTeams(configDir: string): Promise<Team[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(teamsFile(configDir), 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const teams = (parsed as { teams?: unknown } | null)?.teams;
  return Array.isArray(teams) && teams.every(isTeam) ? teams : undefined;
}

export async function saveTeams(configDir: string, teams: Team[]): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const tmp = `${teamsFile(configDir)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ teams }, null, 2));
  await rename(tmp, teamsFile(configDir));
}

/** Project paths are only read here, never written; non-string entries are dropped. */
async function projectPaths(configDir: string): Promise<string[]> {
  return (await loadPaths(configDir)).filter((p) => typeof p === 'string');
}

function defaultTeam(paths: string[]): Team {
  return { id: DEFAULT_TEAM_ID, name: 'Default', members: [], repositories: paths };
}

/** Serialises team-file writes per process so concurrent migrations and edits do not race. */
let queue: Promise<unknown> = Promise.resolve();

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

async function ensure(configDir: string): Promise<Team[]> {
  const [existing, paths] = await Promise.all([loadTeams(configDir), projectPaths(configDir)]);
  if (existing !== undefined && existing.length > 0) {
    // The default team mirrors the project list, so add/clone/remove never leave it stale.
    const def = existing.find((t) => t.id === DEFAULT_TEAM_ID);
    if (def !== undefined && JSON.stringify(def.repositories) !== JSON.stringify(paths)) {
      def.repositories = paths;
      await saveTeams(configDir, existing);
    }
    return existing;
  }
  if (existing === undefined) {
    // Keep an unusable file for inspection instead of silently destroying it.
    await copyFile(teamsFile(configDir), `${teamsFile(configDir)}.corrupt`).catch(() => undefined);
  }
  const teams = [defaultTeam(paths)];
  await saveTeams(configDir, teams);
  return teams;
}

/**
 * Idempotent migration: with no usable teams (first start after the upgrade, a missing or corrupt
 * teams file) create the default team holding every project from projects.json. Valid teams are
 * kept; the default team's repositories are re-synced to the project list.
 */
export function ensureTeams(configDir: string): Promise<Team[]> {
  return serialised(() => ensure(configDir));
}

/**
 * Read-only view (never writes, so a read on a bind that refuses mutations has no side effects):
 * the stored teams with the default team's repositories taken from the live project list, or just
 * the default team while the file is absent/unusable (`ensureTeams` at hub startup persists it).
 * Token-only mode (no sign-in) has exactly one team and acts as its admin.
 */
export async function listTeams(configDir: string): Promise<Team[]> {
  const [stored, paths] = await Promise.all([loadTeams(configDir), projectPaths(configDir)]);
  if (stored === undefined || stored.length === 0) return [defaultTeam(paths)];
  return stored.map((t) => (t.id === DEFAULT_TEAM_ID ? { ...t, repositories: paths } : t));
}

/** Who is calling: a hub user, and whether they hold the hub token (the owner — admin of every team,
 * which in token-only mode is the single default team). A request without a caller does not exist:
 * the server always resolves one, so access can never fail open. */
export interface Caller {
  user: HubUser;
  owner: boolean;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A member `login` is the user's Better Auth id or provider-VERIFIED e-mail. The display name is
 * deliberately not matched: it comes from the provider profile and the user can edit it. */
function roleIn(team: Team, user: HubUser): TeamRole | undefined {
  const keys = [user.id, ...(user.emailVerified === true ? [user.email] : [])].filter((k) => k !== '');
  return team.members.find((m) => keys.some((k) => same(m.login, k)))?.role;
}

/** The teams the caller belongs to (the owner: all of them). */
export async function callerTeams(configDir: string, caller: Caller): Promise<Team[]> {
  const all = await listTeams(configDir);
  return caller.owner ? all : all.filter((t) => roleIn(t, caller.user) !== undefined);
}

/** The selected team (`teamId`, else the caller's first), refused when the caller is not in it. */
export async function selectTeam(configDir: string, caller: Caller, teamId?: string): Promise<Team> {
  const mine = await callerTeams(configDir, caller);
  const team = teamId === undefined ? mine[0] : mine.find((t) => t.id === teamId);
  if (team === undefined) throw new BadRequestError(teamId === undefined ? 'you are not a member of any team' : `not a member of team: ${teamId}`);
  return team;
}

/** The hub-wide commands (credentials, fleet, project registry) are the owner's. */
export function assertOwner(caller: Caller): void {
  if (!caller.owner) throw new BadRequestError('only the hub owner can do this');
}

function assertAdmin(team: Team, caller: Caller): void {
  if (!caller.owner && roleIn(team, caller.user) !== 'admin') throw new BadRequestError(`only a team admin can change team ${team.id}`);
}

/** The realpath'd repositories of the caller's teams; `undefined` = unrestricted (the owner). Compute
 * once per request and pass to `repoInRoots`. */
export async function callerRepoRoots(configDir: string, caller: Caller): Promise<string[] | undefined> {
  if (caller.owner) return undefined;
  const repos = (await callerTeams(configDir, caller)).flatMap((t) => t.repositories);
  return Promise.all(repos.map((r) => realpath(r).catch(() => r)));
}

/** `path` is one of `roots` or lies inside one. */
export function repoInRoots(roots: readonly string[] | undefined, path: string): boolean {
  return roots === undefined || roots.some((r) => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep));
}

/** Refuse a repository (or a path inside one) that none of the caller's teams holds. */
export function assertRepoInRoots(roots: readonly string[] | undefined, repoPath: string): void {
  if (!repoInRoots(roots, repoPath)) throw new BadRequestError(`repository is not in any of your teams: ${repoPath}`);
}

/** Authorise (inside the write queue, so a concurrent demotion cannot slip past), edit, persist. The
 * team must keep an admin if it had one. */
function change(configDir: string, caller: Caller, id: string, edit: (t: Team) => void): Promise<Team> {
  return serialised(async () => {
    const all = await ensure(configDir);
    const team = all.find((t) => t.id === id);
    if (team === undefined || (!caller.owner && roleIn(team, caller.user) === undefined)) throw new BadRequestError(`not a member of team: ${id}`);
    assertAdmin(team, caller);
    const hadAdmin = team.members.some((m) => m.role === 'admin');
    edit(team);
    if (hadAdmin && !team.members.some((m) => m.role === 'admin')) throw new BadRequestError('a team must keep at least one admin');
    await saveTeams(configDir, all);
    return team;
  });
}

export const addMember = (configDir: string, caller: Caller, id: string, m: TeamMember): Promise<Team> =>
  change(configDir, caller, id, (t) => {
    t.members = [...t.members.filter((x) => !same(x.login, m.login)), m];
  });

export const removeMember = (configDir: string, caller: Caller, id: string, login: string): Promise<Team> =>
  change(configDir, caller, id, (t) => {
    t.members = t.members.filter((x) => !same(x.login, login));
  });

const DEFAULT_MIRRORS = 'the default team mirrors the project list; use add_project / remove_project';

export const addRepository = (configDir: string, caller: Caller, id: string, path: string): Promise<Team> =>
  change(configDir, caller, id, (t) => {
    if (t.id === DEFAULT_TEAM_ID) throw new BadRequestError(DEFAULT_MIRRORS);
    if (!t.repositories.includes(path)) t.repositories.push(path);
  });

export const removeRepository = (configDir: string, caller: Caller, id: string, path: string): Promise<Team> =>
  change(configDir, caller, id, (t) => {
    if (t.id === DEFAULT_TEAM_ID) throw new BadRequestError(DEFAULT_MIRRORS);
    t.repositories = t.repositories.filter((r) => r !== path);
  });

/** A project removed hub-wide leaves every team's repository list. */
export function purgeRepository(configDir: string, path: string): Promise<void> {
  return serialised(async () => {
    const all = await ensure(configDir);
    if (!all.some((t) => t.repositories.includes(path))) return;
    for (const t of all) t.repositories = t.repositories.filter((r) => r !== path);
    await saveTeams(configDir, all);
  });
}

/** The caller's role in a team they can see (the owner: admin of every team); `undefined` otherwise. */
export async function callerRole(configDir: string, caller: Caller, id: string): Promise<TeamRole | undefined> {
  const team = (await callerTeams(configDir, caller)).find((t) => t.id === id);
  if (team === undefined) return undefined;
  return caller.owner ? 'admin' : roleIn(team, caller.user);
}
