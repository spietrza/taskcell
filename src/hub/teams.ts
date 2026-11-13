// Teams: a name, members (login + role) and repositories, stored next to projects.json.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Team, TeamMember, TeamRole } from '../wire.js';
import { TaskcellError } from '../core/errors.js';
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

/** Serialises ensureTeams per process so concurrent migrations do not race on the write. */
let queue: Promise<unknown> = Promise.resolve();

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
  const run = queue.then(() => ensure(configDir));
  queue = run.catch(() => undefined);
  return run;
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

export async function getTeam(configDir: string, id: string): Promise<Team | undefined> {
  return (await listTeams(configDir)).find((t) => t.id === id);
}

/** A caller-correctable team edit failure (unknown member, last admin, ...). */
export class TeamError extends TaskcellError {}

const normLogin = (login: string): string => login.trim().replace(/^@/, '');
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The caller's role in `team`, matched on the provider login (`github:octocat` -> `octocat`) the hub stored at sign-up. */
export function roleOf(team: Team, providerLogin: string | undefined): TeamRole | undefined {
  const login = providerLogin?.slice(providerLogin.indexOf(':') + 1);
  if (login === undefined || login === '') return undefined;
  return team.members.find((m) => sameLogin(m.login, login))?.role;
}

/** Teams a caller may see: those they belong to, plus teams with no members yet (the migrated default team). */
export function visibleTeams(all: Team[], providerLogin: string | undefined): Team[] {
  return all.filter((t) => t.members.length === 0 || roleOf(t, providerLogin) !== undefined);
}

function adminCount(members: TeamMember[]): number {
  return members.filter((m) => m.role === 'admin').length;
}

/** Pure edits: each returns the new team or throws TeamError. The last admin can never leave or be demoted. */
export function withMember(team: Team, login: string, role: TeamRole): Team {
  const l = normLogin(login);
  if (l === '') throw new TeamError('login is required');
  if (team.members.some((m) => sameLogin(m.login, l))) throw new TeamError(`${l} is already a member`);
  return { ...team, members: [...team.members, { login: l, role }] };
}

export function withRole(team: Team, login: string, role: TeamRole): Team {
  const m = team.members.find((x) => sameLogin(x.login, normLogin(login)));
  if (m === undefined) throw new TeamError(`${login} is not a member`);
  if (m.role === 'admin' && role !== 'admin' && adminCount(team.members) <= 1) {
    throw new TeamError('the last admin cannot be demoted');
  }
  return { ...team, members: team.members.map((x) => (x === m ? { ...x, role } : x)) };
}

export function withoutMember(team: Team, login: string): Team {
  const m = team.members.find((x) => sameLogin(x.login, normLogin(login)));
  if (m === undefined) throw new TeamError(`${login} is not a member`);
  if (m.role === 'admin' && adminCount(team.members) <= 1) throw new TeamError('the last admin cannot be removed');
  return { ...team, members: team.members.filter((x) => x !== m) };
}

export function withRepository(team: Team, path: string): Team {
  if (team.id === DEFAULT_TEAM_ID) throw new TeamError('the default team lists every project');
  if (team.repositories.includes(path)) throw new TeamError('repository is already in the team');
  return { ...team, repositories: [...team.repositories, path] };
}

export function withoutRepository(team: Team, path: string): Team {
  if (team.id === DEFAULT_TEAM_ID) throw new TeamError('the default team lists every project');
  if (!team.repositories.includes(path)) throw new TeamError('repository is not in the team');
  return { ...team, repositories: team.repositories.filter((p) => p !== path) };
}

/** Persisted edit of one team, serialised with `ensureTeams` so writes do not interleave. */
export function updateTeam(configDir: string, id: string, edit: (t: Team) => Team): Promise<Team> {
  const run = queue.then(async () => {
    const all = await ensure(configDir);
    const team = all.find((t) => t.id === id);
    if (team === undefined) throw new TeamError(`unknown team ${id}`);
    const next = edit(team);
    await saveTeams(configDir, all.map((t) => (t.id === id ? next : t)));
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}
