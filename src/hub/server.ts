// The hub's node:http entry point (spec §2.2): wires the RPC dispatcher (rpc.ts), the SSE bus
// (events.ts) and the static SPA server (static.ts) behind one listener. Same-origin only — this
// never emits Access-Control-Allow-Origin, so a page on another origin cannot read responses even
// if it can trigger the request.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { contentSecurityPolicy, serveStatic } from './static.js';
import { EventBus } from './events.js';
import { writeJson, jsonError } from './json-response.js';
import { callerRepoRoots, repoInRoots, type Caller } from './teams.js';
import { dispatchRpc, classifyError, type RpcContext } from './rpc.js';
import { AuditLog, TOKEN_ACTOR, auditActorOf, reportAuditFailure, type Actor } from './audit.js';
import { encodeError, encodeResult, HUB_EVENTS_SESSION_PATH, HUB_SIGN_IN_REQUIRED, HUB_TOKEN_HEADER, HUB_TOKEN_REJECTED } from '../hub-wire.js';
import { ProjectAllowlist, type BindOptions } from './allowlist.js';
import { WatchRegistry, type WatchOptions } from './watch.js';
import { readEnv } from '../core/env.js';
import { createCredentialService, ForbiddenError } from './credentials.js';
import { boardServed, localWorkerMemory, recordBoardPickup, sweepLocalWorkers } from './local-worker.js';
import { reconcileHubBoards, schedulerState, sweepHubBoards } from './task-scheduler.js';
import { createRunSession } from './run-session.js';
import { CompleteBusyError, CompleteRegistry, type SpawnComplete } from './complete.js';
import { loadPaths } from './projects.js';
import { notifyNewItems, type WaitingItem } from './push.js';
import { SpawnRegistry } from './spawn.js';
import { productionDeps } from '../sidecar/deps.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';
import { csrfOk, DeviceAuth, newCsrfToken, normalizeUserCode } from './device-auth.js';
import { esc, localOnlyIdentity, SIGNUP_REFUSED_MESSAGE, signInPage, type HubIdentity, type HubUser } from './auth.js';

/** How often the hub-board scheduler looks for tasks that may start. */
const SCHEDULER_INTERVAL_MS = 15_000;
const PUSH_INTERVAL_MS = 60_000;

/**
 * `write_draft_asset` ships an image's bytes as a JSON array of numbers (comma-separated decimal —
 * several times the raw byte size), so the RPC body cap must clear a few MB of raw attachment data
 * by a wide margin, not just the biggest ordinary JSON payload.
 */
export const MAX_RPC_BODY_BYTES = 32 * 1024 * 1024;

export interface HubServerOptions {
  uiDir: string;
  configDir: string;
  browseRoot: string;
  /** Lift the browse-root limit (the desktop app's own hub). Default: confined to `browseRoot`. */
  browseAnywhere?: boolean;
  /** Additional permitted clone hosts. */
  cloneHosts?: readonly string[];
  bind: BindOptions;
  /** The `--repo` seed, always allowed even before it reaches the persisted project store. */
  seedRepoPath?: string;
  watch?: WatchOptions;
  /** Expo push endpoint and pass interval; the real endpoint and a minute by default (tests point them at a fake). */
  pushUrl?: string;
  pushIntervalMs?: number;
  deps?: SidecarDeps;
  spawnComplete?: SpawnComplete;
  /** Extra permitted `Host` header values (`host[:port]`, exact match, case-insensitive) beyond the
   * default — `localhost` and any IP literal, on any port (see `hostAllowed`). This is
   * `--allowed-host` / `TASKCELL_HUB_ALLOWED_HOSTS`, for the VPS / reverse-proxy deployment
   * (docs/hub.md). */
  allowedHosts?: readonly string[];
  /** Fixed token (from `--token-file`); a fresh one per launch when omitted. */
  token?: string;
  /** Sign-in (Better Auth) and the owner user (src/hub/auth.ts). Omitted: token-only, local owner. */
  identity?: HubIdentity;
  /** GitHub logins allowed to see/change the per-user-credentials switch and the instance
   * credentials (`--admin-github-login`), matched against the signed-in user's GitHub login. */
  adminGithubLogins?: readonly string[];
  /** Hub admins by sign-in identity (`TASKCELL_HUB_ADMINS`): sign-up allowlist entry syntax. */
  hubAdmins?: readonly string[];
  /** Overrides who an authenticated request acts as. Default: the owner (token, or local mode) is the
   * shared `token` admin identity; any other signed-in user is a non-admin under their e-mail until
   * roles land (#841). */
  actorFor?: (req: IncomingMessage) => Actor;
  /** Enable the Fleet spawn commands (`spawn_run` et al). Loopback binds only — the desktop app's
   * local hub sets it; a hub reachable by others must never run arbitrary programs. */
  fleet?: boolean;
  /** `hub --demo`: the served page runs on bundled fixtures only. */
  demo?: boolean;
  /** `TASKCELL_HUB_SECRET` (base64, 32 bytes) protecting the credential store and decrypting retired `credentials.enc`; defaults to the env var. */
  hubSecret?: string;
}

