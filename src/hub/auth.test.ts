import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHubIdentity, localOnlyIdentity, OWNER_EMAIL, parsePublicUrl, parseSignupAllowlist, providersFromEnv, type HubIdentity } from './auth.js';
import { saveTeams } from './teams.js';
import { createHubServer, type HubServer } from './server.js';
import { HUB_SIGN_IN_REQUIRED, HUB_TOKEN_HEADER } from '../hub-wire.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';

describe('providersFromEnv', () => {
  test('enables only providers with both id and secret; GitLab takes an issuer', () => {
    const p = providersFromEnv({
      VANGUARD_HUB_AUTH_GITHUB_CLIENT_ID: 'id',
      VANGUARD_HUB_AUTH_GITHUB_CLIENT_SECRET: 's',
      VANGUARD_HUB_AUTH_GITLAB_CLIENT_ID: 'gid',
      VANGUARD_HUB_AUTH_GITLAB_CLIENT_SECRET: 'gs',
      VANGUARD_HUB_AUTH_GITLAB_ISSUER: 'https://gitlab.example.com/',
      VANGUARD_HUB_AUTH_GOOGLE_CLIENT_ID: 'only-id',
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
  async function signIn(): Promise<{ callback: Response; cookie: string }> {
    const begin = await post('/api/auth/sign-in/social', {}, JSON.stringify({ provider: 'github', callbackURL: '/', errorCallbackURL: '/sign-in' }));
    const { url } = (await begin.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const callback = await fetch(`${origin}/api/auth/callback/github?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: cookieOf(begin) } });
    return { callback, cookie: [cookieOf(begin), cookieOf(callback)].filter(Boolean).join('; ') };
  }
  const rpc = (headers: Record<string, string>): Promise<Response> => post('/rpc/list_projects', headers);

  test('team roles key on the stored provider login: a session is not the owner, the token is', async () => {
    await start(['github:octo']);
    const { cookie } = await signIn();
    const user = await identity!.sessionUser({ headers: { cookie } } as IncomingMessage);
    // The display name ("Octo Cat") is free text; the login is what the hub recorded at sign-up.
    expect(user).toMatchObject({ name: 'Octo Cat', providerLogin: 'github:Octo' });
    const role = async (headers: Record<string, string>): Promise<unknown> =>
      ((await (await post('/rpc/team_role', headers, JSON.stringify({ id: 'default' }))).json()) as { result: unknown }).result;
    await saveTeams(dir, [
      { id: 'default', name: 'Default', members: [{ login: 'octo', role: 'member' }, { login: 'Octo Cat', role: 'admin' }], repositories: [] },
    ]);
    expect(await role({ cookie })).toBe('member');
    expect(await role({ [HUB_TOKEN_HEADER]: TOKEN })).toBe('admin');
    await saveTeams(dir, [{ id: 'default', name: 'Default', members: [{ login: 'Octo Cat', role: 'admin' }], repositories: [] }]);
    expect(await role({ cookie })).toBeNull();
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

  test('a verified domain admits an account', async () => {
    await start(['@nowhere.test']);
    const { callback, cookie } = await signIn();
    expect(callback.headers.get('location')).not.toContain('error');
    expect((await rpc({ cookie })).status).toBe(200);
  });

  test('a provider profile cannot claim the owner user by e-mail', async () => {
    await start(['@hub.invalid']);
    profile = { login: 'evil', email: OWNER_EMAIL, verified: true };
    const { cookie } = await signIn();
    expect((await rpc({ cookie })).status).toBe(401);
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
