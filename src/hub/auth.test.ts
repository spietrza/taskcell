import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHubIdentity, localOnlyIdentity, OWNER_EMAIL, parsePublicUrl, parseSignupAllowlist, providersFromEnv, type HubIdentity } from './auth.js';
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

  /** `publicScheme: 'https'`: the hub sits behind an https proxy (its public URL), still reached here over http. */
  async function start(allow: string[], { publicScheme = 'http', trustProxy = false }: { publicScheme?: 'http' | 'https'; trustProxy?: boolean } = {}): Promise<void> {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    origin = `http://127.0.0.1:${port}`;
    identity = await createHubIdentity({
      configDir: dir,
      baseURL: `${publicScheme}://127.0.0.1:${port}`,
      providers: { github: { clientId: 'a', clientSecret: 'b' }, gitlab: { clientId: 'c', clientSecret: 'd', issuer: 'https://gl.test' } },
      allowlist: parseSignupAllowlist(allow),
    });
    hub = createHubServer({ uiDir: dir, configDir: dir, browseRoot: dir, bind: { isLoopback: false, allowAdd: false }, deps, identity, token: TOKEN, trustProxy });
    await hub.listen(port, '127.0.0.1');
  }

  const cookieOf = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
  const post = (path: string, headers: Record<string, string>, body = '{}'): Promise<Response> =>
    fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin, ...headers }, body });

  /** The real OAuth dance against the stubbed provider: start, then hit the callback with its state. */
  async function signIn(provider: 'github' | 'gitlab' = 'github', headers: Record<string, string> = {}): Promise<{ callback: Response; cookie: string }> {
    const begin = await post('/api/auth/sign-in/social', headers, JSON.stringify({ provider, callbackURL: '/', errorCallbackURL: '/sign-in' }));
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

  describe('device flow (mobile)', () => {
    const json = async (res: Response): Promise<Record<string, string>> => (await res.json()) as Record<string, string>;
    const begin = async (): Promise<{ device_code: string; user_code: string; verification_uri: string }> =>
      (await json(await post('/api/device/code', {}))) as never;
    const poll = (device_code: string): Promise<Response> => post('/api/device/token', {}, JSON.stringify({ device_code }));
    /** Open /device as the signed-in member, then type the code and POST the form (CSRF cookie + field). */
    async function approve(cookie: string, userCode: string, action = 'approve', opts: { csrf?: string; headers?: Record<string, string> } = {}): Promise<Response> {
      const page = await fetch(origin + '/device', { headers: { cookie }, redirect: 'manual' });
      const html = await page.text();
      const field = /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
      const csrfCookie = page.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
      return fetch(origin + '/device', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie: [cookie, csrfCookie].join('; '), ...opts.headers },
        body: new URLSearchParams({ csrf: opts.csrf ?? field, user_code: userCode, action }).toString(),
      });
    }

    test('token before approval is pending; approval yields a member session once; it authorises RPC as the member and can be revoked', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      expect(d.verification_uri).toBe(origin + '/device');
      expect(d.user_code).toMatch(/^[A-Z]{8}$/);
      const pending = await poll(d.device_code);
      expect(pending.status).toBe(400);
      expect(await json(pending)).toMatchObject({ error: 'authorization_pending' });
      const ok = await approve(cookie, d.user_code.slice(0, 4).toLowerCase() + '-' + d.user_code.slice(4));
      expect(ok.status).toBe(200);
      const granted = await poll(d.device_code);
      expect(granted.status).toBe(200);
      const { access_token } = await json(granted);
      // Single use: the same device_code is refused now.
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'invalid_grant' });
      const h = { [HUB_TOKEN_HEADER]: access_token! };
      expect((await rpc(h)).status).toBe(200);
      const me = await json(await fetch(origin + '/api/device/me', { headers: h }));
      expect(me.email).toBe('octo@nowhere.test');
      expect(me.id).not.toBe(identity!.owner.id);
      // A member session is not the owner: it is not the events-cookie token.
      expect((await post('/events/session', h)).headers.get('set-cookie')).toBeNull();
      expect((await post('/api/device/revoke', h)).status).toBe(200);
      expect((await rpc(h)).status).toBe(401);
      expect((await fetch(origin + '/api/device/me', { headers: h })).status).toBe(401);
    });

    test('behind an https public URL the verification page is https and the CSRF cookie is Secure; over http it is not', async () => {
      await start(['github:octo'], { publicScheme: 'https' });
      const { cookie } = await signIn('github', { origin: origin.replace('http:', 'https:') });
      expect((await begin()).verification_uri).toBe(origin.replace('http:', 'https:') + '/device');
      const secureCsrf = (await fetch(origin + '/device', { headers: { cookie }, redirect: 'manual' })).headers.get('set-cookie') ?? '';
      expect(secureCsrf).toMatch(/^taskcell_device_csrf=.*; Secure/);
      await hub!.close();
      await start(['github:octo']);
      const plain = await signIn();
      const page = await fetch(origin + '/device', { headers: { cookie: plain.cookie }, redirect: 'manual' });
      expect(page.headers.get('set-cookie')).toMatch(/^taskcell_device_csrf=/);
      expect(page.headers.get('set-cookie')).not.toContain('Secure');
    });

    test('the page warns to enter only your own code, and the review step shows when the code was requested', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      const page = await fetch(origin + '/device', { headers: { cookie } });
      const pageHtml = await page.text();
      expect(pageHtml).toContain('Only enter a code shown on your own phone');
      const both = [cookie, page.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ')].join('; ');
      const send = (fields: Record<string, string>): Promise<Response> =>
        fetch(origin + '/device', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie: both }, body: new URLSearchParams(fields).toString() });
      const review = await send({ csrf: /name="csrf" value="([0-9a-f]+)"/.exec(pageHtml)![1]!, user_code: d.user_code.toLowerCase(), action: 'review' });
      expect(review.status).toBe(200);
      const html = await review.text();
      expect(html).toContain(`${d.user_code.slice(0, 4)}-${d.user_code.slice(4)}`);
      expect(html).toMatch(/was requested less than a minute ago \(\d\d:\d\d UTC\)/);
      expect(html).toContain('Only enter a code shown on your own phone');
      // Reviewing decides nothing; the review form's own fields approve.
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'authorization_pending' });
      const field = (name: string): string => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
      expect((await send({ csrf: field('csrf'), user_code: field('user_code'), action: 'approve' })).status).toBe(200);
      expect((await poll(d.device_code)).status).toBe(200);
      expect((await approve(cookie, 'BBBBBBBB', 'review')).status).toBe(400);
    });

    test('Better Auth list-sessions is disabled: page script cannot read the device sessions\' tokens', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      await approve(cookie, d.user_code);
      const { access_token } = await json(await poll(d.device_code));
      expect(access_token).toMatch(/^tcd_/);
      const res = await fetch(origin + '/api/auth/list-sessions', { headers: { cookie, origin } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(access_token!);
    });

    test('a wrong or expired device_code is refused', async () => {
      await start(['github:octo']);
      expect(await json(await poll('nope'))).toMatchObject({ error: 'invalid_grant' });
      expect((await post('/api/device/token', {}, '{}')).status).toBe(400);
    });

    test('a denied code is refused to the app', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      expect((await approve(cookie, d.user_code, 'deny')).status).toBe(200);
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'access_denied' });
    });

    test('a non-allowlisted account cannot approve, and the phone gets nothing', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      // The operator narrows the allowlist after the member signed in.
      await hub!.close();
      identity = await createHubIdentity({ configDir: dir, baseURL: origin, providers: { github: { clientId: 'a', clientSecret: 'b' } }, allowlist: parseSignupAllowlist(['someone@else.test']) });
      hub = createHubServer({ uiDir: dir, configDir: dir, browseRoot: dir, bind: { isLoopback: false, allowAdd: false }, deps, identity, token: TOKEN });
      await hub.listen(Number(new URL(origin).port), '127.0.0.1');
      const d2 = await begin();
      const refused = await approve(cookie, d2.user_code);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain('Sign-up is not open');
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'invalid_grant' }); // the restart dropped it
      expect(await json(await poll(d2.device_code))).toMatchObject({ error: 'authorization_pending' });
    });

    test('an account that never made it past the allowlist has no session to approve with', async () => {
      await start(['someone@else.test']);
      const { cookie } = await signIn();
      const d = await begin();
      const res = await fetch(origin + '/device', { headers: { cookie }, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/sign-in?next=device');
      expect((await approve(cookie, d.user_code)).status).toBe(401);
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'authorization_pending' });
    });

    test('a ?user_code= link neither prefills nor approves; approval needs the CSRF field and a same-origin POST', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      const page = await fetch(`${origin}/device?user_code=${d.user_code}`, { headers: { cookie } });
      expect(await page.text()).not.toContain(d.user_code);
      expect(await json(await poll(d.device_code))).toMatchObject({ error: expect.stringMatching(/authorization_pending|slow_down/) });
      expect((await fetch(`${origin}/device?user_code=${d.user_code}&action=approve`, { headers: { cookie } })).status).toBe(200);
      expect(await json(await poll(d.device_code))).toMatchObject({ error: expect.stringMatching(/authorization_pending|slow_down/) });
      expect((await approve(cookie, d.user_code, 'approve', { csrf: 'f'.repeat(48) })).status).toBe(403);
      expect((await approve(cookie, d.user_code, 'approve', { headers: { origin: 'https://evil.test' } })).status).toBe(400);
      expect(await json(await poll(d.device_code))).toMatchObject({ error: expect.stringMatching(/authorization_pending|slow_down/) });
      expect((await approve(cookie, d.user_code)).status).toBe(200);
    });

    test('user_code entry is rate-limited per approver: the right code is refused after too many wrong ones', async () => {
      await start(['github:octo']);
      const { cookie } = await signIn();
      const d = await begin();
      for (let i = 0; i < 5; i++) expect((await approve(cookie, 'BBBBBBBB')).status).toBe(400);
      expect((await approve(cookie, 'BBBBBBBB')).status).toBe(429);
      expect((await approve(cookie, d.user_code)).status).toBe(429);
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'authorization_pending' });
    });

    test('code and token steps refuse browser fetch metadata; the native app (none) works', async () => {
      await start(['github:octo']);
      for (const h of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' }]) {
        expect((await post('/api/device/code', h)).status).toBe(403);
        expect((await post('/api/device/token', h, JSON.stringify({ device_code: 'x' }))).status).toBe(403);
      }
      const d = await begin();
      expect(await json(await poll(d.device_code))).toMatchObject({ error: 'authorization_pending' });
    });

    test('HEAD /device sends the sign-in redirect without a body; an oversized form is 413', async () => {
      await start(['github:octo']);
      const head = await fetch(origin + '/device', { method: 'HEAD', redirect: 'manual' });
      expect(head.status).toBe(302);
      expect(head.headers.get('location')).toBe('/sign-in?next=device');
      const { cookie } = await signIn();
      const big = await fetch(origin + '/device', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie },
        body: 'x='.padEnd(5000, 'a'),
      });
      expect(big.status).toBe(413);
    });

    test('with trustProxy the code cap counts the forwarded client, not the proxy', async () => {
      await start(['github:octo'], { trustProxy: true });
      for (let i = 0; i < 20; i++) expect((await post('/api/device/code', { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200);
      expect((await post('/api/device/code', { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429);
      expect((await post('/api/device/code', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200);
    });

    test('without trustProxy a forwarded header is ignored: one shared address', async () => {
      await start(['github:octo']);
      for (let i = 0; i < 20; i++) expect((await post('/api/device/code', { 'x-forwarded-for': `203.0.113.${i}` })).status).toBe(200);
      expect((await post('/api/device/code', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(429);
    });

    test('the code endpoint needs a same-origin POST, and a browser session token is no bearer', async () => {
      await start(['github:octo']);
      expect((await fetch(origin + '/api/device/code', { method: 'POST' })).status).toBe(400);
      const { cookie } = await signIn();
      const raw = new DatabaseSync(join(dir, 'auth.sqlite'));
      try {
        const { token } = raw.prepare('SELECT token FROM session LIMIT 1').get() as { token: string };
        expect((await rpc({ [HUB_TOKEN_HEADER]: token })).status).toBe(401);
        expect(cookie).not.toContain(token + ';');
      } finally {
        raw.close();
      }
    });
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
