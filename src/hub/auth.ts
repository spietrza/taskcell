// Hub sign-in (server mode) on Better Auth, stored in node:sqlite (no native module). Every hub
// request resolves to a HubUser: the Better Auth session, the hub token (-> owner), or — on a
// loopback bind — the automatic owner. Docs: docs/hub.md "Server mode sign-in".
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { readEnv } from '../core/env.js';

export interface HubUser {
  /** Better Auth's user id; teams and roles (#841) key on it. */
  id: string;
  email: string;
  name: string;
  /** `github:<login>` / `gitlab:<login>` of the user's linked GitHub or GitLab account (absent otherwise): hub admins
   * (`TASKCELL_HUB_ADMINS`, `--admin-github-login`) match on it. Resolved from the `account` row's numeric provider id and the login
   * the provider last reported for that id at an OAuth callback — never from the user-writable `providerLogin`. */
  login?: string;
  /** Every provider login the user has linked (`github:…`, `gitlab:…`); `login` is the first. A hub admin entry matches any. */
  logins?: string[];
  /** Provider-verified e-mail: only then does a team member `login` match the address. */
  emailVerified?: boolean;
}

export type AuthProviderId = 'github' | 'gitlab' | 'google';

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  /** GitLab only: base URL of a self-managed instance (default https://gitlab.com). */
  issuer?: string;
}
export type ProviderConfigs = Partial<Record<AuthProviderId, ProviderConfig>>;

export interface HubIdentity {
  readonly owner: HubUser;
  /** The hub's public origin (`TASKCELL_HUB_PUBLIC_URL`, Better Auth's `baseURL`); undefined in local mode. Hub URLs and cookie `Secure` flags follow it, never the request's own scheme. */
  readonly baseURL: string | undefined;
  /** Enabled sign-in providers (empty in local mode: no OAuth there). */
  readonly providers: readonly AuthProviderId[];
  /** The signed-in user of this request's session cookie, if any. Always undefined in local mode. */
  sessionUser(req: IncomingMessage): Promise<HubUser | undefined>;
  /** The user with this id as the store holds them now (undefined: gone, or no longer allowed to have an account). For work that runs later as a stored user; required, so no identity can skip the check. */
  userById(id: string): Promise<HubUser | undefined>;
  /** Mints a session for the user an approved device flow named (src/hub/device-auth.ts) and returns its secret token. Required, so no identity can skip the device flow's checks. */
  issueDeviceSession(userId: string): Promise<string | undefined>;
  /** The user behind a device-flow session token (undefined: unknown, expired, revoked, or no longer allowed). */
  deviceSessionUser(token: string): Promise<HubUser | undefined>;
  /** Ends a device-flow session (sign-out from the app). */
  revokeDeviceSession(token: string): Promise<void>;
  /** Better Auth's node handler for `/api/auth/*`; undefined in local mode (no sign-in). */
  readonly handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  close(): void;
}

/** Device-flow session tokens carry this prefix: a browser session's token is never accepted as a bearer. */
const DEVICE_TOKEN_PREFIX = 'tcd_';

/** `.invalid` can never be a registered domain, so no OAuth account can claim this address. */
export const OWNER_EMAIL = 'owner@hub.invalid';

const nonBlank = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** Operator config from env: `TASKCELL_HUB_AUTH_<GITHUB|GITLAB|GOOGLE>_CLIENT_ID` / `_CLIENT_SECRET`
 * (plus `TASKCELL_HUB_AUTH_GITLAB_ISSUER`). A provider missing either half is not enabled. */
export function providersFromEnv(env: NodeJS.ProcessEnv): ProviderConfigs {
  const out: ProviderConfigs = {};
  for (const id of ['github', 'gitlab', 'google'] as const) {
    const prefix = `TASKCELL_HUB_AUTH_${id.toUpperCase()}`;
    const clientId = nonBlank(readEnv(`${prefix}_CLIENT_ID`, env));
    const clientSecret = nonBlank(readEnv(`${prefix}_CLIENT_SECRET`, env));
    if (clientId === undefined || clientSecret === undefined) continue;
    const issuer = id === 'gitlab' ? nonBlank(readEnv(`${prefix}_ISSUER`, env))?.replace(/\/+$/, '') : undefined;
    out[id] = { clientId, clientSecret, ...(issuer !== undefined ? { issuer } : {}) };
  }
  return out;
}

