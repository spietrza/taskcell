// The hub's node:http entry point (spec §2.2): wires the RPC dispatcher (rpc.ts), the SSE bus
// (events.ts) and the static SPA server (static.ts) behind one listener. Same-origin only — this
// never emits Access-Control-Allow-Origin, so a page on another origin cannot read responses even
// if it can trigger the request.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { serveStatic } from './static.js';
import { EventBus } from './events.js';
import { writeJson, jsonError } from './json-response.js';
import { CredentialStore } from './credentials.js';
import { callerRepoRoots, repoInRoots, type Caller } from './teams.js';
import { dispatchRpc, classifyError, type RpcContext } from './rpc.js';
import { encodeError, encodeResult, HUB_EVENTS_SESSION_PATH, HUB_SIGN_IN_REQUIRED, HUB_TOKEN_HEADER, HUB_TOKEN_REJECTED } from '../hub-wire.js';
import { ProjectAllowlist, type BindOptions } from './allowlist.js';
import { WatchRegistry, type WatchOptions } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteBusyError, CompleteRegistry, type SpawnComplete } from './complete.js';
import { loadPaths } from './projects.js';
import { SpawnRegistry } from './spawn.js';
import { productionDeps } from '../sidecar/deps.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';
import { localOnlyIdentity, signInPage, type HubIdentity, type HubUser } from './auth.js';

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
  /** Additional permitted clone hosts. */
  cloneHosts?: readonly string[];
  bind: BindOptions;
  /** The `--repo` seed, always allowed even before it reaches the persisted project store. */
  seedRepoPath?: string;
  watch?: WatchOptions;
  deps?: SidecarDeps;
  spawnComplete?: SpawnComplete;
  /** Extra permitted `Host` header values (`host[:port]`, exact match, case-insensitive) beyond the
   * default — `localhost` and any IP literal, on any port (see `hostAllowed`). This is
   * `--allowed-host` / `VANGUARD_HUB_ALLOWED_HOSTS`, for the VPS / reverse-proxy deployment
   * (docs/hub.md). */
  allowedHosts?: readonly string[];
  /** Fixed token (from `--token-file`); a fresh one per launch when omitted. */
  token?: string;
  /** Sign-in (Better Auth) and the owner user (src/hub/auth.ts). Omitted: token-only, local owner. */
  identity?: HubIdentity;
  /** Enable the Fleet spawn commands (`spawn_run` et al). Loopback binds only — the desktop app's
   * local hub sets it; a hub reachable by others must never run arbitrary programs. */
  fleet?: boolean;
  /** `VANGUARD_HUB_SECRET` (base64, 32 bytes) keying the credential store; defaults to the env var. */
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
const HOST_NOT_ALLOWED = 'Host not allowed — pass --allowed-host <host[:port]> or set VANGUARD_HUB_ALLOWED_HOSTS';

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
 * a POST, and the hub has no non-browser RPC client (a script can send one itself) — and must match
 * the request's own Host, or the request is cross-origin. This
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
      : err instanceof CompleteBusyError
        ? 429
        : classified.kind === 'bad-request'
          ? 400
          : 500;
    jsonError(res, status, classified.message, classified.kind);
  }
}

async function handleRequest(
  ctx: RpcContext,
  eventBus: EventBus,
  opts: HubServerOptions,
  auth: HubAuth,
  identity: HubIdentity,
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
  const resolveUser = async (): Promise<HubUser | undefined> => (tokenValid ? identity.owner : identity.sessionUser(req));
  // A server-mode request that offered no token and has no session is "sign in", not "token dead".
  const unauthorized = (): void =>
    jsonError(res, 401, identity.handler !== undefined && !offeredToken ? HUB_SIGN_IN_REQUIRED : HUB_TOKEN_REJECTED, 'bad-request');

  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    // No OAuth on loopback: there the hub is one automatic owner.
    if (identity.handler === undefined) return notFound(res);
    await identity.handler(req, res);
    return;
  }

  if (pathname === '/sign-in') {
    if (identity.handler === undefined) return notFound(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    const html = signInPage(identity.providers, url.searchParams.get('error') ?? undefined);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
    if ((await resolveUser()) === undefined) return unauthorized();
    if (!sameOriginOk(req)) {
      jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
      return;
    }
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
    // A signed-in team member is streamed only events naming a repository (`repoPath`/`path`) of their
    // teams; token holders (and the events cookie they buy) see everything.
    let visible: ((data: unknown) => boolean) | undefined;
    if (user !== undefined && !tokenValid) {
      const roots = await callerRepoRoots(ctx.configDir, { user, owner: false });
      visible = (data) => {
        const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
        const p = d.repoPath ?? d.path;
        return typeof p === 'string' && repoInRoots(roots, p);
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
    // The token holder is the owner (admin of every team); a session user is limited to their teams.
    await handleRpcRequest(ctx, req, res, pathname.slice('/rpc/'.length), { user, owner: tokenValid });
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

  const handled = await serveStatic({ uiDir: opts.uiDir, fleet: opts.fleet === true }, req, res);
  if (!handled) notFound(res);
}

/** Build (but do not start) the hub's HTTP server. `listen`/`close` drive its lifecycle. */
export function createHubServer(opts: HubServerOptions): HubServer {
  const token = opts.token ?? randomBytes(32).toString('hex');
  const auth: HubAuth = {
    token,
    eventsCookieName: `vanguard_hub_events_${randomBytes(4).toString('hex')}`,
    eventsSecret: randomBytes(32).toString('hex'),
  };
  const identity = opts.identity ?? localOnlyIdentity();
  const deps = opts.deps ?? productionDeps();
  const eventBus = new EventBus();
  eventBus.startKeepalive();
  const watchRegistry = new WatchRegistry(opts.watch);
  const publish = (name: string, payload: unknown): number => eventBus.publish(name, payload);
  const completeRegistry = new CompleteRegistry(opts.spawnComplete);
  if (opts.fleet === true && !opts.bind.isLoopback) throw new Error('fleet requires a loopback bind');
  const spawnRegistry = opts.fleet === true ? new SpawnRegistry(publish) : undefined;
  const allowlist = new ProjectAllowlist(() => loadPaths(opts.configDir), opts.seedRepoPath);
  // Re-check the allowlist when a run STARTS, not only at enqueue: a queued run can wait long
  // enough for its project to be unbound.
  const runSession = createRunSession(deps, publish, async (p) => {
    await allowlist.assertAllowed(p.repoPath);
  });

  const credentials = new CredentialStore(opts.configDir, opts.hubSecret);
  // An unreadable store (wrong secret) is reported in Settings and on stderr; runs keep the env credentials.
  const credentialsReady = credentials.applyStored().catch((e: unknown) => console.error(`vanguard-hub: ${(e as Error).message}`));

  const ctx: RpcContext = {
    credentials,
    allowlist,
    watchRegistry,
    runSession,
    completeRegistry,
    ...(spawnRegistry !== undefined ? { spawnRegistry } : {}),
    deps,
    configDir: opts.configDir,
    browseRoot: opts.browseRoot,
    ...(opts.cloneHosts !== undefined ? { cloneHosts: opts.cloneHosts } : {}),
    bind: opts.bind,
    publish,
  };

  const server = createServer((req, res) => {
    void handleRequest(ctx, eventBus, opts, auth, identity, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else jsonError(res, 500, 'internal server error', 'internal');
    });
  });

  return {
    server,
    token,
    eventBus,
    allowlist,
    listen: (port, host) =>
      credentialsReady.then(() => new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      })),
    close: () =>
      new Promise<void>((resolve) => {
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
