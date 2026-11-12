// Teams: a name, members (login + role) and repositories, stored next to projects.json.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Team, TeamMember } from '../wire.js';
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
