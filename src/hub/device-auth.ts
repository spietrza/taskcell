// Device authorization (RFC 8628 shape) for the mobile app: the app holds a secret `device_code` and shows a
// short `user_code`; a member signs in in the browser, TYPES the code on /device and approves with a CSRF POST;
// the app's poll then receives a hub session. Nothing here rides a custom-scheme redirect. State is in memory:
// a hub restart simply invalidates pending codes. Docs: docs/hub.md "Mobile sign-in (device flow)".
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HUB_TOKEN_REJECTED } from '../hub-wire.js';
import { auditActorOf, reportAuditFailure } from './audit.js';
import { esc, SIGNUP_REFUSED_MESSAGE, type HubIdentity } from './auth.js';
import { BodyTooLargeError, methodNotAllowed, readJsonBody, sameOriginOk, singleHeader } from './http-util.js';
import { jsonError, writeJson } from './json-response.js';
import type { RpcContext } from './rpc.js';
import { contentSecurityPolicy } from './static.js';

/** A code lives at most this long (RFC 8628 `expires_in`). */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** Minimum seconds between polls of one device code; faster polling is told `slow_down`. */
export const DEVICE_POLL_INTERVAL_S = 5;
/** Pending codes held at once: `POST /api/device/code` is unauthenticated, so it is bounded. */
export const MAX_PENDING_CODES = 200;
/** Pending codes one client address may hold at once (IPv6 counted per /64). Behind a reverse proxy this needs the hub's trust-proxy setting, else every client shares the proxy's address. */
export const MAX_PENDING_CODES_PER_IP = 20;
/** Wrong `user_code` entries one approver may make per window before their code entry is locked. */
export const MAX_USER_CODE_FAILURES = 5;
export const USER_CODE_WINDOW_MS = 10 * 60_000;

// No vowels or look-alikes: a typed code cannot spell a word or be misread (20^8 ≈ 2.6e10 codes).
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

interface Entry {
  userCode: string;
  expiresAt: number;
  lastPollMs: number;
  ip: string;
  userId?: string;
  denied?: boolean;
}

export type DevicePoll =
  | { status: 'pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant' }
  | { status: 'approved'; userId: string };

export type DeviceApproval = 'approved' | 'denied' | 'invalid' | 'locked';
/** A typed code checked before deciding: when it was requested (epoch ms), or why it cannot be decided. */
export type DeviceLookup = { requestedAt: number } | 'invalid' | 'locked';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
/** `bcdf-ghjk` / `BCDFGHJK` → `BCDFGHJK`. */
export const normalizeUserCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z]/g, '');

/** The per-client key for the code cap: an IPv4 address as is, an IPv6 address reduced to its /64. */
export function clientKey(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4 !== undefined) return v4;
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const groups = head === '' ? [] : head.split(':');
  if (tail === undefined) return groups.slice(0, 4).join(':');
  return [...groups, '0', '0', '0', '0'].slice(0, 4).join(':');
}

export class DeviceAuth {
  private readonly byDevice = new Map<string, Entry>(); // sha256(device_code) -> entry
  private readonly byUser = new Map<string, string>(); // user_code -> sha256(device_code)
  private readonly failures = new Map<string, number[]>(); // approver id -> failure timestamps

  constructor(private readonly now: () => number = Date.now) {}

  /** Null when too many codes are pending, in total or from `ip` (the caller answers 429). */
  start(ip = ''): { device_code: string; user_code: string; expires_in: number; interval: number } | null {
    this.sweep();
    if (this.byDevice.size >= MAX_PENDING_CODES) return null;
    const addr = clientKey(ip);
    let fromIp = 0;
    for (const e of this.byDevice.values()) if (e.ip === addr) fromIp++;
    if (fromIp >= MAX_PENDING_CODES_PER_IP) return null;
    let userCode: string;
    do userCode = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    while (this.byUser.has(userCode));
    const deviceCode = randomBytes(32).toString('hex');
    const key = hash(deviceCode);
    this.byDevice.set(key, { userCode, expiresAt: this.now() + DEVICE_CODE_TTL_MS, lastPollMs: 0, ip: addr });
    this.byUser.set(userCode, key);
    return { device_code: deviceCode, user_code: userCode, expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
  }

  /** The app's poll. An approved code is consumed here: it can be redeemed once. */
  poll(deviceCode: string): DevicePoll {
    const key = hash(deviceCode);
    const entry = this.byDevice.get(key);
    if (entry === undefined) return { status: 'invalid_grant' };
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.drop(key, entry);
      return { status: 'expired_token' };
    }
    if (entry.denied === true) {
      this.drop(key, entry);
      return { status: 'access_denied' };
    }
    if (entry.userId !== undefined) {
      this.drop(key, entry);
      return { status: 'approved', userId: entry.userId };
    }
    const tooFast = entry.lastPollMs !== 0 && now - entry.lastPollMs < DEVICE_POLL_INTERVAL_S * 1000;
    entry.lastPollMs = now;
    return { status: tooFast ? 'slow_down' : 'pending' };
  }