/** Who may create an account: a predicate over the entries `alice@example.com`, `@example.com` (a
 * domain), `github:login`, `gitlab:login` (case-insensitive). No entries = nobody can sign up.
 * E-mail and domain entries only count for a provider-verified address. */
export type SignupAllowlist = (user: { email: string; emailVerified: boolean; login?: string | undefined }) => boolean;

export function parseSignupAllowlist(entries: readonly string[], label = 'sign-up allowlist'): SignupAllowlist {
  const emails = new Set<string>();
  const domains = new Set<string>();
  const logins = new Set<string>();
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (e === '') continue;
    if (e.startsWith('github:') || e.startsWith('gitlab:')) logins.add(e);
    else if (e.startsWith('@')) domains.add(e.slice(1));
    else if (e.includes('@')) emails.add(e);
    else throw new Error(`Taskcell Hub: invalid ${label} entry "${raw}" — use an e-mail, @domain, github:<login> or gitlab:<login>`);
  }
  return (user) => {
    const email = user.email.toLowerCase();
    if (user.login !== undefined && logins.has(user.login.toLowerCase())) return true;
    if (!user.emailVerified) return false;
    const at = email.lastIndexOf('@');
    return emails.has(email) || (at !== -1 && domains.has(email.slice(at + 1)));
  };
}

export const SIGNUP_REFUSED_MESSAGE =
  'Sign-up is not open on this hub: your account is not on the allowlist. Ask the hub operator to add your e-mail, domain or login.';

/** Per-hub signing secret: `TASKCELL_HUB_AUTH_SECRET`, else a random one persisted (0600) next to the db. */
async function loadSecret(configDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = nonBlank(readEnv('TASKCELL_HUB_AUTH_SECRET', env));
  if (fromEnv !== undefined) return fromEnv;
  const path = join(configDir, 'auth-secret');
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through: create
  }
  const secret = randomBytes(32).toString('hex');
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return secret;
}

export interface CreateIdentityOptions {
  /** The hub state dir; holds `auth.sqlite` and `auth-secret`. */
  configDir: string;
  /** Public origin, e.g. `https://hub.example.com` — the OAuth callback base. */
  baseURL: string;
  providers?: ProviderConfigs;
  allowlist?: SignupAllowlist;
  env?: NodeJS.ProcessEnv;
}

/** A `TASKCELL_HUB_PUBLIC_URL` must be a bare http(s) origin: it is the base of the OAuth callback URLs. */
export function parsePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Taskcell Hub: TASKCELL_HUB_PUBLIC_URL "${raw}" is not a URL — expected e.g. https://hub.example.com`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`Taskcell Hub: TASKCELL_HUB_PUBLIC_URL "${raw}" must be a bare http(s) origin, e.g. https://hub.example.com`);
  }
  return url.origin;
}

const loginOf = <P extends object>(prefix: 'github' | 'gitlab', key: string) => (profile: P): { providerLogin?: string } => {
  const login = (profile as Record<string, unknown>)[key];
  return typeof login === 'string' && login !== '' ? { providerLogin: `${prefix}:${login}` } : {};
};

