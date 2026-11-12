import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHubServer, type HubServer } from './server.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';

// Mocked GitHub API: `code` is the user's login, every user holds the token `tok-<login>`.
let calls: string[];
let githubDown = false;
let memberships: Record<string, string[]>; // login -> active orgs
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const u = String(url);
  calls.push(u);
  if (githubDown) throw new Error('github unreachable');
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status });
  if (u === 'https://github.com/login/oauth/access_token') {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return json({ access_token: `tok-${code}` });
  }
  const login = String((init?.headers as Record<string, string>).authorization).replace('Bearer tok-', '');
  if (u === 'https://api.github.com/user') return json({ login });
  const org = /\/user\/memberships\/orgs\/(.+)$/.exec(u)?.[1];
  if (org !== undefined) return memberships[login]?.includes(org) ? json({ state: 'active' }) : json({}, 404);
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

let dir: string;
let hub: HubServer;
let base: string;

async function start(allowLogins: string[], allowOrgs: string[]): Promise<void> {
  hub = createHubServer({
    uiDir: dir,
    configDir: dir,
    browseRoot: dir,
    bind: { isLoopback: false, allowAdd: false },
    deps: {} as SidecarDeps,
    github: { clientId: 'cid', clientSecret: 'sec', publicUrl: 'https://hub.example.com', allowLogins, allowOrgs, fetch: fakeFetch },
  });
  await hub.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
}

/** Runs /auth/github/login, then the callback for `login`; returns the callback response. */
async function signIn(login: string, opts: { state?: string } = {}): Promise<Response> {
  const start = await fetch(`${base}/`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
  return fetch(`${base}/auth/github/callback?code=${login}&state=${opts.state ?? state}`, {
    redirect: 'manual',
    headers: { cookie: stateCookie },
  });
}

const sessionCookie = (res: Response): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith('vanguard_hub_session=') && !c.includes('Max-Age=0'))?.split(';')[0];

const rpc = (cookie?: string, extra: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/rpc/list_projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}), ...extra },
    body: '{}',
  });

beforeEach(async () => {
  calls = [];
  githubDown = false;
  memberships = {};
  dir = await mkdtemp(join(tmpdir(), 'vanguard-hub-gh-'));
  await writeFile(join(dir, 'index.html'), '<html><head></head></html>');
});
afterEach(async () => {
  vi.useRealTimers();
  await hub.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GitHub sign-in', () => {
  test('redirects an unauthenticated browser to GitHub and answers RPC 401', async () => {
    await start(['alice'], []);
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://hub.example.com/auth/github/callback');
    expect(loc.searchParams.get('scope')).toBeNull();
    expect((await rpc()).status).toBe(401);
    expect((await fetch(`${base}/events`)).status).toBe(401);
  });

  test('asks for read:org only when an org is configured', async () => {
    await start([], ['acme']);
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(new URL(res.headers.get('location')!).searchParams.get('scope')).toBe('read:org');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  test('an allowed login gets a session cookie that authorizes RPC and shows the login', async () => {
    await start(['Alice'], []);
    const res = await signIn('alice');
    expect(res.status).toBe(302);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('vanguard_hub_session='))!;
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(setCookie).toContain('Max-Age=43200');
    const cookie = sessionCookie(res)!;
    expect((await rpc(cookie)).status).toBe(200);
    const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
    expect(await me.json()).toEqual({ login: 'alice' });
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(200);
  });

  test('a login outside the allowlist and org gets 403 and no session', async () => {
    await start(['alice'], ['acme']);
    memberships = { carol: ['other'] };
    const res = await signIn('mallory');
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeUndefined();
    expect((await signIn('carol')).status).toBe(403);
  });

  test('an active member of an allowed org is accepted', async () => {
    await start([], ['acme']);
    memberships = { bob: ['acme'] };
    const res = await signIn('bob');
    expect(res.status).toBe(302);
    expect(sessionCookie(res)).toBeDefined();
    expect(calls).toContain('https://api.github.com/user/memberships/orgs/acme');
  });

  test('a callback with a missing or wrong state is rejected before any GitHub call', async () => {
    await start(['alice'], []);
    const wrong = await signIn('alice', { state: 'nope' });
    expect(wrong.status).toBe(400);
    expect(sessionCookie(wrong)).toBeUndefined();
    const missing = await fetch(`${base}/auth/github/callback?code=alice`, { redirect: 'manual' });
    expect(missing.status).toBe(400);
    const noCookie = await fetch(`${base}/auth/github/callback?code=alice&state=abc`, { redirect: 'manual' });
    expect(noCookie.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('sign out ends the session on the server', async () => {
    await start(['alice'], []);
    const cookie = sessionCookie(await signIn('alice'))!;
    expect((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } })).status).toBe(400); // no Origin
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie, origin: base } });
    expect(out.status).toBe(200);
    // The old cookie value no longer works even if the client keeps sending it.
    expect((await rpc(cookie)).status).toBe(401);
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(401);
  });

  test('the token header still authorizes RPC', async () => {
    await start(['alice'], []);
    expect((await rpc(undefined, { 'x-vanguard-hub-token': hub.token })).status).toBe(200);
    expect((await rpc(undefined, { 'x-vanguard-hub-token': 'wrong' })).status).toBe(401);
  });
});