export interface HubServer {
  readonly server: Server;
  readonly eventBus: EventBus;
  readonly allowlist: ProjectAllowlist;
  /** Per-launch secret `/rpc/*` and `/events` require (`/events` also accepts the events cookie
   * `POST /events/session` trades it for — see hub-wire.ts). No route serves it — not `/healthz`, not
   * the SPA: the CLI hands it to the operator's browser in the launch URL's fragment
   * (`src/cli/hub.ts`), which browsers never send to the server, and the SPA moves it into
   * sessionStorage (apps/desktop/src/transport.ts). Reaching the port is not enough to drive the
   * hub. It is not per-user authentication: it maps to the owner user, and server mode requires
   * sign-in for browsers (src/hub/auth.ts, docs/hub.md "Server mode sign-in"). */
  readonly token: string;
  /** One pass of the hub-board scheduler (it also runs on a timer). */
  sweepHubTasks(): Promise<void>;
  listen(port: number, host: string): Promise<void>;
  /** Graceful shutdown: ends every SSE client, stops project watchers, then closes the listener. */
  close(): Promise<void>;
}

/** The per-launch secrets: the token (header only, never in a URL), and the events-only cookie it
 * buys at `POST /events/session`. The cookie name carries a per-launch id so two hubs on one host
 * (cookies ignore the port) do not overwrite each other's session. */
interface HubAuth {
  token: string;
  eventsCookieName: string;
  eventsSecret: string;
  /** When a refused sign-in was last audited (epoch ms). */
  lastRefusedAuditMs: number;
  /** Pending mobile device-flow codes (src/hub/device-auth.ts). */
  device: DeviceAuth;
}

/** At most one refused-sign-in line per minute: the endpoint is unauthenticated, so an unthrottled
 * line per bad request would let anyone who can reach the port rotate real entries out of the log. */
const REFUSED_AUDIT_INTERVAL_MS = 60_000;

async function auditRefusedSignIn(ctx: RpcContext, auth: HubAuth): Promise<void> {
  const now = Date.now();
  if (now - auth.lastRefusedAuditMs < REFUSED_AUDIT_INTERVAL_MS) return;
  auth.lastRefusedAuditMs = now;
  await ctx.audit?.record({ login: 'unknown', action: 'sign-in', outcome: 'refused' }).catch(reportAuditFailure);
}

function eventsCookieOk(header: string | undefined, auth: HubAuth): boolean {
  if (header === undefined) return false;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === auth.eventsCookieName) return tokenOk(part.slice(eq + 1).trim(), auth.eventsSecret);
  }
  return false;
}

