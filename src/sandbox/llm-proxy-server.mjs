#!/usr/bin/env node
// Standalone zero-dep LLM reverse-proxy for the host enclave sidecar. Holds the real Anthropic
// credential (read from a tmpfs file, never argv/env) and swaps it in for a per-run nonce, then
// forwards to api.anthropic.com. The pure auth/beta/path/compare logic is imported from the shared
// `llm-proxy-rewrite.mjs`, which the host `docker cp`'s next to this file — the SAME module the TS
// app and its tests use, so the two never drift.
//
// Also serves the Codex ChatGPT-plan credential (UPSTREAM=chatgpt): model calls go through the same
// forward() path below with the sidecar's own account id always attached, and two extra routes
// (CODEX_REFRESH_PATH/CODEX_REVOKE_PATH, from llm-proxy-rewrite.mjs) stand in for
// CODEX_REFRESH_TOKEN_URL_OVERRIDE/CODEX_REVOKE_TOKEN_URL_OVERRIDE — see
// docs/research/codex-credential-isolation.md for why the sidecar, not the sandbox, must be the only
// party that ever presents the real refresh token to the real IdP. Refresh is the ONLY route that
// talks to the real IdP; revoke is answered locally (it only drops this run's own binding state).
//
// SECURITY: never log request/response headers, bodies, the secret, or the nonce. Inbound nonce
// check is constant-time. Locked down to POST /v1/messages and /v1/messages/count_tokens (plus the
// chatgpt /responses, /oauth/token, /oauth/revoke routes when UPSTREAM=chatgpt).
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UPSTREAMS,
  HOP_BY_HOP,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  chatgptAuthHeaders,
  isAllowedLlmPath,
  constantTimeEqual,
  upstreamPath,
  buildForwardHeaders,
  stripEgressTools,
  chatgptIdpRoute,
  readIdpRequest,
  placeholderRefreshResponse,
  buildCodexAuthJson,
  CODEX_CLIENT_ID,
  CODEX_REFRESH_PATH,
} from './llm-proxy-rewrite.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
const MAX_IDP_REQUEST_BYTES = 64 * 1024; // the cell's refresh/revoke bodies are a handful of JSON fields
const MAX_IDP_RESPONSE_BYTES = 1024 * 1024; // the real IdP's refresh/revoke responses are tiny JSON too
const REQUEST_TIMEOUT_MS = 120_000;
const IDP_TIMEOUT_MS = 20_000;
const DEFAULT_REFRESH_FLOOR_MS = 5 * 60_000; // 5 minutes: caches only a SUCCESSFUL refresh, so a
// hostile or buggy cell driving one refresh per cell-visible tick still drives at most one real IdP
// exchange every 5 minutes, not every few seconds.
const DEFAULT_REFRESH_BACKOFF_BASE_MS = 30_000; // first wait after a failed refresh
const DEFAULT_REFRESH_BACKOFF_MAX_MS = 30 * 60_000; // backoff growth is capped here
const DEFAULT_MAX_REFRESHES_PER_RUN = 20; // hard ceiling on real IdP refresh exchanges for the life of this process
const MAX_CONCURRENT = 8;
const CODEX_IDP_BASE_URL = 'https://auth.openai.com';
// The sidecar's own credential directory: the in-RAM tmpfs holding its secret file, and the ONLY
// place the rotated real credential may be written. Keep in sync with SECRET_FILE in llm-proxy.ts;
// the CLI bootstrap below derives it from LLM_PROXY_SECRET_FILE, so this is only the fallback.
const DEFAULT_CREDENTIAL_DIR = '/run/vanguard-llm';
// SECRET/NONCE (and the chatgpt credential fields, including AUTH_FILE — it reaches a filesystem
// path) are placed into HTTP headers, JSON bodies or syscalls; reject control chars up front to
// prevent header/JSON/path injection.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function parseSecretFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key !== '') out[key] = value.replace(/\r$/, '');
  }
  return out;
}

/**
 * Validates the parsed secret file and returns its upstream kind + spec. Throws a plain Error on
 * an invalid file — never calls process.exit itself; only the CLI bootstrap at the bottom of this
 * file does that, so createLlmProxyServer stays usable (and testable) as a library function.
 */
