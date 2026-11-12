// GitHub sign-in for a non-loopback hub (opt-in): an OAuth App web flow that gates the SPA, `/rpc/*` and
// `/events` behind a session cookie, next to the launch-token header (which keeps working for scripts and
// the CLI). The user's GitHub token is used once, at sign-in, to read the login and check org membership;
// it is never stored and never used for runs. Sessions are in memory, so a restart signs everyone out.
// The allowlist matches the GitHub login, which GitHub lets a user rename and later reuse (docs/hub.md).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonError, writeJson } from './json-response.js';
import { HUB_SIGN_IN_REQUIRED } from '../hub-wire.js';

const CALLBACK_PATH = '/auth/github/callback';
const SIGNED_OUT_PATH = '/auth/signed-out';
const SESSION_COOKIE = 'vanguard_hub_session';
const STATE_COOKIE = 'vanguard_hub_oauth_state';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface GithubAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Public https origin of the hub (`--public-url`, no trailing slash); the callback is
   * `<publicUrl>/auth/github/callback`. */
  publicUrl: string;
  allowLogins: readonly string[];
  allowOrgs: readonly string[];
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface GithubAuth {
  /** The signed-in login for this request's session cookie, if any. */
  sessionLogin(req: IncomingMessage): string | undefined;
  /** Ends the session streams started with `trackStream` when the session ends (logout or expiry). */
  trackStream(req: IncomingMessage, res: ServerResponse): void;
  /** Handles `/auth/*`; false when the path is not one of them. */
  handle(pathname: string, req: IncomingMessage, res: ServerResponse, sameOriginOk: boolean): Promise<boolean>;
  /** An unauthenticated request: a page navigation goes to GitHub sign-in, anything else (an asset, a
   * non-GET) is a 401 — so a stray request never replaces the state of a sign-in in flight. */
  rejectUnauthenticated(req: IncomingMessage, res: ServerResponse, pathname: string): void;
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Constant-time string comparison. */
export function tokenOk(candidate: string | null | undefined, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const bytes = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

function cookie(name: string, value: string, path: string, maxAgeS: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}, type = 'text/plain'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const SIGNED_OUT_PAGE = '<!doctype html><title>Signed out</title><p>You are signed out. <a href="/">Sign in again</a></p>';

export function createGithubAuth(opts: GithubAuthOptions): GithubAuth {
  const doFetch = opts.fetch ?? fetch;
  const sessions = new Map<string, { login: string; streams: Set<ServerResponse> }>();
  const pendingStates = new Map<string, number>(); // state -> expiry; single use
  const logins = new Set(opts.allowLogins.map((l) => l.toLowerCase()));
  const redirectUri = `${opts.publicUrl}${CALLBACK_PATH}`;

  const sessionId = (req: IncomingMessage): string | undefined => cookieValue(req.headers.cookie, SESSION_COOKIE);
  const sessionLogin = (req: IncomingMessage): string | undefined => {
    const id = sessionId(req);
    return id === undefined ? undefined : sessions.get(id)?.login;
  };

  function endSession(id: string): void {
    const s = sessions.get(id);
    if (s === undefined) return;
    sessions.delete(id);
    for (const res of s.streams) res.destroy();
  }

  const redirectToLogin = (res: ServerResponse): void => {
    const now = Date.now();
    for (const [s, expires] of pendingStates) if (expires <= now) pendingStates.delete(s);
    if (pendingStates.size >= MAX_PENDING_STATES) pendingStates.delete(pendingStates.keys().next().value!);
    const state = randomBytes(16).toString('hex');
    pendingStates.set(state, now + STATE_TTL_MS);
    const params = new URLSearchParams({ client_id: opts.clientId, redirect_uri: redirectUri, state });
    // read:org only when an org is configured; a login allowlist needs no scope at all.
    if (opts.allowOrgs.length > 0) params.set('scope', 'read:org');
    res.writeHead(302, {
      location: `https://github.com/login/oauth/authorize?${params.toString()}`,
      'set-cookie': cookie(STATE_COOKIE, state, CALLBACK_PATH, STATE_TTL_MS / 1000),
      'cache-control': 'no-store',
    });
    res.end();
  };

  const gh = async (url: string, init: RequestInit): Promise<Response> =>
    doFetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'vanguard-hub', ...init.headers },
    });

  /** The token's login, and whether it may sign in. The token lives only in this call. */
  async function authorize(code: string): Promise<{ login: string; allowed: boolean } | undefined> {
    const tokenRes = await gh('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) return undefined;
    const accessToken = ((await tokenRes.json()) as { access_token?: unknown }).access_token;
    if (typeof accessToken !== 'string' || accessToken === '') return undefined;
    const auth = { authorization: `Bearer ${accessToken}` };
    const userRes = await gh('https://api.github.com/user', { headers: auth });
    if (!userRes.ok) return undefined;
    const login = ((await userRes.json()) as { login?: unknown }).login;
    if (typeof login !== 'string' || login === '') return undefined;
    if (logins.has(login.toLowerCase())) return { login, allowed: true };
    for (const org of opts.allowOrgs) {
      const m = await gh(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: auth });
      if (m.ok && ((await m.json()) as { state?: unknown }).state === 'active') return { login, allowed: true };
    }
    return { login, allowed: false };
  }

  async function callback(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clearState = cookie(STATE_COOKIE, '', CALLBACK_PATH, 0);
    const state = url.searchParams.get('state');
    const expected = cookieValue(req.headers.cookie, STATE_COOKIE);
    // The state must be one this hub issued (single use) and match the cookie of the browser that began
    // the flow; a self-supplied cookie/param pair never reaches the token exchange.
    const expires = state === null ? undefined : pendingStates.get(state);
    if (state !== null) pendingStates.delete(state);
    if (state === null || expected === undefined || !tokenOk(state, expected) || expires === undefined || expires <= Date.now()) {
      send(res, 400, 'Sign-in rejected: missing or invalid state. Start again from the hub.', { 'set-cookie': clearState });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      send(res, 400, 'Sign-in rejected: GitHub returned no code.', { 'set-cookie': clearState });
      return;
    }
    let result: Awaited<ReturnType<typeof authorize>>;
    try {
      result = await authorize(code);
    } catch {
      result = undefined;
    }
    if (result === undefined) {
      send(res, 502, 'Sign-in failed: could not verify your GitHub account.', { 'set-cookie': clearState });
      return;
    }
    if (!result.allowed) {
      send(res, 403, `GitHub user ${result.login} is not allowed to use this hub.`, { 'set-cookie': clearState });
      return;
    }
    const id = randomBytes(32).toString('hex');
    sessions.set(id, { login: result.login, streams: new Set() });
    setTimeout(() => endSession(id), SESSION_TTL_MS).unref();
    res.writeHead(302, {
      location: '/',
      'set-cookie': [clearState, cookie(SESSION_COOKIE, id, '/', SESSION_TTL_MS / 1000)],
      'cache-control': 'no-store',
    });
    res.end();
  }

  return {
    sessionLogin,
    trackStream(req, res) {
      const id = sessionId(req);
      if (id === undefined) return;
      sessions.get(id)?.streams.add(res);
      res.on('close', () => sessions.get(id)?.streams.delete(res));
    },
    rejectUnauthenticated(req, res, pathname) {
      if ((req.method === 'GET' || req.method === 'HEAD') && extname(pathname) === '') redirectToLogin(res);
      else jsonError(res, 401, HUB_SIGN_IN_REQUIRED, 'bad-request');
    },
    async handle(pathname, req, res, sameOriginOk) {
      const get = req.method === 'GET' || req.method === 'HEAD';
      const notAllowed = (allow: string): void => writeJson(res, 405, { error: { message: 'method not allowed', kind: 'bad-request' } }, { allow });
      if (pathname === CALLBACK_PATH) {
        if (!get) notAllowed('GET, HEAD');
        else await callback(new URL(req.url ?? '/', 'http://hub.local'), req, res);
      } else if (pathname === '/auth/me') {
        const login = sessionLogin(req);
        if (!get) notAllowed('GET, HEAD');
        else if (login === undefined) jsonError(res, 401, HUB_SIGN_IN_REQUIRED, 'bad-request');
        else writeJson(res, 200, { login }, { 'cache-control': 'no-store' });
      } else if (pathname === SIGNED_OUT_PATH) {
        if (!get) notAllowed('GET, HEAD');
        else send(res, 200, SIGNED_OUT_PAGE, {}, 'text/html');
      } else if (pathname === '/auth/logout') {
        if (req.method !== 'POST') {
          notAllowed('POST');
        } else if (!sameOriginOk) {
          jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
        } else {
          const id = sessionId(req);
          if (id !== undefined) endSession(id);
          writeJson(res, 200, { ok: true }, { 'set-cookie': cookie(SESSION_COOKIE, '', '/', 0), 'cache-control': 'no-store' });
        }
      } else {
        return false;
      }
      return true;
    },
  };
}
