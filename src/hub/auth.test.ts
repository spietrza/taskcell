import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHubIdentity, localOnlyIdentity, OWNER_EMAIL, parsePublicUrl, parseSignupAllowlist, providersFromEnv, SIGNUP_REFUSED_MESSAGE, type HubIdentity } from './auth.js';
import { saveTeams } from './teams.js';
import { createHubServer, type HubServer } from './server.js';
import { contentSecurityPolicy } from './static.js';
import { HUB_SIGN_IN_REQUIRED, HUB_TOKEN_HEADER } from '../hub-wire.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';
import { createCredentialService } from './credentials.js';

describe('providersFromEnv', () => {
  test('enables only providers with both id and secret; GitLab takes an issuer', () => {
    const p = providersFromEnv({
      TASKCELL_HUB_AUTH_GITHUB_CLIENT_ID: 'id',
      TASKCELL_HUB_AUTH_GITHUB_CLIENT_SECRET: 's',
      TASKCELL_HUB_AUTH_GITLAB_CLIENT_ID: 'gid',
      TASKCELL_HUB_AUTH_GITLAB_CLIENT_SECRET: 'gs',
      TASKCELL_HUB_AUTH_GITLAB_ISSUER: 'https://gitlab.example.com/',
      TASKCELL_HUB_AUTH_GOOGLE_CLIENT_ID: 'only-id',
    });
    expect(Object.keys(p)).toEqual(['github', 'gitlab']);
    expect(p.gitlab?.issuer).toBe('https://gitlab.example.com');
  });
});

describe('parseSignupAllowlist', () => {
  const allowed = parseSignupAllowlist(['Ann@Example.com', '@corp.test', 'github:octo', 'gitlab:lab']);
  const base = { email: 'x@nowhere.test', emailVerified: true };
  test('matches e-mail, domain and logins case-insensitively', () => {
    expect(allowed({ ...base, email: 'ann@example.com' })).toBe(true);
    expect(allowed({ ...base, email: 'bob@CORP.test' })).toBe(true);
    expect(allowed({ ...base, login: 'github:Octo' })).toBe(true);
    expect(allowed({ ...base, login: 'gitlab:lab' })).toBe(true);
  });
  test('refuses everyone else, and unverified e-mails', () => {
    expect(allowed(base)).toBe(false);
    expect(allowed({ ...base, login: 'github:other' })).toBe(false);
    expect(allowed({ email: 'ann@example.com', emailVerified: false })).toBe(false);
    expect(parseSignupAllowlist([])({ ...base, email: 'ann@example.com' })).toBe(false);
  });
  test('rejects a malformed entry', () => {
    expect(() => parseSignupAllowlist(['nonsense'])).toThrow(/invalid sign-up allowlist entry/);
  });
});

describe('parsePublicUrl', () => {
  test('takes a bare origin only', () => {
    expect(parsePublicUrl('https://hub.example.com/')).toBe('https://hub.example.com');
    expect(parsePublicUrl('http://hub.example.com:8080')).toBe('http://hub.example.com:8080');
    expect(() => parsePublicUrl('hub.example.com')).toThrow(/not a URL/);
    expect(() => parsePublicUrl('https://hub.example.com/app')).toThrow(/bare http\(s\) origin/);
  });
});

const deps = { capabilities: () => ({}) } as unknown as SidecarDeps;
const TOKEN = 't'.repeat(64);