/** Server-mode identity: Better Auth over node:sqlite, with the owner user the token maps to. */
export async function createHubIdentity(opts: CreateIdentityOptions): Promise<HubIdentity> {
  await mkdir(opts.configDir, { recursive: true });
  // The db holds sessions and the providers' OAuth tokens: private from the start.
  const dbPath = join(opts.configDir, 'auth.sqlite');
  await writeFile(dbPath, '', { flag: 'a', mode: 0o600 });
  await chmod(dbPath, 0o600);
  const db = new DatabaseSync(dbPath);
  // GitHub numeric id -> login, written only from the provider-verified profile at each GitHub OAuth
  // callback. Hub-owned: Better Auth's `/update-user` cannot reach it.
  db.exec('CREATE TABLE IF NOT EXISTS hub_github_login (github_id TEXT PRIMARY KEY, login TEXT NOT NULL)');
  const recordGithubLogin = db.prepare(
    'INSERT INTO hub_github_login (github_id, login) VALUES (?, ?) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login',
  );
  // The same for GitLab (numeric id -> username).
  db.exec('CREATE TABLE IF NOT EXISTS hub_gitlab_login (gitlab_id TEXT PRIMARY KEY, login TEXT NOT NULL)');
  const recordGitlabLogin = db.prepare(
    'INSERT INTO hub_gitlab_login (gitlab_id, login) VALUES (?, ?) ON CONFLICT(gitlab_id) DO UPDATE SET login = excluded.login',
  );
  const allowed = opts.allowlist ?? parseSignupAllowlist([]);
  const configs = opts.providers ?? {};

  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {};
  if (configs.github) {
    const mapLogin = loginOf('github', 'login');
    socialProviders.github = {
      ...configs.github,
      mapProfileToUser: (profile) => {
        const { id, login } = profile as { id?: unknown; login?: unknown };
        if ((typeof id === 'number' || typeof id === 'string') && typeof login === 'string' && login !== '') recordGithubLogin.run(String(id), login);
        return mapLogin(profile);
      },
    };
  }
  if (configs.gitlab) {
    const mapLogin = loginOf('gitlab', 'username');
    socialProviders.gitlab = {
      ...configs.gitlab,
      mapProfileToUser: (profile) => {
        const { id, username } = profile as { id?: unknown; username?: unknown };
        if ((typeof id === 'number' || typeof id === 'string') && typeof username === 'string' && username !== '') recordGitlabLogin.run(String(id), username);
        return mapLogin(profile);
      },
    };
  }
  if (configs.google) socialProviders.google = { ...configs.google };

  let creatingOwner = false;
  const options: BetterAuthOptions = {
    appName: 'Taskcell Hub',
    baseURL: opts.baseURL,
    secret: await loadSecret(opts.configDir, opts.env ?? process.env),
    database: db,
    socialProviders,
    // `input` must stay true: Better Auth drops input:false keys of a provider profile before the
    // create hook sees them. Only that hook (sign-up allowlist) reads it: rows written before
    // `/update-user` was disabled may hold a rewritten value, so it is never trusted for identity.
    user: { additionalFields: { providerLogin: { type: 'string', required: false } } },
    // Sign-up is closed: an OAuth profile creates an account only when the allowlist names it.
    // Returning false (not throwing) makes the callback redirect to the error URL below with
    // `?error=unable_to_create_user`, which the sign-in page words as SIGNUP_REFUSED_MESSAGE.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (creatingOwner) return;
            const login = (user as { providerLogin?: unknown }).providerLogin;
            const ok = allowed({ email: user.email, emailVerified: user.emailVerified === true, login: typeof login === 'string' ? login : undefined });
            return ok ? undefined : false;
          },
        },
      },
    },
    onAPIError: { errorURL: '/sign-in' },
    // `providerLogin` is an input field, so `/update-user` would let a signed-in user rewrite it to
    // `github:<an admin>` and pass the credential admin check. The hub never edits a profile.
    // `/list-sessions` returns every session's token to page script, the app's device-flow (`tcd_`) bearers included.
    disabledPaths: ['/update-user', '/list-sessions'],
  };

  await (await getMigrations(options)).runMigrations();
  const githubLoginOf = db.prepare(
    "SELECT l.login AS login FROM account a JOIN hub_github_login l ON l.github_id = a.accountId WHERE a.userId = ? AND a.providerId = 'github' LIMIT 1",
  );
  const gitlabLoginOf = db.prepare(
    "SELECT l.login AS login FROM account a JOIN hub_gitlab_login l ON l.gitlab_id = a.accountId WHERE a.userId = ? AND a.providerId = 'gitlab' LIMIT 1",
  );
  const auth = betterAuth(options);
  const ctx = await auth.$context;
  // Unverified on purpose: Better Auth only links a provider account to an existing user whose e-mail
  // is verified, so no provider profile can claim the owner (and skip the allowlist) by e-mail.
  creatingOwner = true;
  let row;
  try {
    // The second argument is only read when `validateUserInfo` is configured, which it is not.
    row =
      (await ctx.internalAdapter.findUserByEmail(OWNER_EMAIL))?.user ??
      (await ctx.internalAdapter.createUser({ email: OWNER_EMAIL, name: 'Owner', emailVerified: false }, undefined as never));
    if (row.emailVerified) row = (await ctx.internalAdapter.updateUser(row.id, { emailVerified: false })) ?? row;
  } finally {
    creatingOwner = false;
  }
  const owner: HubUser = { id: row.id, email: row.email, name: row.name };

  const toHubUser = ({ id, email, name, emailVerified }: { id: string; email: string; name: string; emailVerified: boolean }): HubUser => {
    const github = (githubLoginOf.get(id) as { login?: unknown } | undefined)?.login;
    const gitlab = (gitlabLoginOf.get(id) as { login?: unknown } | undefined)?.login;
    const logins = [
      ...(typeof github === 'string' && github !== '' ? [`github:${github}`] : []),
      ...(typeof gitlab === 'string' && gitlab !== '' ? [`gitlab:${gitlab}`] : []),
    ];
    return { id, email, name, emailVerified, ...(logins.length > 0 ? { login: logins[0], logins } : {}) };
  };

  const allowedNow = (user: HubUser): boolean =>
    user.id === owner.id || (user.logins ?? [undefined]).some((login) => allowed({ email: user.email, emailVerified: user.emailVerified === true, login }));

  return {
    owner,
    baseURL: opts.baseURL,
    providers: Object.keys(socialProviders) as AuthProviderId[],
    handler: toNodeHandler(auth),
    sessionUser: async (req) => {
      let session;
      try {
        session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      } catch (error) {
        // A database or Better Auth failure is not "signed out": surface it (500), do not bounce to sign-in.
        console.error('Taskcell Hub: session lookup failed:', error);
        throw error;
      }
      if (session === null) return undefined;
      return toHubUser(session.user);
    },
    userById: async (userId) => {
      const u = await ctx.internalAdapter.findUserById(userId);
      if (u === null || u === undefined) return undefined;
      const user = toHubUser(u);
      // An account the sign-up allowlist no longer names is as good as gone (the owner is not an OAuth account).
      return allowedNow(user) ? user : undefined;
    },
    issueDeviceSession: async (userId) => {
      const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('hex');
      // `overrideAll` is what lets the token be ours; the session otherwise takes Better Auth's defaults (expiry).
      const session = await ctx.internalAdapter.createSession(userId, false, { token }, true);
      return session?.token;
    },
    deviceSessionUser: async (token) => {
      if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return undefined;
      const found = await ctx.internalAdapter.findSession(token);
      if (found === null || found === undefined || found.session.expiresAt.getTime() <= Date.now()) return undefined;
      const user = toHubUser(found.user);
      return allowedNow(user) ? user : undefined;
    },
    revokeDeviceSession: async (token) => {
      if (token.startsWith(DEVICE_TOKEN_PREFIX)) await ctx.internalAdapter.deleteSession(token);
    },
    close: () => db.close(),
  };
}

