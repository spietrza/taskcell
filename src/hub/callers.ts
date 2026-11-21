import { realpath } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { HubIdentity, HubUser } from './auth.js';
import { callerRepoRoots, repoInRoots, type Caller } from './teams.js';

/** Whether a caller may see a repository path; the team roots are realpath'd once, when this is built. */
export interface RepoVisibility {
  /** For a path already in the form the hub stores (sync: the `/events` filter). */
  has(path: string): boolean;
  /** For a path that may be a symlink or relative to one: realpath'd first, the raw path also accepted. */
  hasResolved(path: string): Promise<boolean>;
}

export async function repoVisibility(configDir: string, caller: Caller): Promise<RepoVisibility> {
  const roots = await callerRepoRoots(configDir, caller);
  return {
    has: (path) => repoInRoots(roots, path),
    hasResolved: async (path) => repoInRoots(roots, await realpath(path).catch(() => path)) || repoInRoots(roots, path),
  };
}

/**
 * The stored owner of a hub task is a snapshot: the user is re-read by id (current e-mail, verification and logins), and
 * the owner (token) flag holds only for the identity's owner user, so a stored `owner: true` stops counting once that id
 * is no longer the owner (a local/server mode switch, a recreated auth.sqlite).
 */
export function callerRechecker(identity: Pick<HubIdentity, 'owner' | 'userById'>, credentials: { isAdmin(user: HubUser | undefined): boolean }): (c: Caller) => Promise<Caller | undefined> {
  return async (c) => {
    const user = await identity.userById(c.user.id);
    if (user === undefined) return undefined;
    const owner = c.owner && user.id === identity.owner.id;
    return { user, owner, hubAdmin: !owner && credentials.isAdmin(user) };
  };
}

export interface CallerResolver {
  /** The user a request stands for: the hub token (the owner), a session cookie, or a device token. */
  userOf(req: IncomingMessage, offeredToken: string | undefined, tokenValid: boolean): Promise<HubUser | undefined>;
  /** The caller for a resolved request user; the token holder is the owner, a session user is limited to their teams. */
  ofRequest(user: HubUser, tokenValid: boolean): Caller;
  /** A stored caller or registration (push, scheduler) re-read against the current identity; undefined when the user is gone. */
  recheck(stored: Caller): Promise<Caller | undefined>;
  /** The caller a stored push registration stands for, rechecked. */
  ofRegistration(reg: { userId: string; owner: boolean }): Promise<Caller | undefined>;
  /** The hub owner (the push timer's view of every waiting item). */
  owner(): Caller;
}

export function createCallerResolver(identity: Pick<HubIdentity, 'owner' | 'userById' | 'sessionUser' | 'deviceSessionUser'>, credentials: { isAdmin(user: HubUser | undefined): boolean }): CallerResolver {
  const recheck = callerRechecker(identity, credentials);
  return {
    userOf: async (req, offeredToken, tokenValid) =>
      tokenValid ? identity.owner : ((await identity.sessionUser(req)) ?? (offeredToken ? identity.deviceSessionUser(offeredToken) : undefined)),
    ofRequest: (user, tokenValid) => ({ user, owner: tokenValid, hubAdmin: !tokenValid && credentials.isAdmin(user) }),
    recheck,
    ofRegistration: (reg) => recheck({ user: { id: reg.userId, email: '', name: '' }, owner: reg.owner }),
    owner: () => ({ user: identity.owner, owner: true }),
  };
}