function resolveUpstream(config, credentialDir) {
  const upstreamKind = config.UPSTREAM ?? 'anthropic';
  if (!(upstreamKind in UPSTREAMS)) {
    throw new Error(`invalid secret file (UPSTREAM must be ${Object.keys(UPSTREAMS).join('|')})`);
  }
  const spec = UPSTREAMS[upstreamKind];
  // 'anthropic'-auth needs MODE (subscription|api); 'bearer'-auth (openai, zai) is just Bearer SECRET
  // (no MODE); 'chatgpt'-auth needs the host-held real credential instead of a single SECRET.
  if (spec.auth === 'anthropic' && config.MODE !== 'subscription' && config.MODE !== 'api') {
    throw new Error('invalid secret file (need MODE=subscription|api for anthropic)');
  }
  if (spec.auth === 'chatgpt') {
    const required = ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'ACCOUNT_ID', 'PLAN_TYPE', 'REFRESH_PLACEHOLDER', 'AUTH_FILE'];
    const missing = required.filter((key) => !config[key]);
    if (missing.length > 0) throw new Error(`invalid secret file (need ${missing.join(', ')} for chatgpt)`);
  } else if (!config.SECRET) {
    throw new Error('invalid secret file (need SECRET)');
  }
  if (!config.NONCE) throw new Error('invalid secret file (need NONCE)');
  const checked = [
    config.SECRET, config.NONCE, config.ACCESS_TOKEN, config.REFRESH_TOKEN, config.ACCOUNT_ID,
    config.PLAN_TYPE, config.REFRESH_PLACEHOLDER, config.AUTH_FILE,
  ].filter((v) => v !== undefined);
  if (checked.some((v) => CONTROL_CHARS.test(v))) {
    throw new Error('invalid secret file (control characters in a credential field)');
  }
  // The rotated real credential may only ever be written inside the sidecar's OWN credential
  // directory — never a shared, cell-visible or traversed path. Checked on the RESOLVED path so
  // `..` segments cannot climb out.
  if (spec.auth === 'chatgpt') {
    const dir = resolve(credentialDir);
    if (!resolve(config.AUTH_FILE).startsWith(`${dir}${sep}`)) {
      throw new Error('invalid secret file (AUTH_FILE must be inside the sidecar credential directory)');
    }
  }
  return { upstreamKind, spec };
}

/** Buffer a (small) request body with a hard cap; resolves null on overflow/abort — the caller sends
 *  the error status and only THEN tears the socket down, so an oversized body still gets a real 413
 *  instead of a connection reset. Nothing further is accumulated once the cap is hit, so memory stays
 *  bounded even while the client keeps sending. Used only by the chatgpt IdP routes: the heavier
 *  model-call path below has its own buffering, intertwined with forward()'s slot bookkeeping. */
function readSmallBody(req, maxBytes) {
  return new Promise((settleWith) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      settleWith(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settle(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => settle(null));
    req.on('aborted', () => settle(null));
    req.on('end', () => settle(Buffer.concat(chunks, size)));
  });
}

/** Reads a fetch Response body with a hard byte cap, aborting the stream (not just rejecting after
 *  buffering it all) once exceeded — the IdP response cap. Resolves '' for a bodyless response. */