function tokenOk(candidate: string | null | undefined, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const bytes = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/** Names the fix: a named-host deployment (a reverse proxy, a container reached under its own
 * hostname) has to opt that Host in — an IP literal and loopback need no flag (docs/hub.md). */
const HOST_NOT_ALLOWED = 'Host not allowed — pass --allowed-host <host[:port]> or set TASKCELL_HUB_ALLOWED_HOSTS';

/** Split a `Host` header into hostname and port. `[::1]:7777` → `{ hostname: '::1', port: 7777 }`; a
 * missing port means 80. `undefined` for anything malformed — a bare (unbracketed) IPv6 literal or a
 * non-numeric port. Exported for `src/cli/hub.ts`, which rejects the same shapes at startup. */
export function splitHostPort(host: string): { hostname: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/.exec(host);
  if (!match) return undefined;
  const [, bracketed, bare, port] = match;
  if (bracketed === undefined ? bare === '' : isIP(bracketed) !== 6) return undefined;
  return { hostname: bracketed ?? bare!, port: port === undefined ? 80 : Number(port) };
}

/**
 * DNS rebinding works by pointing a *hostname* at this server's address, so a `Host` the browser
 * could only have produced from an IP literal it connected to directly — IPv4, or a bracketed IPv6 —
 * is safe regardless of port: `--host 0.0.0.0`, a LAN address and a Tailscale address all work with
 * no `--allowed-host` (including the URL the CLI prints and opens). `localhost` resolves to loopback
 * everywhere, so it gets the same treatment. The port is deliberately not checked against the socket
 * the hub actually bound: `docker run -p 8080:7777`, `ssh -L 8080:localhost:7777` and `kubectl
 * port-forward` all put a different port on the Host header than the one the hub listens on, and
 * none of that changes the hostname a DNS-rebinding page could have produced — the hostname check
 * alone carries the protection. Any other hostname must be opted in explicitly, matched against the
 * `Host` header exactly (case-insensitive `host[:port]`).
 */
function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  if (allowedHosts.some((allowed) => allowed.toLowerCase() === lower)) return true;
  const parsed = splitHostPort(lower);
  if (parsed === undefined) return false;
  return parsed.hostname === 'localhost' || isIP(parsed.hostname) !== 0;
}