describe('server mode', () => {
  let dir: string;
  let hub: HubServer | undefined;
  let identity: HubIdentity | undefined;
  let origin: string;
  let profile: { login: string; email: string; verified: boolean };
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-auth-'));
    profile = { login: 'Octo', email: 'octo@nowhere.test', verified: true };
    // Stub only the GitHub endpoints Better Auth calls; the hub itself is reached for real.
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://github.com/login/oauth/access_token')) return json({ access_token: 'at', token_type: 'bearer', scope: 'user:email' });
      if (url === 'https://api.github.com/user') return json({ id: 42, login: profile.login, name: 'Octo Cat', email: profile.email, avatar_url: '' });
      if (url === 'https://api.github.com/user/emails') return json([{ email: profile.email, primary: true, verified: profile.verified }]);
      if (url === 'https://gl.test/oauth/token') return json({ access_token: 'gt', token_type: 'Bearer', scope: 'read_user' });
      if (url === 'https://gl.test/api/v4/user') return json({ id: 7, username: 'Alice', name: 'Alice', email: profile.email, avatar_url: '', state: 'active', locked: false, email_verified: true });
      return realFetch(input, init);
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await hub?.close();
    hub = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function start(allow: string[]): Promise<void> {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    origin = `http://127.0.0.1:${port}`;
    identity = await createHubIdentity({
      configDir: dir,
      baseURL: origin,
      providers: { github: { clientId: 'a', clientSecret: 'b' }, gitlab: { clientId: 'c', clientSecret: 'd', issuer: 'https://gl.test' } },
      allowlist: parseSignupAllowlist(allow),
    });
    hub = createHubServer({ uiDir: dir, configDir: dir, browseRoot: dir, bind: { isLoopback: false, allowAdd: false }, deps, identity, token: TOKEN });
    await hub.listen(port, '127.0.0.1');
  }

  const cookieOf = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
  const post = (path: string, headers: Record<string, string>, body = '{}'): Promise<Response> =>
    fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin, ...headers }, body });

  /** The real OAuth dance against the stubbed provider: start, then hit the callback with its state. */
  async function signIn(provider: 'github' | 'gitlab' = 'github', headers: Record<string, string> = {}, callbackURL = '/'): Promise<{ callback: Response; cookie: string }> {
    const begin = await post('/api/auth/sign-in/social', headers, JSON.stringify({ provider, callbackURL, errorCallbackURL: callbackURL === '/' ? '/sign-in' : callbackURL }));
    const { url } = (await begin.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const callback = await fetch(`${origin}/api/auth/callback/${provider}?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: [headers.cookie, cookieOf(begin)].filter(Boolean).join('; ') } });
    return { callback, cookie: [cookieOf(begin), cookieOf(callback)].filter(Boolean).join('; ') };
  }
  const rpc = (headers: Record<string, string>): Promise<Response> => post('/rpc/list_projects', headers);

  test('team_role over HTTP: a session keys on the user id, never the display name; the token is the owner', async () => {
    await start(['github:octo']);
    const { cookie } = await signIn();
    const user = await identity!.sessionUser({ headers: { cookie } } as IncomingMessage);
    expect(user).toMatchObject({ name: 'Octo Cat' });
    const role = async (headers: Record<string, string>): Promise<unknown> =>
      ((await (await post('/rpc/team_role', headers, JSON.stringify({ id: 'default' }))).json()) as { result: unknown }).result;
    await saveTeams(dir, [
      { id: 'default', name: 'Default', members: [{ login: user!.id, role: 'member' }, { login: 'Octo Cat', role: 'admin' }], repositories: [] },
    ]);
    expect(await role({ cookie })).toBe('member');
    expect(await role({ [HUB_TOKEN_HEADER]: TOKEN })).toBe('admin');
    await saveTeams(dir, [{ id: 'default', name: 'Default', members: [{ login: 'Octo Cat', role: 'admin' }], repositories: [] }]);
    expect(await role({ cookie })).toBeNull();
  });

  test('a GitLab sign-in resolves its verified username; a user who also has GitHub keeps both logins', async () => {
    await start(['gitlab:alice', 'github:octo']);
    profile.email = 'alice@nowhere.test';
    const gl = await signIn('gitlab');
    expect(gl.callback.headers.get('location')).not.toContain('error');
    expect(await identity!.sessionUser({ headers: { cookie: gl.cookie } } as IncomingMessage)).toMatchObject({ login: 'gitlab:Alice', logins: ['gitlab:Alice'] });
    // The same verified address signs in with GitHub: one user, both logins.
    const gh = await signIn('github');
    const user = await identity!.sessionUser({ headers: { cookie: gh.cookie } } as IncomingMessage);
    expect(user?.logins).toEqual(['github:Octo', 'gitlab:Alice']);
    const glUser = await identity!.sessionUser({ headers: { cookie: gl.cookie } } as IncomingMessage);
    expect(glUser?.id).toBe(user?.id);
  });

  test('a login on the allowlist signs in; the session authorises RPC and SSE until sign-out', async () => {
    await start(['github:octo']);
    const { callback, cookie } = await signIn();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).not.toContain('error');
    expect((await rpc({ cookie })).status).toBe(200);
    const me = (await (await fetch(`${origin}/api/auth/get-session`, { headers: { cookie } })).json()) as { user: { id: string; email: string } };
    expect(me.user.email).toBe('octo@nowhere.test');
    expect(me.user.id).not.toBe(identity!.owner.id);
    expect(await identity!.sessionUser({ headers: { cookie } } as IncomingMessage)).toMatchObject({ id: me.user.id });

    // No events cookie for a session user: /events rides the session itself.
    const events = await post('/events/session', { cookie });
    expect(events.status).toBe(200);
    expect(events.headers.get('set-cookie')).toBeNull();
    const ac = new AbortController();
    expect((await fetch(`${origin}/events`, { headers: { cookie }, signal: ac.signal })).status).toBe(200);
    ac.abort();

    expect((await post('/api/auth/sign-out', { cookie })).status).toBe(200);
    const after = await rpc({ cookie });
    expect(after.status).toBe(401);
    expect(JSON.stringify(await after.json())).toContain(HUB_SIGN_IN_REQUIRED);
    expect((await fetch(`${origin}/events`, { headers: { cookie } })).status).toBe(401);
  });

  test('the sign-up refusal redirects to the sign-in page and says why', async () => {
    await start(['someone@else.test']);
    const { callback, cookie } = await signIn();
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get('location')!, origin);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('error')).toBe('unable_to_create_user');
    expect((await rpc({ cookie })).status).toBe(401);
    expect(await (await fetch(location)).text()).toContain('Sign-up is not open');
  });

  /** The native app's PKCE pair: the verifier stays in the app, the S256 challenge goes to `/native/start`. */
  const VERIFIER = 'v'.repeat(43);
  const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
  const nativeStart = (query = `provider=github&code_challenge=${CHALLENGE}&code_challenge_method=S256`): Promise<Response> =>
    fetch(`${origin}/api/auth/native/start?${query}`, { redirect: 'manual' });
  const redeem = (ott: string, verifier?: string): Promise<Response> =>
    post('/api/auth/native/token', {}, JSON.stringify({ ott, ...(verifier === undefined ? {} : { code_verifier: verifier }) }));
  const tokenOf = async (res: Response): Promise<string | undefined> => (res.status === 200 ? ((await res.json()) as { token: string }).token : undefined);

  /** The native app's round trip: `/native/start` in the system browser, the provider callback, `/native/complete`
   * (one-time token on `taskcell://auth`), then the app redeems it with its verifier (`null`: left unredeemed). */
  async function nativeSignIn(verifier: string | null = VERIFIER): Promise<{ location: URL; ott: string | null; bearer?: string | undefined; cookie: string }> {
    const begin = await nativeStart();
    expect(begin.status).toBe(302);
    const state = new URL(begin.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${origin}/api/auth/callback/github?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: cookieOf(begin) } });
    const cookie = [cookieOf(begin), cookieOf(callback)].join('; ');
    // The system browser follows the callback's redirect to the hub's native page, carrying the cookie jar.
    const complete = await fetch(new URL(callback.headers.get('location')!, origin), { redirect: 'manual', headers: { cookie } });
    const location = new URL(complete.headers.get('location')!);
    const ott = location.searchParams.get('ott');
    if (ott === null || verifier === null) return { location, ott, cookie };
    return { location, ott, bearer: await tokenOf(await redeem(ott, verifier)), cookie };
  }

  test('native sign-in: an allowlisted member gets a bearer session for RPC and SSE; sign-out revokes it', async () => {
    await start(['github:octo']);
    const providers = (await (await fetch(origin + '/api/auth/native/providers')).json()) as { providers: string[] };
    expect((await nativeStart(`provider=nope&code_challenge=${CHALLENGE}&code_challenge_method=S256`)).status).toBe(400);
    expect(providers.providers).toEqual(['github', 'gitlab']);
    const { location, bearer } = await nativeSignIn();
    expect(location.protocol + '//' + location.host).toBe('taskcell://auth');
    expect(bearer).toBeTruthy();
    const auth = { authorization: `Bearer ${bearer}` };
    expect((await rpc(auth)).status).toBe(200);
    const me = (await (await fetch(origin + '/api/auth/get-session', { headers: auth })).json()) as { user: { email: string } };
    expect(me.user.email).toBe('octo@nowhere.test');
    const ac = new AbortController();
    expect((await fetch(origin + '/events', { headers: auth, signal: ac.signal })).status).toBe(200);
    ac.abort();
    expect((await post('/api/auth/sign-out', auth)).status).toBe(200);
    expect((await rpc(auth)).status).toBe(401);
  });

  test('native sign-in: a non-allowlisted account is refused with the hub message and gets no session', async () => {
    await start(['someone@else.test']);
    const { location, bearer } = await nativeSignIn();
    expect(bearer).toBeUndefined();
    expect(location.searchParams.get('ott')).toBeNull();
    expect(location.searchParams.get('error')).toBe(SIGNUP_REFUSED_MESSAGE);
  });

  test('native sign-in: a provider or caller error code reads as a fixed message, never as its own text', async () => {
    await start(['github:octo']);
    const errorOf = async (code: string): Promise<string | null> => {
      const res = await fetch(`${origin}/api/auth/native/complete?error=${encodeURIComponent(code)}`, { redirect: 'manual' });
      return new URL(res.headers.get('location')!).searchParams.get('error');
    };
    expect(await errorOf('unable_to_create_user')).toBe(SIGNUP_REFUSED_MESSAGE);
    expect(await errorOf('access_denied')).toBe('Sign-in was cancelled at the provider.');
    expect(await errorOf('Your_hub_was_moved_visit_evil.example')).toBe('Sign-in did not complete. Try again.');
  });

  test('native sign-in: /start needs an S256 challenge, a plain link starts nothing', async () => {
    await start(['github:octo']);
    expect((await nativeStart('provider=github')).status).toBe(400);
    expect((await nativeStart(`provider=github&code_challenge=${CHALLENGE}`)).status).toBe(400);
    expect((await nativeStart('provider=github&code_challenge=short&code_challenge_method=S256')).status).toBe(400);
  });

  test('native sign-in: a wrong or missing verifier gets no session and burns the token', async () => {
    await start(['github:octo']);
    expect((await nativeSignIn('w'.repeat(43))).bearer).toBeUndefined();
    const missing = await nativeSignIn(null);
    expect(missing.ott).toBeTruthy();
    const noVerifier = await redeem(missing.ott!);
    expect(noVerifier.status).toBe(400);
    // The binding went with the failed attempt: the right verifier is now too late.
    expect(await tokenOf(await redeem(missing.ott!, VERIFIER))).toBeUndefined();
  });

  test('native sign-in: the one-time token is single use and never redeemed through Better Auth directly', async () => {
    await start(['github:octo']);
    const { ott, bearer } = await nativeSignIn();
    expect(bearer).toBeTruthy();
    expect(await tokenOf(await redeem(ott!, VERIFIER))).toBeUndefined();
    expect(await tokenOf(await redeem('forged', VERIFIER))).toBeUndefined();
    // A fresh token, taken off the redirect by another app, cannot skip the verifier through the plugin's own routes.
    const { ott: fresh } = await nativeSignIn(null);
    const direct = await post('/api/auth/one-time-token/verify', {}, JSON.stringify({ token: fresh }));
    expect(direct.status).toBe(404);
    expect(direct.headers.get('set-auth-token')).toBeNull();
    expect(direct.headers.getSetCookie().join()).not.toContain('session_token');
    expect(await tokenOf(await redeem(fresh!, VERIFIER))).toBeTruthy();
    expect((await rpc({ authorization: 'Bearer forged' })).status).toBe(401);
  });

  test('native sign-in: /complete mints nothing without the challenge /start set, even for a signed-in browser', async () => {
    await start(['github:octo']);
    const bare = await fetch(origin + '/api/auth/native/complete', { redirect: 'manual' });
    expect(new URL(bare.headers.get('location')!).searchParams.get('ott')).toBeNull();
    // A cross-site page sends a signed-in browser (session cookie, no challenge cookie) to /complete.
    const { cookie } = await signIn();
    const crossSite = await fetch(origin + '/api/auth/native/complete', { redirect: 'manual', headers: { cookie, 'sec-fetch-site': 'cross-site', referer: 'https://evil.example/' } });
    const location = new URL(crossSite.headers.get('location')!);
    expect(location.searchParams.get('ott')).toBeNull();
    expect(location.searchParams.get('error')).toBe('Sign-in did not complete. Try again.');
    // Nor can the browser mint one through the plugin's own route.
    expect((await fetch(origin + '/api/auth/one-time-token/generate', { headers: { cookie } })).status).toBe(404);
  });

  test('browser sign-in responses do not expose the session as set-auth-token', async () => {
    await start(['github:octo']);
    const { callback, cookie } = await signIn();
    expect(callback.headers.get('set-auth-token')).toBeNull();
    const session = await fetch(origin + '/api/auth/get-session', { headers: { cookie } });
    expect(session.headers.get('set-auth-token')).toBeNull();
    expect(session.headers.get('access-control-expose-headers') ?? '').not.toContain('set-auth-token');
  });

  test('a verified domain admits an account', async () => {
    await start(['@nowhere.test']);
    const { callback, cookie } = await signIn();
    expect(callback.headers.get('location')).not.toContain('error');
    expect((await rpc({ cookie })).status).toBe(200);
  });

  test('userById resolves a user only while the sign-up allowlist still names them; the owner always resolves', async () => {
    await start(['github:octo']);
    const { cookie } = await signIn();
    const user = await identity!.sessionUser({ headers: { cookie } } as IncomingMessage);
    expect(await identity!.userById(user!.id)).toMatchObject({ id: user!.id });
    expect(await identity!.userById('no-such-user')).toBeUndefined();
    // The operator removes the account from the allowlist and restarts: it still exists, but no longer runs tasks.
    const narrowed = await createHubIdentity({ configDir: dir, baseURL: origin, providers: { github: { clientId: 'a', clientSecret: 'b' } }, allowlist: parseSignupAllowlist(['someone@else.test']) });
    try {
      expect(await narrowed.userById(user!.id)).toBeUndefined();
      expect(await narrowed.userById(narrowed.owner.id)).toMatchObject({ id: narrowed.owner.id });
    } finally {
      narrowed.close();
    }
  });

  test('a provider profile cannot claim the owner user by e-mail', async () => {
    await start(['@hub.invalid']);
    profile = { login: 'evil', email: OWNER_EMAIL, verified: true };
    const { cookie } = await signIn();
    expect((await rpc({ cookie })).status).toBe(401);
  });

  test('the sign-in page carries the app pages\' CSP, allowing its own inline script by hash, and cannot be framed', async () => {
    await start([]);
    const res = await fetch(origin + '/sign-in');
    const html = await res.text();
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(contentSecurityPolicy(html));
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect((await fetch(origin + '/sign-in', { method: 'HEAD' })).headers.get('content-security-policy')).toBe(csp);
  });

  test('pages redirect, the API answers 401, the token is the owner and gets the events cookie', async () => {
    await start([]);
    const page = await fetch(origin + '/', { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/sign-in');
    const signInPage = await (await fetch(origin + '/sign-in')).text();
    expect(signInPage).toContain('Continue with GitHub');
    expect(signInPage).toContain('Continue with GitLab');
    expect(signInPage).not.toContain('Continue with Google');
    expect((await fetch(origin + '/events')).status).toBe(401);
    expect((await rpc({})).status).toBe(401);
    expect((await rpc({ [HUB_TOKEN_HEADER]: TOKEN })).status).toBe(200);
    const events = await post('/events/session', { [HUB_TOKEN_HEADER]: TOKEN });
    expect(events.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await post('/events/session', { [HUB_TOKEN_HEADER]: 'wrong' })).status).toBe(401);
  });

  test('the admin login comes from the GitHub account row, not the user-writable providerLogin', async () => {
    await start(['github:octo']);
    const { cookie } = await signIn();
    const req = { headers: { cookie } } as IncomingMessage;
    const admins = createCredentialService(dir, ['root', 'octo']);
    expect(await identity!.sessionUser(req)).toMatchObject({ login: 'github:Octo' });
    // A row poisoned through `/update-user` before it was disabled: providerLogin claims the operator.
    const db = new DatabaseSync(join(dir, 'auth.sqlite'));
    try {
      db.prepare("UPDATE user SET providerLogin = 'github:root'").run();
      const poisoned = await identity!.sessionUser(req);
      expect(poisoned?.login).toBe('github:Octo');
      expect(createCredentialService(dir, ['root']).isAdmin(poisoned)).toBe(false);
      expect(admins.isAdmin(poisoned)).toBe(true);
      // No verified login recorded for the account's GitHub id (signed in before the upgrade): no login, no admin.
      db.exec('DELETE FROM hub_github_login');
      const unverified = await identity!.sessionUser(req);
      expect(unverified?.login).toBeUndefined();
      expect(admins.isAdmin(unverified)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('the auth db is private to the operator', async () => {
    await start([]);
    if (process.platform !== 'win32') expect((await stat(join(dir, 'auth.sqlite'))).mode & 0o077).toBe(0);
  });
});

describe('local mode', () => {
  test('no sign-in page, no /api/auth, and the token still works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-auth-'));
    const hub = createHubServer({ uiDir: dir, configDir: dir, browseRoot: dir, bind: { isLoopback: true, allowAdd: false }, deps, identity: localOnlyIdentity(), token: TOKEN });
    try {
      await hub.listen(0, '127.0.0.1');
      const origin = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
      expect((await fetch(origin + '/sign-in')).status).toBe(404);
      expect((await fetch(origin + '/api/auth/ok')).status).toBe(404);
      const rpc = (headers: Record<string, string>): Promise<Response> =>
        fetch(origin + '/rpc/list_projects', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: '{}' });
      expect((await rpc({})).status).toBe(401);
      expect((await rpc({ [HUB_TOKEN_HEADER]: TOKEN })).status).toBe(200);
    } finally {
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