async function readCappedResponse(response, maxBytes) {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('idp response exceeds the size cap');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Builds the sidecar's request handler and returns the (not-yet-listening) http.Server.
 * `options.credentialDir` is the directory AUTH_FILE must live in (the CLI bootstrap passes the
 * secret file's own directory). `options.idpBaseUrl`, `options.refreshFloorMs`,
 * `options.refreshBackoffBaseMs`, `options.refreshBackoffMaxMs` and `options.maxRefreshesPerRun` are
 * test-only injection points for the chatgpt IdP calls; `options.forwardTo` is a test-only injection
 * point for the model-call upstream. None of these are environment variables — production never
 * sets the test-only ones, and this file carries no test-only override environment variable of any
 * kind (host/port/insecure-flag or otherwise).
 */
export function createLlmProxyServer(secretText, options = {}) {
  const config = parseSecretFile(secretText);
  const { upstreamKind, spec } = resolveUpstream(config, options.credentialDir ?? DEFAULT_CREDENTIAL_DIR);
  const idpBaseUrl = options.idpBaseUrl ?? CODEX_IDP_BASE_URL;
  const refreshFloorMs = options.refreshFloorMs ?? DEFAULT_REFRESH_FLOOR_MS;
  const refreshBackoffBaseMs = options.refreshBackoffBaseMs ?? DEFAULT_REFRESH_BACKOFF_BASE_MS;
  const refreshBackoffMaxMs = options.refreshBackoffMaxMs ?? DEFAULT_REFRESH_BACKOFF_MAX_MS;
  const maxRefreshesPerRun = options.maxRefreshesPerRun ?? DEFAULT_MAX_REFRESHES_PER_RUN;

  const auth = { mode: config.MODE, secret: config.SECRET };
  const expectedAuthorization = `Bearer ${config.NONCE}`;
  const UPSTREAM_HOST = spec.host;

  // Mutable only for the chatgpt auth kind: the real access/refresh token the sidecar rotates and
  // persists, seeded from the host-held credential the secret file carried at boot.
  const chatgptState =
    spec.auth === 'chatgpt'
      ? {
          accessToken: config.ACCESS_TOKEN,
          refreshToken: config.REFRESH_TOKEN,
          accountId: config.ACCOUNT_ID,
          planType: config.PLAN_TYPE,
          refreshPlaceholder: config.REFRESH_PLACEHOLDER,
          authFile: config.AUTH_FILE,
        }
      : undefined;

  // Request auth keyed by the upstream's auth STYLE (from UPSTREAMS[upstreamKind].auth), not the upstream
  // name — every 'bearer' upstream (openai, zai, …) shares one builder, so adding one needs no change here.
  // Thunks are lazy (only the chosen style runs per request); spec.auth is validated at boot, never misses.
  const AUTH_HEADERS_BY_STYLE = {
    anthropic: (req) => upstreamAuthHeaders(auth, req.headers), // mode-aware Bearer/x-api-key (+ oauth beta merge)
    bearer: () => openaiAuthHeaders(config.SECRET), //            plain Authorization: Bearer SECRET
    chatgpt: () => chatgptAuthHeaders(chatgptState.accessToken, chatgptState.accountId), // real token + real account id, always
  };

  let inFlight = 0;
  // Refresh floor + dedup + backoff + cap state (chatgpt only): `cachedRefresh` holds the last
  // successful response for `refreshFloorMs`; `pendingRefresh` is the in-flight call concurrent
  // callers share instead of each starting their own; `refreshAttempts` counts real IdP exchanges
  // (success or failure) toward `maxRefreshesPerRun`; `backoffUntil` is the epoch ms before which a
  // failed refresh's next attempt is refused without calling the IdP; `consecutiveFailures` grows
  // the backoff exponentially. `refreshCount` counts token rotations for the warning/summary.
  // Only the cache and pending call are cleared on server close.
  let cachedRefresh;
  let floorTimer;
  let pendingRefresh;
  let refreshAttempts = 0;
  let consecutiveFailures = 0;
  let backoffUntil = 0;
  let refreshCount = 0;

  function finish(req, res, status, started) {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'text/plain' });
    }
    res.end();
    // No upstream body for short-circuit responses → omit the byte figure.
    log(req, status, null, started);
  }

  // `bytes` is the upstream content-length (number) when known, else null → omit the byte figure.
  function log(req, status, bytes, started) {
    const ms = Date.now() - started;
    const path = (req.url ?? '').split('?')[0] ?? '';
    // ONLY method, path, status, byte count, duration — never headers/body/secret/nonce.
    const size = bytes === null ? '' : `${bytes}B, `;
    console.log(`${req.method} ${path} -> ${status} (${size}${ms}ms)`);
  }

  /** Writes the sidecar's own copy of the rotated real chatgpt credential — the host-side
   *  persistence part 2's launcher reads back on the next run so a logged-in session survives past
   *  this one container's lifetime. Real access/refresh tokens plus a loadable synthetic id_token.
   *  Written to a sibling temp file, chmod'd 0600 explicitly (the `mode:` option is masked by umask
   *  and ignored for an existing file) and renamed into place, so a crash mid-write can never leave
   *  a truncated — or briefly world-readable — credential behind. AUTH_FILE was validated at boot to
   *  sit inside the sidecar's own credential directory. */
  function persistChatgptAuth() {
    const { accessToken, refreshToken, accountId, planType } = chatgptState;
    const body = buildCodexAuthJson(accessToken, refreshToken, accountId, planType);
    const tmpFile = `${chatgptState.authFile}.${process.pid}.tmp`;
    writeFileSync(tmpFile, body, { mode: 0o600 });
    chmodSync(tmpFile, 0o600);
    renameSync(tmpFile, chatgptState.authFile);
  }

  async function callIdp(path, body) {
    const res = await fetch(`${idpBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
      // Never follow a redirect: the real refresh token is in the request body, so a 30x (even to a
      // same-looking host) must never cause it to be re-sent to wherever that redirect points.
      // `fetch` throws on a redirect response instead of following it.
      redirect: 'error',
    });
    const text = await readCappedResponse(res, MAX_IDP_RESPONSE_BYTES);
    return { ok: res.ok, text };
  }

  /** The actual refresh exchange against the real IdP: the ONLY place the real refresh token is ever
   *  presented to auth.openai.com. Rotates + persists the result, then arms the floor timer. */
  async function doRefresh() {
    const { ok, text } = await callIdp(CODEX_REFRESH_PATH, {
      grant_type: 'refresh_token',
      refresh_token: chatgptState.refreshToken,
      client_id: CODEX_CLIENT_ID,
    });
    if (!ok) throw new Error('idp refresh failed');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof parsed.access_token !== 'string' || !parsed.access_token || CONTROL_CHARS.test(parsed.access_token) ||
        (parsed.refresh_token !== undefined &&
          (typeof parsed.refresh_token !== 'string' || !parsed.refresh_token || CONTROL_CHARS.test(parsed.refresh_token)))) {
      throw new Error('invalid idp refresh response');
    }
    const rotated = parsed.refresh_token !== undefined && parsed.refresh_token !== chatgptState.refreshToken;
    chatgptState.accessToken = parsed.access_token;
    if (parsed.refresh_token !== undefined) chatgptState.refreshToken = parsed.refresh_token;
    persistChatgptAuth();
    const payload = placeholderRefreshResponse(config.NONCE, chatgptState.refreshPlaceholder, chatgptState.accountId, chatgptState.planType);
    cachedRefresh = payload;
    clearTimeout(floorTimer);
    floorTimer = setTimeout(() => {
      cachedRefresh = undefined;
    }, refreshFloorMs);
    floorTimer.unref?.();
    if (rotated) {
      refreshCount += 1;
      // The rotated refresh token just invalidated whatever CODEX_AUTH_JSON a CI job sourced at boot
      // (it is a static secret; nothing writes the rotation back to GitHub) — surface that immediately
      // in the sidecar's own output rather than leaving the operator to discover a dead token on the
      // next run. See docs/research/codex-credential-isolation.md.
      console.warn(
        `llm-proxy: WARNING codex refresh token rotated (refresh #${refreshCount} this run) — ` +
          'the CODEX_AUTH_JSON secret now holds a stale refresh token; update it (gh secret set CODEX_AUTH_JSON) ' +
          'or a future run may fail to authenticate',
      );
    }
    return payload;
  }

  /** The refresh floor + backoff + per-run cap: inside the floor window, repeated calls get the
   *  cached result instead of hitting OpenAI again; concurrent calls before the first settles share
   *  that one call. After a failed refresh, the next real attempt is refused (no IdP call) until
   *  `backoffUntil`, growing exponentially with consecutive failures up to `refreshBackoffMaxMs`, and
   *  reset on the next success. Once `maxRefreshesPerRun` real attempts have been made, every later
   *  call is refused locally for the rest of this process's life — never another IdP call. */
  function refreshFromIdp() {
    if (cachedRefresh !== undefined) return Promise.resolve(cachedRefresh);
    if (pendingRefresh !== undefined) return pendingRefresh;
    if (refreshAttempts >= maxRefreshesPerRun) {
      return Promise.reject(new Error('idp refresh cap reached for this run'));
    }
    if (Date.now() < backoffUntil) {
      return Promise.reject(new Error('idp refresh backoff in effect after a prior failure'));
    }
    refreshAttempts += 1;
    pendingRefresh = doRefresh()
      .then((payload) => {
        consecutiveFailures = 0;
        backoffUntil = 0;
        return payload;
      })
      .catch((error) => {
        consecutiveFailures += 1;
        const backoffMs = Math.min(refreshBackoffBaseMs * 2 ** (consecutiveFailures - 1), refreshBackoffMaxMs);
        backoffUntil = Date.now() + backoffMs;
        throw error;
      })
      .finally(() => {
        pendingRefresh = undefined;
      });
    return pendingRefresh;
  }

  /** The cell's logout: drop this run's binding state so the placeholder stops working (every later
   *  refresh/revoke 401s, with no stale cached response behind it) and forget the cached refresh
   *  result. The real refresh token is NOT revoked at OpenAI — a run's sandbox must not be able to
   *  log the host's own account out — and the host credential file is left exactly as it was. */
  function revokeLocally() {
    chatgptState.refreshPlaceholder = '';
    cachedRefresh = undefined;
    clearTimeout(floorTimer);
    floorTimer = undefined;
  }

  async function handleIdpRoute(route, req, res, started) {
    const body = await readSmallBody(req, MAX_IDP_REQUEST_BYTES);
    if (body === null) {
      // Answer first, THEN tear down the oversized request's socket, so the cell sees the 413.
      res.on('finish', () => {
        if (!req.destroyed) req.destroy();
      });
      finish(req, res, 413, started);
      return;
    }
    // refresh grant uses `refresh_token`; revoke (RFC 7009) uses `token` — both carry this run's
    // placeholder, never the real value, and that placeholder is the ONLY thing that binds the
    // request to this run (there is no nonce header on either path). Nothing else from the body is
    // read, and nothing from it is ever forwarded: the upstream refresh body is built from fixed
    // fields in doRefresh(), and revoke makes no upstream call at all.
    const field = route === 'refresh' ? 'refresh_token' : 'token';
    const credential = readIdpRequest(body, field);
    // An already-revoked run has an empty placeholder: refuse without comparing, so nothing can
    // match it.
    if (credential === undefined || chatgptState.refreshPlaceholder === '' ||
        !constantTimeEqual(credential, chatgptState.refreshPlaceholder)) {
      finish(req, res, 401, started);
      return;
    }
    if (route === 'revoke') {
      revokeLocally();
      finish(req, res, 200, started);
      return;
    }
    try {
      const payload = await refreshFromIdp();
      const json = JSON.stringify(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json);
      log(req, 200, Buffer.byteLength(json), started);
    } catch {
      finish(req, res, 502, started);
    }
  }

  const server = createServer((req, res) => {
    const started = Date.now();

    if (spec.auth === 'chatgpt') {
      const route = chatgptIdpRoute(req.method, req.url);
      if (route !== undefined) {
        // IdP routes hold a concurrency slot like every other route, so a flood of refreshes can
        // neither bypass MAX_CONCURRENT nor starve the model-call path.
        if (inFlight >= MAX_CONCURRENT) {
          finish(req, res, 503, started);
          req.resume();
          return;
        }
        inFlight += 1;
        handleIdpRoute(route, req, res, started)
          .catch(() => {
            // Never let a rejection escape as an unhandled rejection: answer 500 and log the route
            // only (never the error object — it can carry credential/path hints).
            console.error(`llm-proxy: idp ${route} route failed`);
            if (!res.writableEnded) finish(req, res, 500, started);
          })
          .finally(() => {
            inFlight -= 1;
          });
        return;
      }
    }

    if (!isAllowedLlmPath(req.method, req.url, upstreamKind)) {
      finish(req, res, 404, started);
      req.resume();
      return;
    }

    const authorization = req.headers['authorization'] ?? '';
    if (!constantTimeEqual(authorization, expectedAuthorization)) {
      finish(req, res, 401, started);
      req.resume();
      return;
    }

    if (inFlight >= MAX_CONCURRENT) {
      finish(req, res, 503, started);
      req.resume();
      return;
    }

    // We are now holding a concurrency slot; EVERY exit path must funnel through cleanup() exactly
    // once so inFlight is released and sockets are torn down. `done` makes cleanup() idempotent.
    inFlight += 1;
    let done = false;
    let upstream = null;
    const cleanup = () => {
      if (done) return;
      done = true;
      inFlight -= 1;
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!res.writableEnded) res.destroy();
    };

    // Buffer the request body with a hard size cap.
    const chunks = [];
    let size = 0;
    let overflow = false;

    req.on('data', (chunk) => {
      if (done || overflow) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        finish(req, res, 413, started);
        req.destroy();
        cleanup();
        return;
      }
      chunks.push(chunk);
    });

    // Client abort during buffering emits 'aborted'/'close' (not always 'error'); cover all of them.
    req.on('error', cleanup);
    req.on('aborted', cleanup);
    req.on('close', () => {
      // If the body never completed (no forward started yet), release the slot.
      if (!done && upstream === null) cleanup();
    });

    req.on('end', () => {
      if (done || overflow) return;
      // An encoded body could not be inspected for egress-capable tools: refuse it rather than pass it on.
      const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      if (encoding !== '' && encoding !== 'identity') {
        finish(req, res, 415, started);
        cleanup();
        return;
      }
      const body = stripEgressTools(Buffer.concat(chunks, size));
      forward(req, res, body, started, (up) => {
        upstream = up;
      }, cleanup, () => done);
    });
  });

  function forward(req, res, body, started, setUpstream, cleanup, isDone) {
    const applied = AUTH_HEADERS_BY_STYLE[spec.auth](req);
    const headers = buildForwardHeaders(req.headers, applied);
    headers['content-length'] = String(body.length);

    const path = upstreamPath(upstreamKind, req.url);
    let responded = false;

    // Test-only: options.forwardTo redirects the model-call upstream (host/port/protocol) so tests
    // can stand in a local fake server instead of the real api.anthropic.com/chatgpt.com/etc.
    // Production never sets it, so every existing upstream's behavior is unchanged.
    const target = options.forwardTo ?? { host: UPSTREAM_HOST, port: 443, protocol: 'https' };
    const requestFn = target.protocol === 'http' ? httpRequest : httpsRequest;

    const upstream = requestFn(
      { host: target.host, port: target.port, method: 'POST', path, headers },
      (upRes) => {
        responded = true;
        const outHeaders = {};
        for (const [key, value] of Object.entries(upRes.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          if (value !== undefined) outHeaders[key] = value;
        }
        // Byte count for the access log comes from the upstream content-length when present (no
        // per-chunk tallying); streaming responses (SSE) have none → omit the figure.
        const cl = upRes.headers['content-length'];
        const clNum = Array.isArray(cl) ? Number(cl[0]) : Number(cl);
        const bytes = cl !== undefined && Number.isFinite(clNum) ? clNum : null;
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
        upRes.on('end', () => {
          log(req, upRes.statusCode ?? 502, bytes, started);
          cleanup();
        });
        upRes.on('error', cleanup);
      },
    );
    setUpstream(upstream);

    upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (!responded && !res.headersSent) {
        finish(req, res, 504, started);
      }
      cleanup();
    });

    upstream.on('error', () => {
      if (!responded && !res.headersSent && !isDone()) {
        finish(req, res, 502, started);
      }
      cleanup();
    });

    // Client hung up after we started forwarding — abort upstream and release.
    res.on('close', cleanup);

    upstream.end(body);
  }

  server.on('close', () => {
    clearTimeout(floorTimer);
    cachedRefresh = undefined;
    pendingRefresh = undefined;
    // Run summary: restate the warning once more at teardown, when a refresh happened, so it is not
    // lost in whatever per-request access-log lines came after it.
    if (refreshCount > 0) {
      console.warn(
        `llm-proxy: run summary: codex refresh token was rotated ${refreshCount} time(s) this run — ` +
          'update the CODEX_AUTH_JSON secret (gh secret set CODEX_AUTH_JSON) before the next run.',
      );
    }
  });

  // Exposed for the CLI bootstrap's banner only; not part of the public contract.
  server.vanguardUpstream = upstreamKind;
  return server;
}

// --- CLI bootstrap (production): read MODE/SECRET/NONCE/etc from the tmpfs file; PORT from env ---
// Entry check by argv[1] rather than `import.meta.main` (added in Node 24, absent on older runtimes
// where it silently evaluates to undefined and the sidecar would never start listening).
if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  const secretFile = process.env.LLM_PROXY_SECRET_FILE;
  if (!secretFile) {
    console.error('llm-proxy: LLM_PROXY_SECRET_FILE is required');
    process.exit(1);
  }
  let secretText;
  try {
    secretText = readFileSync(secretFile, 'utf8');
  } catch {
    // Never log the error object or file contents (may carry path/secret hints).
    console.error('llm-proxy: cannot read secret file');
    process.exit(1);
  }
  const PORT = Number(process.env.PORT ?? '8088');
  let server;
  try {
    // The sidecar's own credential directory is the one holding its tmpfs secret file.
    server = createLlmProxyServer(secretText, { credentialDir: dirname(secretFile) });
  } catch (err) {
    console.error(`llm-proxy: ${err instanceof Error ? err.message : 'invalid secret file'}`);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`llm-proxy on ${PORT}; upstream=${server.vanguardUpstream}`));
}
