// Hub sign-in (server mode) on Better Auth, stored in node:sqlite (no native module). Every hub
// request resolves to a HubUser: the Better Auth session, the hub token (-> owner), or — on a
// loopback bind — the automatic owner. Docs: docs/hub.md "Server mode sign-in".
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { bearer, oneTimeToken } from 'better-auth/plugins';
import { readEnv } from '../core/env.js';
import { writeJson } from './json-response.js';

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
  /** Enabled sign-in providers (empty in local mode: no OAuth there). */
  readonly providers: readonly AuthProviderId[];
  /** The signed-in user of this request's session cookie, if any. Always undefined in local mode. */
  sessionUser(req: IncomingMessage): Promise<HubUser | undefined>;
  /** The user with this id as the store holds them now (undefined: gone, or no longer allowed to have an account). For work that runs later as a stored user; required, so no identity can skip the check. */
  userById(id: string): Promise<HubUser | undefined>;
  /** Better Auth's node handler for `/api/auth/*`; undefined in local mode (no sign-in). */
  readonly handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  close(): void;
}

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

/** The native app's sign-in round trip, PKCE-style: it opens `NATIVE_START_PATH?provider=…&code_challenge=S256(verifier)`
 * in the system browser, whose OAuth callback lands on `NATIVE_COMPLETE_PATH`; that hands out a one-time token bound
 * to the challenge, which only `NATIVE_TOKEN_PATH` with the matching verifier trades for a bearer session. */
export const NATIVE_COMPLETE_PATH = '/api/auth/native/complete';
export const NATIVE_START_PATH = '/api/auth/native/start';
export const NATIVE_TOKEN_PATH = '/api/auth/native/token';
/** Public: which providers this hub offers (the mobile Connect screen asks before sign-in). */
export const NATIVE_PROVIDERS_PATH = '/api/auth/native/providers';
export const NATIVE_REDIRECT = 'taskcell://auth';
/** Binds a native sign-in to the browser that started it; only `/api/auth/native/*` ever sees it. */
const NATIVE_CHALLENGE_COOKIE = 'taskcell-native-challenge';
const NATIVE_CHALLENGE_TTL_S = 600;
/** How long a native one-time token, and the challenge binding stored with it, stays redeemable. */
const NATIVE_OTT_TTL_MIN = 1;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** The fixed messages a native sign-in ends with: never a provider's or a caller's own error text. */
export const NATIVE_SIGN_IN_FAILED = 'Sign-in did not complete. Try again.';
export const NATIVE_SIGN_IN_CANCELLED = 'Sign-in was cancelled at the provider.';
const nativeErrorMessage = (code: string): string =>
  code === 'FORBIDDEN' || code === 'unable_to_create_user' ? SIGNUP_REFUSED_MESSAGE : code === 'access_denied' ? NATIVE_SIGN_IN_CANCELLED : NATIVE_SIGN_IN_FAILED;

const cookieValue = (req: IncomingMessage, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
};

/** The request body, or undefined once it passes `limit` characters. */
async function readBody(req: IncomingMessage, limit = 4096): Promise<string | undefined> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > limit) return undefined;
  }
  return body;
}

/** Better Auth's `bearer` limited to accepting `Authorization: Bearer`: its after-hook, which copies every new
 * session cookie into a `set-auth-token` header that page scripts can read, is dropped. Native clients get
 * their session from NATIVE_TOKEN_PATH instead. */