/** Local mode (loopback, no sign-in) and hubs created without an identity: the token — or no
 * credential at all — is the one automatic owner user. */
export function localOnlyIdentity(): HubIdentity {
  return {
    owner: { id: 'local-owner', email: OWNER_EMAIL, name: 'Owner' },
    baseURL: undefined,
    providers: [],
    handler: undefined,
    sessionUser: async () => undefined,
    userById: async (id) => (id === 'local-owner' ? { id, email: OWNER_EMAIL, name: 'Owner' } : undefined),
    issueDeviceSession: async () => undefined,
    deviceSessionUser: async () => undefined,
    revokeDeviceSession: async () => undefined,
    close: () => undefined,
  };
}

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LABELS: Record<AuthProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', google: 'Google' };

/** The server-mode sign-in page: one button per enabled provider, plus a refusal reason from `?error=`. */
export function signInPage(providers: readonly AuthProviderId[], error: string | undefined, next: '/' | '/device' = '/'): string {
  const message = error === undefined ? '' : `<p role="alert">${esc(error === 'FORBIDDEN' || error === 'unable_to_create_user' ? SIGNUP_REFUSED_MESSAGE : error.replace(/_/g, ' '))}</p>`;
  const buttons =
    providers.length === 0
      ? '<p>No sign-in provider is configured on this hub. See docs/hub.md, “Server mode sign-in”.</p>'
      : providers.map((p) => `<p><button data-provider="${p}">Continue with ${LABELS[p]}</button></p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in — Taskcell Hub</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;max-width:24rem;margin:4rem auto">
<h1>Taskcell Hub</h1>${message}${buttons}
<script>document.querySelectorAll('button[data-provider]').forEach(function(b){b.onclick=async function(){
var r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:b.dataset.provider,callbackURL:'${next}',errorCallbackURL:'/sign-in'})});
var j=await r.json();if(j.url)location.href=j.url;};});</script></body></html>`;
}