describe('GitHub sign-in hardening', () => {
  /** Open `/events` with `cookie`; resolves with the status once headers arrive, plus a `closed` promise. */
  function openEvents(cookie: string): Promise<{ status: number; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const req = request(`${base}/events`, { headers: { cookie } }, (res) => {
        const closed = new Promise<void>((done) => {
          res.on('close', done);
          res.on('error', () => done());
        });
        res.resume();
        resolve({ status: res.statusCode ?? 0, closed });
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('POST /events/session mints no shared cookie, and the stream dies with the session', async () => {
    await start(['alice'], []);
    const cookie = sessionCookie(await signIn('alice'))!;
    const session = await fetch(`${base}/events/session`, { method: 'POST', headers: { cookie, origin: base } });
    expect(session.status).toBe(200);
    expect(session.headers.get('set-cookie')).toBeNull();
    // A shared events cookie (as a token holder would get without GitHub sign-in) is never accepted.
    expect((await fetch(`${base}/events`, { headers: { cookie: 'vanguard_hub_events_x=y' } })).status).toBe(401);

    const stream = await openEvents(cookie);
    expect(stream.status).toBe(200);
    await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie, origin: base } });
    await stream.closed;
    expect((await fetch(`${base}/events`, { headers: { cookie } })).status).toBe(401);
  });

  test('a session expires after 12 h and ends its streams', async () => {
    await start(['alice'], []);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const cookie = sessionCookie(await signIn('alice'))!;
    const stream = await openEvents(cookie);
    expect((await rpc(cookie)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000 + 1);
    await stream.closed;
    const after = await rpc(cookie);
    expect(after.status).toBe(401);
    // Not the launch-token message: the UI reloads for sign-in instead of telling users to open a URL.
    expect(JSON.stringify(await after.json())).toContain('sign-in required');
  });

  test('unauthenticated assets get 401 and never touch the OAuth state', async () => {
    await start(['alice'], []);
    const res = await fetch(`${base}/assets/app.js`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('a self-supplied state cookie/param pair never reaches the token exchange', async () => {
    await start(['alice'], []);
    const res = await fetch(`${base}/auth/github/callback?code=alice&state=forged`, {
      redirect: 'manual',
      headers: { cookie: 'vanguard_hub_oauth_state=forged' },
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('a state is single use', async () => {
    await start(['alice'], []);
    const first = await fetch(`${base}/`, { redirect: 'manual' });
    const state = new URL(first.headers.get('location')!).searchParams.get('state')!;
    const headers = { cookie: `vanguard_hub_oauth_state=${state}` };
    expect((await fetch(`${base}/auth/github/callback?code=alice&state=${state}`, { redirect: 'manual', headers })).status).toBe(302);
    expect((await fetch(`${base}/auth/github/callback?code=alice&state=${state}`, { redirect: 'manual', headers })).status).toBe(400);
  });

  test('a GitHub API failure answers 502 and creates no session', async () => {
    await start(['alice'], []);
    const res0 = await fetch(`${base}/`, { redirect: 'manual' });
    const state = new URL(res0.headers.get('location')!).searchParams.get('state')!;
    githubDown = true;
    const res = await fetch(`${base}/auth/github/callback?code=alice&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `vanguard_hub_oauth_state=${state}` },
    });
    expect(res.status).toBe(502);
    expect(sessionCookie(res)).toBeUndefined();
  });

  test('/auth routes check the method, and the signed-out page needs no session', async () => {
    await start(['alice'], []);
    expect((await fetch(`${base}/auth/github/callback`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/auth/me`, { method: 'POST' })).status).toBe(405);
    const page = await fetch(`${base}/auth/signed-out`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
  });
});
