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
// party that ever presents the real refresh token to the real IdP.
//
// SECURITY: never log request/response headers, bodies, the secret, or the nonce. Inbound nonce
// check is constant-time. Locked down to POST /v1/messages and /v1/messages/count_tokens (plus the
// chatgpt /responses, /oauth/token, /oauth/revoke routes when UPSTREAM=chatgpt).
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
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
  buildSyntheticIdToken,
  CODEX_CLIENT_ID,
  CODEX_REFRESH_PATH,
  CODEX_REVOKE_PATH,
} from './llm-proxy-rewrite.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
const MAX_IDP_REQUEST_BYTES = 64 * 1024; // the cell's refresh/revoke bodies are a handful of JSON fields
const MAX_IDP_RESPONSE_BYTES = 1024 * 1024; // the real IdP's refresh/revoke responses are tiny JSON too
const REQUEST_TIMEOUT_MS = 120_000;
const IDP_TIMEOUT_MS = 20_000;
const DEFAULT_REFRESH_FLOOR_MS = 5_000;
const MAX_CONCURRENT = 8;
const CODEX_IDP_BASE_URL = 'https://auth.openai.com';
// SECRET/NONCE (and the chatgpt credential fields) are placed into HTTP headers or JSON bodies;
// reject control chars up front to prevent header/JSON injection.
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
function resolveUpstream(config) {
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
  const checked = [config.SECRET, config.NONCE, config.ACCESS_TOKEN, config.REFRESH_TOKEN, config.ACCOUNT_ID, config.PLAN_TYPE, config.REFRESH_PLACEHOLDER].filter(
    (v) => v !== undefined,
  );
  if (checked.some((v) => CONTROL_CHARS.test(v))) {
    throw new Error('invalid secret file (control characters in a credential field)');
  }
  return { upstreamKind, spec };
}

/** Buffer a (small) request body with a hard cap; resolves null on overflow/abort — the caller sends
 *  the error status. Used only by the chatgpt IdP routes: the heavier model-call path below has its
 *  own buffering, intertwined with the concurrency-slot bookkeeping forward() needs. */
function readSmallBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
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
 * `options.idpBaseUrl` and `options.refreshFloorMs` are test-only injection points for the chatgpt
 * IdP calls; `options.forwardTo` is a test-only injection point for the model-call upstream. None of
 * these are environment variables — production never sets any of them, and this file carries no
 * test-only override environment variable of any kind (host/port/insecure-flag or otherwise).
 */
export function createLlmProxyServer(secretText, options = {}) {
  const config = parseSecretFile(secretText);
  const { upstreamKind, spec } = resolveUpstream(config);
  const idpBaseUrl = options.idpBaseUrl ?? CODEX_IDP_BASE_URL;
  const refreshFloorMs = options.refreshFloorMs ?? DEFAULT_REFRESH_FLOOR_MS;

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
  // Refresh floor + dedup state (chatgpt only): `cachedRefresh` holds the last successful response
  // for `refreshFloorMs`; `pendingRefresh` is the in-flight call concurrent callers share instead of
  // each starting their own. Both — and `floorTimer` — are reset on server close.
  let cachedRefresh;
  let floorTimer;
  let pendingRefresh;

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
   *  this one container's lifetime. Real access/refresh tokens plus a loadable synthetic id_token. */
  function persistChatgptAuth() {
    const body = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: buildSyntheticIdToken(chatgptState.accountId, chatgptState.planType),
        access_token: chatgptState.accessToken,
        refresh_token: chatgptState.refreshToken,
        account_id: chatgptState.accountId,
      },
      last_refresh: new Date().toISOString(),
    });
    writeFileSync(chatgptState.authFile, body, { mode: 0o600 });
  }

  async function callIdp(path, body) {
    const res = await fetch(`${idpBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
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
    return payload;
  }

  /** The refresh floor: inside the window, repeated calls get the cached result instead of hitting
   *  OpenAI again; concurrent calls before the first settles share that one call. */
  function refreshFromIdp() {
    if (cachedRefresh !== undefined) return Promise.resolve(cachedRefresh);
    if (pendingRefresh !== undefined) return pendingRefresh;
    pendingRefresh = doRefresh().finally(() => {
      pendingRefresh = undefined;
    });
    return pendingRefresh;
  }

  async function handleIdpRoute(route, req, res, started) {
    const body = await readSmallBody(req, MAX_IDP_REQUEST_BYTES);
    if (body === null) {
      finish(req, res, 413, started);
      return;
    }
    // refresh grant uses `refresh_token`; revoke (RFC 7009) uses `token` — both carry this run's
    // placeholder, never the real value, and that placeholder is the ONLY thing that binds the
    // request to this run (there is no nonce header on either path).
    const field = route === 'refresh' ? 'refresh_token' : 'token';
    const parsedReq = readIdpRequest(body, field);
    if (parsedReq === undefined || !constantTimeEqual(parsedReq.credential, chatgptState.refreshPlaceholder)) {
      finish(req, res, 401, started);
      return;
    }
    try {
      if (route === 'refresh') {
        const payload = await refreshFromIdp();
        const json = JSON.stringify(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(json);
        log(req, 200, Buffer.byteLength(json), started);
      } else {
        const upstreamBody = { ...parsedReq.parsed, token: chatgptState.refreshToken, client_id: CODEX_CLIENT_ID };
        const { ok } = await callIdp(CODEX_REVOKE_PATH, upstreamBody);
        finish(req, res, ok ? 200 : 502, started);
      }
    } catch {
      finish(req, res, 502, started);
    }
  }

  const server = createServer((req, res) => {
    const started = Date.now();

    if (spec.auth === 'chatgpt') {
      const route = chatgptIdpRoute(req.method, req.url);
      if (route !== undefined) {
        handleIdpRoute(route, req, res, started);
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
  });

  // Exposed for the CLI bootstrap's banner only; not part of the public contract.
  server.vanguardUpstream = upstreamKind;
  return server;
}

// --- CLI bootstrap (production): read MODE/SECRET/NONCE/etc from the tmpfs file; PORT from env ---
if (import.meta.main) {
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
    server = createLlmProxyServer(secretText);
  } catch (err) {
    console.error(`llm-proxy: ${err instanceof Error ? err.message : 'invalid secret file'}`);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`llm-proxy on ${PORT}; upstream=${server.vanguardUpstream}`));
}