  /** The approver typed `rawUserCode` and reviews it before deciding. A wrong entry counts against the approver. */
  lookup(rawUserCode: string, approverId: string): DeviceLookup {
    const found = this.find(rawUserCode, approverId);
    return typeof found === 'string' ? found : { requestedAt: found.entry.expiresAt - DEVICE_CODE_TTL_MS };
  }

  /** The approver typed `rawUserCode`. Wrong entries count against that approver only: one member cannot lock out the others. */
  decide(rawUserCode: string, approverId: string, approve: boolean): DeviceApproval {
    const found = this.find(rawUserCode, approverId);
    if (typeof found === 'string') return found;
    this.byUser.delete(found.typed);
    if (approve) found.entry.userId = approverId;
    else found.entry.denied = true;
    return approve ? 'approved' : 'denied';
  }

  private find(rawUserCode: string, approverId: string): { typed: string; entry: Entry } | 'invalid' | 'locked' {
    const now = this.now();
    const mine = (this.failures.get(approverId) ?? []).filter((t) => now - t < USER_CODE_WINDOW_MS);
    if (mine.length >= MAX_USER_CODE_FAILURES) return 'locked';
    const typed = normalizeUserCode(rawUserCode);
    const key = this.byUser.get(typed);
    const entry = key === undefined ? undefined : this.byDevice.get(key);
    // Already approved/denied codes count as unknown: a user_code decides once.
    if (key === undefined || entry === undefined || entry.expiresAt <= now || entry.userId !== undefined || entry.denied === true) {
      mine.push(now);
      this.failures.set(approverId, mine);
      return 'invalid';
    }
    return { typed, entry };
  }

  private drop(key: string, entry: Entry): void {
    this.byDevice.delete(key);
    this.byUser.delete(entry.userCode);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, e] of this.byDevice) if (e.expiresAt <= now) this.drop(key, e);
    for (const [id, ts] of this.failures) if (ts.every((t) => now - t >= USER_CODE_WINDOW_MS)) this.failures.delete(id);
  }
}

/** CSRF token for the verification page: the same random value in an HttpOnly cookie and a hidden field. */
export const newCsrfToken = (): string => randomBytes(24).toString('hex');
export function csrfOk(cookie: string | undefined, field: string | undefined): boolean {
  if (!cookie || !field) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(field);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- HTTP: `/api/device/*` for the app, `/device` for the browser (server.ts only routes the prefix here) ---

/** What the routes need of the hub's auth state: the code store and whether to trust `X-Forwarded-For`. */
export interface DeviceRouteAuth {
  device: DeviceAuth;
  trustProxy: boolean;
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

/** The client's address: the last `X-Forwarded-For` entry (the one the trusted proxy appended) when a proxy is trusted. */
function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const last = singleHeader(req.headers['x-forwarded-for'])?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? '';
}

/** The mobile device flow (RFC 8628 shape): `/api/device/{code,token,revoke,me}` for the app, `/device` for the browser. */
export async function handleDevice(
  ctx: RpcContext,
  auth: DeviceRouteAuth,
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
  // Only the native app runs the code/token steps: a browser always attaches `Sec-Fetch-Site` (Node's fetch sends only `Sec-Fetch-Mode: cors`, so that alone is no browser signal), so page script
  // on the hub origin cannot mint a `tcd_` bearer.
  if ((pathname === '/api/device/code' || pathname === '/api/device/token') && (req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] === 'navigate')) {
    return jsonError(res, 403, 'the device flow is for the native app, not a browser', 'bad-request');
  }

  if (pathname === '/api/device/code') {
    const started = auth.device.start(clientAddress(req, auth.trustProxy));
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
  jsonError(res, 404, 'not found', 'bad-request');
}