function notFound(res: ServerResponse): void {
  jsonError(res, 404, 'not found', 'bad-request');
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  const encoded = encodeError({ message: 'method not allowed', kind: 'bad-request' }, 405);
  writeJson(res, encoded.status, encoded.body, { allow });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Same-origin check for mutating routes: the Origin header is required — every browser sends it on
 * a POST, and a script can send one itself, and so does the one non-browser RPC client, the
 * mobile app (apps/mobile `withOrigin`, which sends the hub's own origin: React Native's fetch sends none) — and must match
 * the request's own Host, or the request is cross-origin. Do not tighten this (e.g. to browser-only Origins) without
 * updating the phone app. This
 * guards against cross-site requests by host, not by scheme, so an HTTPS reverse proxy in front of
 * the hub (the VPS deployment) works with no extra configuration: the browser's `https://` Origin
 * still matches the `Host` header the hub sees, provided the proxy preserves the public Host. */
function sameOriginOk(req: IncomingMessage): boolean {
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined) return false;
  const host = req.headers.host;
  if (host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

class BodyTooLargeError extends Error {}

/**
 * Reads the full body before deciding, even once over `maxBytes` (dropping further chunks rather
 * than buffering them): destroying the socket mid-upload would race the client's own write and can
 * surface as a connection-reset instead of the 413 response. Draining to `end` lets the 413 (or any
 * other response) always reach the client cleanly.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(new BodyTooLargeError('request body too large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function respondBodyTooLarge(res: ServerResponse): void {
  const encoded = encodeError({ message: 'request body too large', kind: 'bad-request' }, 413);
  writeJson(res, encoded.status, encoded.body, { connection: 'close' }, () => res.socket?.destroy());
}

async function handleRpcRequest(ctx: RpcContext, req: IncomingMessage, res: ServerResponse, cmd: string, caller: Caller): Promise<void> {
  if (!sameOriginOk(req)) {
    jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
    return;
  }
  const contentType = singleHeader(req.headers['content-type']);
  if (contentType === undefined || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    jsonError(res, 400, 'Content-Type must be application/json', 'bad-request');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_RPC_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      respondBodyTooLarge(res);
      return;
    }
    jsonError(res, 400, 'invalid JSON body', 'bad-request');
    return;
  }

  try {
    const result = await dispatchRpc(ctx, cmd, body, caller);
    // Spec §2.3: success is `{ result }` (null for void commands); apps/desktop/src/transport.ts reads
    // `body.result`. A bare body here left the UI with `undefined` projects on first paint.
    writeJson(res, 200, encodeResult(result));
  } catch (err) {
    const classified = classifyError(err);
    const status = classified.notFound
      ? 404
      : err instanceof ForbiddenError
        ? 403
        : err instanceof CompleteBusyError
          ? 429
          : classified.kind === 'bad-request'
            ? 400
            : 500;
    jsonError(res, status, classified.message, classified.kind);
  }
}

const DEVICE_CSRF_COOKIE = 'taskcell_device_csrf';
const DEVICE_WARNING = '<p role="note"><strong>Only enter a code shown on your own phone.</strong> Someone who sends you a code is asking to sign in as you.</p>';
const MAX_FORM_BYTES = 4096;

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_FORM_BYTES) chunks.push(c);
    });
    req.on('end', () => (size > MAX_FORM_BYTES ? reject(new BodyTooLargeError('request body too large')) : resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** A typed code that can be neither reviewed nor decided: entry is locked, or the code is wrong or expired. */
function codeRefused(res: ServerResponse, why: 'locked' | 'invalid'): void {
  if (why === 'locked') return devicePage(res, 429, '<p role="alert">Too many wrong codes. Wait a few minutes and try again.</p>');
  return devicePage(res, 400, '<p role="alert">That code is not valid or has expired. Check the code on your phone.</p>');
}

function devicePage(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect a device — Taskcell Hub</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;max-width:24rem;margin:4rem auto">
<h1>Taskcell Hub</h1>${body}</body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': contentSecurityPolicy(html), ...headers });
  res.end(html);
}

const deviceError = (res: ServerResponse, status: number, error: string, description: string): void =>
  writeJson(res, status, { error, error_description: description }, { 'cache-control': 'no-store' });

const POLL_ERRORS = {
  pending: ['authorization_pending', 'Waiting for approval in the browser.'],
  slow_down: ['slow_down', 'Polling too fast: wait for the interval.'],
  expired_token: ['expired_token', 'The code expired. Start sign-in again.'],
  access_denied: ['access_denied', 'The sign-in was denied.'],
  invalid_grant: ['invalid_grant', 'Unknown or already used device code.'],
} as const;

/** The mobile device flow (RFC 8628 shape): `/api/device/{code,token,revoke,me}` for the app, `/device` for the browser. */
async function handleDevice(
  ctx: RpcContext,
  auth: HubAuth,
  identity: HubIdentity,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  baseURL: string,
  offeredToken: string | undefined,
): Promise<void> {
  if (pathname === '/device') {
    const user = await identity.sessionUser(req);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (user === undefined) {
        res.writeHead(302, { location: '/sign-in?next=device', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      // A `?user_code=` in the link is deliberately ignored: the member must type the code the phone shows.
      const csrf = newCsrfToken();
      // `Secure` when the public URL is https, like Better Auth's cookies (both follow the identity's baseURL).
      const secure = new URL(baseURL).protocol === 'https:' ? '; Secure' : '';
      devicePage(
        res,
        200,
        `<p>Signed in as ${esc(user.name)}. Type the code shown on your phone to connect it as you.</p>${DEVICE_WARNING}
<form method="post" action="/device"><input type="hidden" name="csrf" value="${csrf}">
<p><input name="user_code" autocomplete="off" autocapitalize="characters" required aria-label="Code" style="font-size:1.5rem;width:100%"></p>
<p><button name="action" value="review">Continue</button></p></form>`,
        { 'set-cookie': `${DEVICE_CSRF_COOKIE}=${csrf}; Path=/device; HttpOnly; SameSite=Strict${secure}` },
      );
      return;
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, HEAD, POST');
    if (!sameOriginOk(req)) return jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return jsonError(res, 413, 'request body too large', 'bad-request');
    }
    if (user === undefined) return devicePage(res, 401, '<p role="alert">Sign in first.</p>');
    if (!csrfOk(cookieValue(singleHeader(req.headers.cookie), DEVICE_CSRF_COOKIE), form.get('csrf') ?? undefined)) {
      return devicePage(res, 403, '<p role="alert">This form expired. Reload the page and try again.</p>');
    }
    // The sign-up allowlist is re-checked at approval, not only at sign-up.
    if ((await identity.userById(user.id)) === undefined) return devicePage(res, 403, `<p role="alert">${esc(SIGNUP_REFUSED_MESSAGE)}</p>`);
    const typed = form.get('user_code') ?? '';
    if (form.get('action') === 'review') {
      // A second look before deciding: when the phone asked, with the warning again.
      const found = auth.device.lookup(typed, user.id);
      if (typeof found === 'string') return codeRefused(res, found);
      const minutes = Math.max(0, Math.floor((Date.now() - found.requestedAt) / 60_000));
      const at = new Date(found.requestedAt).toISOString().slice(11, 16);
      const code = normalizeUserCode(typed);
      return devicePage(
        res,
        200,
        `<p>Code <strong>${code.slice(0, 4)}-${code.slice(4)}</strong> was requested ${minutes === 0 ? 'less than a minute' : `${minutes} min`} ago (${at} UTC).</p>${DEVICE_WARNING}
<form method="post" action="/device"><input type="hidden" name="csrf" value="${esc(form.get('csrf') ?? '')}"><input type="hidden" name="user_code" value="${code}">
<p><button name="action" value="approve">Approve</button> <button name="action" value="deny">Deny</button></p></form>`,
      );
    }
    const outcome = auth.device.decide(typed, user.id, form.get('action') !== 'deny');
    const actor = { login: user.email, admin: false, id: user.id, name: user.name };
    if (outcome === 'locked' || outcome === 'invalid') return codeRefused(res, outcome);
    await ctx.audit?.record({ login: actor.login, actor: auditActorOf(actor), action: 'sign-in', outcome: outcome === 'approved' ? 'ok' : 'refused' }).catch(reportAuditFailure);
    return devicePage(res, 200, outcome === 'approved' ? '<p>Approved. Return to the Taskcell app.</p>' : '<p>Denied. The phone was not connected.</p>');
  }

  if (req.method !== 'POST' && !(pathname === '/api/device/me' && req.method === 'GET')) return methodNotAllowed(res, pathname === '/api/device/me' ? 'GET, POST' : 'POST');
  if (req.method === 'POST' && !sameOriginOk(req)) return jsonError(res, 400, 'cross-origin request rejected', 'bad-request');

  if (pathname === '/api/device/code') {
    const started = auth.device.start(req.socket.remoteAddress ?? '');
    if (started === null) return deviceError(res, 429, 'slow_down', 'Too many sign-ins in progress. Try again in a few minutes.');
    // The page the member opens, on the hub's public origin; the code is typed there, never carried in the link.
    writeJson(res, 200, { ...started, verification_uri: `${baseURL}/device` }, { 'cache-control': 'no-store' });
    return;
  }

  if (pathname === '/api/device/token') {
    let body: unknown;
    try {
      body = await readJsonBody(req, MAX_FORM_BYTES);
    } catch {
      return deviceError(res, 400, 'invalid_request', 'Invalid JSON body.');
    }
    const code = (body as { device_code?: unknown } | null)?.device_code;
    if (typeof code !== 'string' || code === '') return deviceError(res, 400, 'invalid_request', 'device_code is required.');
    const polled = auth.device.poll(code);
    if (polled.status !== 'approved') {
      const [error, description] = POLL_ERRORS[polled.status];
      return deviceError(res, 400, error, description);
    }
    // Allowlist re-check at redemption: an approver removed meanwhile gets nothing.
    const token = (await identity.userById(polled.userId)) === undefined ? undefined : await identity.issueDeviceSession(polled.userId);
    if (token === undefined) return deviceError(res, 403, 'access_denied', SIGNUP_REFUSED_MESSAGE);
    writeJson(res, 200, { access_token: token, token_type: 'session' }, { 'cache-control': 'no-store' });
    return;
  }

  if (pathname === '/api/device/revoke' || pathname === '/api/device/me') {
    const user = offeredToken ? await identity.deviceSessionUser(offeredToken) : undefined;
    if (user === undefined || offeredToken === undefined) return jsonError(res, 401, HUB_TOKEN_REJECTED, 'bad-request');
    if (pathname === '/api/device/me') return writeJson(res, 200, { id: user.id, name: user.name, email: user.email }, { 'cache-control': 'no-store' });
    await identity.revokeDeviceSession(offeredToken);
    return writeJson(res, 200, { ok: true });
  }
  notFound(res);
}

async function handleRequest(
  ctx: RpcContext,
  eventBus: EventBus,
  opts: HubServerOptions,
  auth: HubAuth,
  identity: HubIdentity,
  runRepos: ReadonlyMap<string, string>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!hostAllowed(req.headers.host, opts.allowedHosts ?? [])) {
    jsonError(res, 403, HOST_NOT_ALLOWED, 'bad-request');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const pathname = url.pathname;

  const offeredToken = singleHeader(req.headers[HUB_TOKEN_HEADER]);
  const tokenValid = tokenOk(offeredToken, auth.token);
  // The token (CLI, scripts) maps to the owner; otherwise the Better Auth session (server mode only).
  // A mobile member session (device flow) rides the same header: it is a session, never the owner.
  const resolveUser = async (): Promise<HubUser | undefined> =>
    tokenValid ? identity.owner : ((await identity.sessionUser(req)) ?? (offeredToken ? identity.deviceSessionUser(offeredToken) : undefined));
  // A wrong token is audited (throttled) and is "token dead"; a server-mode request that offered none
  // is a sign-in prompt, not a refusal.
  const unauthorized = async (): Promise<void> => {
    const offered = Boolean(offeredToken);
    if (offered) await auditRefusedSignIn(ctx, auth);
    jsonError(res, 401, identity.handler !== undefined && !offered ? HUB_SIGN_IN_REQUIRED : HUB_TOKEN_REJECTED, 'bad-request');
  };
  // The owner (token, or local mode) is the shared `token` admin; other signed-in users are non-admins.
  const actorOf = (user: HubUser): Actor =>
    opts.actorFor?.(req) ?? (user.id === identity.owner.id ? TOKEN_ACTOR : { login: user.email, admin: false, id: user.id, name: user.name });

  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    // No OAuth on loopback: there the hub is one automatic owner. The app still asks who is signed in on
    // every load; "no session" (Better Auth's `null`) answers that without an error in the browser console.
    if (identity.handler === undefined) return pathname === '/api/auth/get-session' && req.method === 'GET' ? writeJson(res, 200, null) : notFound(res);
    await identity.handler(req, res);
    return;
  }

  if (pathname.startsWith('/api/device/') || pathname === '/device') {
    if (identity.handler === undefined || identity.baseURL === undefined) return notFound(res);
    await handleDevice(ctx, auth, identity, req, res, pathname, identity.baseURL, offeredToken);
    return;
  }

  if (pathname === '/sign-in') {
    if (identity.handler === undefined) return notFound(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    const html = signInPage(identity.providers, url.searchParams.get('error') ?? undefined, url.searchParams.get('next') === 'device' ? '/device' : '/');
    // The same policy as the app's pages: only this page's own inline script (by hash) may run, and nothing may frame it.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': contentSecurityPolicy(html) });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }

  if (pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    // Unauthenticated on purpose — the container HEALTHCHECK (docker/hub.Dockerfile) has no token —
    // so the body is a constant: it says the port answers, nothing about which build is behind it.
    writeJson(res, 200, { ok: true });
    return;
  }

  if (pathname === HUB_EVENTS_SESSION_PATH) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const user = await resolveUser();
    if (user === undefined) return unauthorized();
    if (!sameOriginOk(req)) {
      jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
      return;
    }
    // A sign-in is not refused for an unwritable log (that would lock everyone out): it is reported on stderr.
    const actor = actorOf(user);
    await ctx.audit?.record({ login: actor.login, actor: auditActorOf(actor), action: 'sign-in', outcome: 'ok' }).catch(reportAuditFailure);
    // A signed-in session needs no events cookie: `/events` takes the session cookie itself, so
    // sign-out or revocation ends the stream's auth. The shared secret goes to token holders only.
    if (!tokenValid) {
      writeJson(res, 200, encodeResult(null), { 'cache-control': 'no-store' });
      return;
    }
    // No `Secure`: the loopback hub is plain http. SameSite=Strict + HttpOnly + Path=/events keep it
    // off cross-site requests, out of page script, and off every other route. Max-Age (one day) lets
    // the per-launch names of past hub launches expire instead of piling up.
    const cookie = `${auth.eventsCookieName}=${auth.eventsSecret}; Path=/events; Max-Age=86400; HttpOnly; SameSite=Strict`;
    writeJson(res, 200, encodeResult(null), { 'set-cookie': cookie, 'cache-control': 'no-store' });
    return;
  }

  if (pathname === '/events') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const cookieOk = eventsCookieOk(singleHeader(req.headers.cookie), auth);
    const user = cookieOk ? undefined : await resolveUser();
    if (!cookieOk && user === undefined) return unauthorized();
    // A signed-in team member is streamed only events of a repository of their teams; token holders
    // (and the events cookie they buy) see everything.
    let visible: ((data: unknown) => boolean) | undefined;
    if (user !== undefined && !tokenValid) {
      const roots = await callerRepoRoots(ctx.configDir, { user, owner: false, hubAdmin: ctx.userCredentials?.isAdmin(user) === true });
      visible = (data) => {
        // A clone's progress names no repository yet: it goes to whoever started it.
        if ((data as { cloneBy?: unknown } | null)?.cloneBy === user.id) return true;
        const p = eventRepoPath(data, runRepos);
        return p !== undefined && repoInRoots(roots, p);
      };
    }
    eventBus.subscribe(req, res, visible);
    res.flushHeaders();
    return;
  }

  if (pathname.startsWith('/rpc/')) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const user = await resolveUser();
    if (user === undefined) return unauthorized();
    // The caller's identity rides on a per-request context: credential RPCs act on THIS user only. The
    // token holder is the owner (admin of every team); a session user is limited to their teams.
    await handleRpcRequest({ ...ctx, user, actor: actorOf(user) }, req, res, pathname.slice('/rpc/'.length), { user, owner: tokenValid, hubAdmin: !tokenValid && ctx.userCredentials?.isAdmin(user) === true });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    notFound(res);
    return;
  }

  // Pages, unlike the API, redirect: a hub bound beyond loopback requires sign-in for everything it serves.
  if (identity.handler !== undefined && (await resolveUser()) === undefined) {
    res.writeHead(302, { location: '/sign-in', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  const handled = await serveStatic({ uiDir: opts.uiDir, fleet: opts.fleet === true, demo: opts.demo === true }, req, res);
  if (!handled) notFound(res);
}

/** Most runs whose repository the `/events` filter remembers (oldest forgotten first). */
const MAX_RUN_REPOS = 1000;

/** The repository an event belongs to: a bare path (`vanguard:changed`), a `repoPath`/`path` field, or
 * — for a run event (`{ runId, event }`) — the repository its `run-queued`/`run-accepted` named. */
export function eventRepoPath(data: unknown, runRepos: ReadonlyMap<string, string>): string | undefined {
  if (typeof data === 'string') return data;
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  const p = d.repoPath ?? d.path;
  if (typeof p === 'string') return p;
  return typeof d.runId === 'string' ? runRepos.get(d.runId) : undefined;
}

/** Remember the repository a run event (`{ runId, event: { repoPath } }`) first names; bounded. */
function recordRunRepo(runRepos: Map<string, string>, payload: unknown): void {
  const run = payload as { runId?: unknown; event?: { repoPath?: unknown } } | null;
  if (typeof run?.runId !== 'string' || typeof run.event?.repoPath !== 'string' || runRepos.has(run.runId)) return;
  runRepos.set(run.runId, run.event.repoPath);
  if (runRepos.size > MAX_RUN_REPOS) runRepos.delete(runRepos.keys().next().value as string);
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

/** Build (but do not start) the hub's HTTP server. `listen`/`close` drive its lifecycle. */
export function createHubServer(opts: HubServerOptions): HubServer {
  const token = opts.token ?? randomBytes(32).toString('hex');
  const auth: HubAuth = {
    token,
    eventsCookieName: `vanguard_hub_events_${randomBytes(4).toString('hex')}`,
    eventsSecret: randomBytes(32).toString('hex'),
    lastRefusedAuditMs: 0,
    device: new DeviceAuth(),
  };
  const identity = opts.identity ?? localOnlyIdentity();
  const deps = opts.deps ?? productionDeps();
  const eventBus = new EventBus();
  eventBus.startKeepalive();
  const watchRegistry = new WatchRegistry(opts.watch);
  // runId -> repository, recorded before publishing so a run's later events (which name only the
  // runId) reach the members of that repository's teams.
  const runRepos = new Map<string, string>();
  const publish = (name: string, payload: unknown): number => {
    if (name === 'api:event') recordRunRepo(runRepos, payload);
    return eventBus.publish(name, payload);
  };
  const hubSecret = opts.hubSecret ?? readEnv('TASKCELL_HUB_SECRET');
  const userCredentials = createCredentialService(opts.configDir, opts.adminGithubLogins, hubSecret, opts.hubAdmins);
  const completeRegistry = new CompleteRegistry(opts.spawnComplete, undefined, undefined, () => userCredentials.childEnv('claude'));
  if (opts.fleet === true && !opts.bind.isLoopback) throw new Error('fleet requires a loopback bind');
  const spawnRegistry = opts.fleet === true ? new SpawnRegistry(publish) : undefined;
  const allowlist = new ProjectAllowlist(() => loadPaths(opts.configDir), opts.seedRepoPath);
  // Re-check the allowlist when a run STARTS, not only at enqueue: a queued run can wait long
  // enough for its project to be unbound.
  const runSession = createRunSession(deps, publish, async (p) => {
    await allowlist.assertAllowed(p.repoPath);
  }, join(opts.configDir, 'run-counter'));

  // The retired credentials.enc moves into the one store; a failure is reported and exposed in Settings, and the file is kept.
  const credentialsReady = userCredentials.migrateLegacy().then(() => userCredentials.instanceStatus());

  const ctx: RpcContext = {
    allowlist,
    watchRegistry,
    runSession,
    completeRegistry,
    ...(spawnRegistry !== undefined ? { spawnRegistry } : {}),
    deps,
    configDir: opts.configDir,
    browseRoot: opts.browseRoot,
    ...(opts.browseAnywhere === true ? { browseAnywhere: true } : {}),
    ...(opts.cloneHosts !== undefined ? { cloneHosts: opts.cloneHosts } : {}),
    bind: opts.bind,
    publish,
    audit: new AuditLog(opts.configDir),
    userCredentials,
  };

  // Hub-board projects: start what the scheduler allows, each task as its owner (src/hub/task-scheduler.ts).
  const scheduler = schedulerState();
  const workerMemory = localWorkerMemory();
  // The Local hub switch (src/hub/local-worker.ts): an explicit off stops a board's pick-ups; the GitHub-issue half runs in the same tick.
  const recheckCaller = callerRechecker(identity, userCredentials);
  const sweepHubTasks = async (): Promise<void> => {
    await sweepHubBoards({
      ...ctx,
      scheduler,
      served: (p) => boardServed(opts.configDir, p),
      picked: (p, ids) => recordBoardPickup(opts.configDir, p, ids),
      recheckCaller,
    });
    await sweepLocalWorkers({ configDir: opts.configDir, runSession, allowlist, userCredentials, memory: workerMemory });
  };
  const sweeper = setInterval(() => void sweepHubTasks().catch((e: unknown) => console.error(`vanguard-hub: scheduler: ${(e as Error).message}`)), SCHEDULER_INTERVAL_MS);
  sweeper.unref();
  // Push notifications: one pass a minute, a no-op until a phone registers a token (src/hub/push.ts).
  const ownerCaller: Caller = { user: identity.owner, owner: true };
  const pushAccessToken = readEnv('TASKCELL_EXPO_PUSH_TOKEN');
  const pusher = setInterval(() => void notifyNewItems({
    configDir: opts.configDir,
    listWaiting: async () => ((await dispatchRpc(ctx, 'list_needs_you_all', {}, ownerCaller)) as { items: WaitingItem[] }).items,
    callerOf: async (reg) => (reg.owner ? ownerCaller : recheckCaller({ user: { id: reg.userId, email: '', name: '' }, owner: false })),
    ...(opts.pushUrl !== undefined ? { url: opts.pushUrl } : {}),
    ...(pushAccessToken ? { accessToken: pushAccessToken } : {}),
  }).catch((e: unknown) => console.error(`vanguard-hub: push: ${(e as Error).message}`)), opts.pushIntervalMs ?? PUSH_INTERVAL_MS);
  pusher.unref();
  // No run survives a restart: a task stored as running is marked failed before the first request is served.
  const reconciled = reconcileHubBoards(opts.configDir).catch((e: unknown) => console.error(`vanguard-hub: scheduler: ${(e as Error).message}`));

  const server = createServer((req, res) => {
    void handleRequest(ctx, eventBus, opts, auth, identity, runRepos, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else jsonError(res, 500, 'internal server error', 'internal');
    });
  });

  return {
    server,
    token,
    eventBus,
    allowlist,
    sweepHubTasks,
    listen: (port, host) =>
      Promise.all([credentialsReady, reconciled]).then(() => new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      })),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        clearInterval(pusher);
        watchRegistry.closeAll();
        spawnRegistry?.killAll();
        eventBus.close();
        server.closeAllConnections();
        server.close(() => {
          identity.close();
          resolve();
        });
      }),
  };
}