function acceptBearerOnly(): ReturnType<typeof bearer> {
  const plugin = bearer();
  return { ...plugin, hooks: { before: plugin.hooks.before } } as ReturnType<typeof bearer>;
}

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
    // Native clients (apps/mobile) hold a bearer session instead of a cookie: `bearer` accepts it as
    // `Authorization: Bearer`; `oneTimeToken` carries it out of the system browser's OAuth round trip
    // (see NATIVE_START_PATH). Browser cookie sign-in is unchanged.
    plugins: [acceptBearerOnly(), oneTimeToken({ expiresIn: NATIVE_OTT_TTL_MIN, disableClientRequest: true, disableSetSessionCookie: true })],
    onAPIError: { errorURL: '/sign-in' },
    // `providerLogin` is an input field, so `/update-user` would let a signed-in user rewrite it to
    // `github:<an admin>` and pass the credential admin check. The hub never edits a profile.
    // One-time tokens are minted and redeemed only by the hub's challenge-bound native endpoints, never by a caller.
    disabledPaths: ['/update-user', '/one-time-token/generate', '/one-time-token/verify'],
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
  const nodeHandler = toNodeHandler(auth);
  const signInSocial = (auth.api as unknown as { signInSocial(o: { body: Record<string, string>; headers: Headers; asResponse: true }): Promise<Response> }).signInSocial;
  const { generateOneTimeToken, verifyOneTimeToken } = auth.api as unknown as {
    generateOneTimeToken(o: { headers: Headers }): Promise<{ token: string }>;
    verifyOneTimeToken(o: { body: { token: string } }): Promise<{ session: { token: string } }>;
  };
  const secureCookie = opts.baseURL.startsWith('https:') ? '; Secure' : '';
  const challengeCookie = (value: string, maxAge: number): string =>
    `${NATIVE_CHALLENGE_COOKIE}=${value}; Path=/api/auth/native; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie}`;
  const bindingId = (ott: string): string => `taskcell-native:${ott}`;
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

  return {
    owner,
    providers: Object.keys(socialProviders) as AuthProviderId[],
    handler: async (req, res) => {
      const { pathname, searchParams } = new URL(req.url ?? '/', 'http://hub.local');
      if (pathname === NATIVE_PROVIDERS_PATH && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ providers: Object.keys(socialProviders) }));
        return;
      }
      if (pathname === NATIVE_START_PATH && req.method === 'GET') {
        // Started here, in the system browser, so Better Auth's state cookie lands in the browser that finishes the OAuth round trip.
        // The app's PKCE challenge is required: a plain link (no challenge) starts nothing.
        const provider = searchParams.get('provider') ?? '';
        const challenge = searchParams.get('code_challenge') ?? '';
        if (!Object.hasOwn(socialProviders, provider) || !S256_CHALLENGE.test(challenge) || searchParams.get('code_challenge_method') !== 'S256') {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('unknown sign-in provider or missing S256 code_challenge');
          return;
        }
        const begin = await signInSocial({
          body: { provider, callbackURL: NATIVE_COMPLETE_PATH, errorCallbackURL: NATIVE_COMPLETE_PATH },
          headers: fromNodeHeaders(req.headers),
          asResponse: true,
        });
        const { url } = (await begin.json()) as { url?: string };
        if (!begin.ok || url === undefined) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('sign-in could not start');
          return;
        }
        res.writeHead(302, { location: url, 'set-cookie': [...begin.headers.getSetCookie(), challengeCookie(challenge, NATIVE_CHALLENGE_TTL_S)], 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (pathname === NATIVE_TOKEN_PATH && req.method === 'POST') {
        // The app redeems the one-time token with the verifier only it holds: a token taken off the redirect is useless alone.
        const refuse = (): void => writeJson(res, 400, { error: NATIVE_SIGN_IN_FAILED }, { 'cache-control': 'no-store' });
        let body: { ott?: unknown; code_verifier?: unknown } | null;
        try {
          body = JSON.parse((await readBody(req)) ?? '') as typeof body;
        } catch {
          return refuse();
        }
        const { ott, code_verifier: verifier } = body ?? {};
        if (typeof ott !== 'string' || ott === '') return refuse();
        // Consumed on every attempt, so a wrong verifier burns the token.
        const binding = await ctx.internalAdapter.consumeVerificationValue(bindingId(ott));
        if (!binding || binding.expiresAt < new Date() || typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) return refuse();
        const want = Buffer.from(binding.value);
        const got = Buffer.from(s256(verifier));
        if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse();
        try {
          const { session } = await verifyOneTimeToken({ body: { token: ott } });
          writeJson(res, 200, { token: session.token }, { 'cache-control': 'no-store' });
        } catch {
          refuse();
        }
        return;
      }
      if (pathname !== NATIVE_COMPLETE_PATH || req.method !== 'GET') return nodeHandler(req, res);
      // The system browser lands here after the provider callback, holding the session cookie. Hand the
      // app a one-time token (valid a minute, single use, bound to the challenge `/native/start` set) —
      // never the session itself — on its own scheme. No challenge cookie, no token: a bare or cross-site
      // visit by a signed-in browser mints nothing.
      const challenge = cookieValue(req, NATIVE_CHALLENGE_COOKIE);
      const redirect = (params: Record<string, string>): void => {
        res.writeHead(302, { location: `${NATIVE_REDIRECT}?${new URLSearchParams(params)}`, 'set-cookie': challengeCookie('', 0), 'cache-control': 'no-store' });
        res.end();
      };
      const error = searchParams.get('error');
      if (error !== null) return redirect({ error: nativeErrorMessage(error) });
      if (challenge === undefined || !S256_CHALLENGE.test(challenge)) return redirect({ error: NATIVE_SIGN_IN_FAILED });
      try {
        const { token } = await generateOneTimeToken({ headers: fromNodeHeaders(req.headers) });
        await ctx.internalAdapter.createVerificationValue({ identifier: bindingId(token), value: challenge, expiresAt: new Date(Date.now() + NATIVE_OTT_TTL_MIN * 60_000) });
        return redirect({ ott: token });
      } catch {
        return redirect({ error: NATIVE_SIGN_IN_FAILED });
      }
    },
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
      if (user.id !== owner.id && !(user.logins ?? [undefined]).some((login) => allowed({ email: user.email, emailVerified: user.emailVerified === true, login }))) return undefined;
      return user;
    },
    close: () => db.close(),
  };
}

/** Local mode (loopback, no sign-in) and hubs created without an identity: the token — or no
 * credential at all — is the one automatic owner user. */
export function localOnlyIdentity(): HubIdentity {
  return {
    owner: { id: 'local-owner', email: OWNER_EMAIL, name: 'Owner' },
    providers: [],
    handler: undefined,
    sessionUser: async () => undefined,
    userById: async (id) => (id === 'local-owner' ? { id, email: OWNER_EMAIL, name: 'Owner' } : undefined),
    close: () => undefined,
  };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LABELS: Record<AuthProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', google: 'Google' };

/** The server-mode sign-in page: one button per enabled provider, plus a refusal reason from `?error=`. */
export function signInPage(providers: readonly AuthProviderId[], error: string | undefined): string {
  const message = error === undefined ? '' : `<p role="alert">${esc(error === 'FORBIDDEN' || error === 'unable_to_create_user' ? SIGNUP_REFUSED_MESSAGE : error.replace(/_/g, ' '))}</p>`;
  const buttons =
    providers.length === 0
      ? '<p>No sign-in provider is configured on this hub. See docs/hub.md, “Server mode sign-in”.</p>'
      : providers.map((p) => `<p><button data-provider="${p}">Continue with ${LABELS[p]}</button></p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in — Taskcell Hub</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;max-width:24rem;margin:4rem auto">
<h1>Taskcell Hub</h1>${message}${buttons}
<script>document.querySelectorAll('button[data-provider]').forEach(function(b){b.onclick=async function(){
var r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:b.dataset.provider,callbackURL:'/',errorCallbackURL:'/sign-in'})});
var j=await r.json();if(j.url)location.href=j.url;};});</script></body></html>`;
}
