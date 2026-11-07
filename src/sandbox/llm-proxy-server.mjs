#!/usr/bin/env node
// Standalone zero-dep LLM reverse-proxy for the host enclave sidecar. Holds the real provider
// credential (read from a tmpfs file, never argv/env) and swaps it in for a per-run nonce, then
// forwards to the chosen upstream's host. The pure auth/beta/path/compare logic is imported from the
// shared `llm-proxy-rewrite.mjs`, which the host `docker cp`'s next to this file — the SAME module the
// TS app and its tests use, so the two never drift.
//
// SECURITY: never log request/response headers, bodies, the secret, or the nonce. Inbound nonce check
// is constant-time. Locked down to the chosen upstream's POST paths (UPSTREAMS[k].paths) — everything
// else is a 404. For codex-chatgpt the real auth.json stays in this process: its refresh path is
// terminated here (one serialized exchange with the constant real IdP), and its revoke path is
// answered here without ever being forwarded.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import {
  UPSTREAMS,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  isAllowedLlmPath,
  isLocalAuthPath,
  constantTimeEqual,
  upstreamPath,
  filterAnthropicBeta,
  stripEgressTools,
  buildRefreshBody,
  applyRefreshResponse,
  placeholderChatgptAuth,
  chatgptAuthHeaders,
  codexIssuerAccepted,
  serializeRefresh,
  CODEX_ISSUER,
  CODEX_REFRESH_URL,
} from './llm-proxy-rewrite.mjs';
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
// The local auth paths ignore the cell's body entirely, so nothing legitimate is large there: cap it
// far below MAX_BODY_BYTES rather than buffering 32 MiB of a body we are about to throw away.
const MAX_AUTH_BODY_BYTES = 64 * 1024; // 64 KiB
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 8;
// Hop-by-hop headers must not be forwarded to the upstream.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// --- config: read MODE/SECRET/NONCE from the tmpfs file; PORT from env ---
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
const config = parseSecretFile(secretText);
// UPSTREAM is optional; default to anthropic so an unmodified sidecar still works.
// NB: named `upstreamKind` (not `upstream`) to avoid shadowing the per-request `upstream` socket
// bindings in the request handler / forward() — that shadowing would TDZ-crash on every request.
const upstreamKind = config.UPSTREAM ?? 'anthropic';
if (!(upstreamKind in UPSTREAMS)) {
  console.error(`llm-proxy: invalid secret file (UPSTREAM must be ${Object.keys(UPSTREAMS).join('|')})`);
  process.exit(1);
}
const spec = UPSTREAMS[upstreamKind];
// 'anthropic'-auth needs MODE (subscription|api); 'bearer'/'chatgpt'-auth is a Bearer value (no MODE).
if (spec.authKind === 'anthropic' && config.MODE !== 'subscription' && config.MODE !== 'api') {
  console.error('llm-proxy: invalid secret file (need MODE=subscription|api for anthropic)');
  process.exit(1);
}
// 'chatgpt' carries the real auth.json as AUTH_JSON instead of a single SECRET value.
if (spec.authKind !== 'chatgpt' && !config.SECRET) {
  console.error('llm-proxy: invalid secret file (need SECRET)');
  process.exit(1);
}
if (!config.NONCE) {
  console.error('llm-proxy: invalid secret file (need NONCE)');
  process.exit(1);
}
// SECRET/NONCE are placed into HTTP headers; reject control chars to prevent header injection.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
if (CONTROL_CHARS.test(config.SECRET ?? '') || CONTROL_CHARS.test(config.NONCE)) {
  console.error('llm-proxy: secret/nonce contains control characters');
  process.exit(1);
}
const UPSTREAM_HOST = spec.host;
const PORT = Number(process.env.PORT ?? '8088');

// --- Codex ChatGPT-plan state: the real auth.json, held only here, replaced on each refresh. ---
let chatgptState;
if (spec.authKind === 'chatgpt') {
  try {
    chatgptState = JSON.parse(config.AUTH_JSON ?? '');
  } catch {
    console.error('llm-proxy: invalid secret file (AUTH_JSON is not valid JSON)');
    process.exit(1);
  }
  // Both tokens are load-bearing and cannot be recovered from inside the sidecar: fail at boot rather
  // than crash on the first request (access_token goes into the upstream Authorization header on every
  // model call; refresh_token is the credential for the only refresh exchange anyone performs).
  if (!hasRealToken('access_token') || !hasRealToken('refresh_token')) {
    console.error('llm-proxy: invalid secret file (AUTH_JSON needs tokens.access_token and tokens.refresh_token)');
    process.exit(1);
  }
  // Upstream Codex would follow a provenance issuer recorded in the file; this sidecar refreshes
  // against one constant endpoint only, so a credential naming a different issuer is refused outright
  // instead of silently refreshing somewhere the constant does not cover.
  if (!codexIssuerAccepted(chatgptState)) {
    console.error(`llm-proxy: invalid secret file (AUTH_JSON records an OAuth issuer other than ${CODEX_ISSUER})`);
    process.exit(1);
  }
  if (CONTROL_CHARS.test(chatgptState.tokens.access_token)) {
    console.error('llm-proxy: real auth.json access_token contains control characters');
    process.exit(1);
  }
}

/** Whether the real auth.json carries a usable (non-empty string) value under `tokens.<field>`. */
function hasRealToken(field) {
  const value = chatgptState?.tokens?.[field];
  return typeof value === 'string' && value !== '';
}

// The ONE destination a refresh grant is ever sent to, taken apart from the constant CODEX_REFRESH_URL:
// never read from the cell's request and never from the credential file (codexIssuerAccepted refuses a
// credential naming another issuer). LLM_PROXY_CODEX_AUTH_* exist ONLY so tests can point this at a
// local fake instead of TLS to a real host — they are set by whoever spawns the sidecar (startLlmProxy
// never does) and are unreachable from the cell, which only ever talks HTTP to this server.
const refreshUrl = new URL(CODEX_REFRESH_URL);
const AUTH_HOST = process.env.LLM_PROXY_CODEX_AUTH_HOST ?? refreshUrl.hostname;
const AUTH_PORT = Number(process.env.LLM_PROXY_CODEX_AUTH_PORT ?? '443');
const AUTH_PATH = refreshUrl.pathname;
const authRequest = process.env.LLM_PROXY_CODEX_AUTH_INSECURE === '1' ? httpRequest : httpsRequest;

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

const auth = { mode: config.MODE, secret: config.SECRET };
const expectedAuthorization = `Bearer ${config.NONCE}`;

// Request auth keyed by the upstream's auth STYLE (UPSTREAMS[upstreamKind].authKind), not the upstream
// name — every 'bearer' upstream (openai, zai, …) shares one builder, so adding one needs no change here.
// Thunks are lazy (only the chosen style runs per request); spec.authKind is validated at boot, never misses.
const AUTH_HEADERS_BY_STYLE = {
  anthropic: (req) => upstreamAuthHeaders(auth, req.headers), // mode-aware Bearer/x-api-key (+ oauth beta merge)
  bearer: () => openaiAuthHeaders(config.SECRET), //            plain Authorization: Bearer SECRET (fixed for the sidecar's lifetime)
  chatgpt: () => chatgptAuthHeaders(chatgptState), //          Bearer + chatgpt-account-id, read fresh from the real auth.json every request (rotates on refresh)
};

let inFlight = 0;

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

const server = createServer((req, res) => {
  const started = Date.now();
  const path = (req.url ?? '').split('?')[0] ?? '';
  const localAuthKind = isLocalAuthPath(req.method, path, upstreamKind);

  if (!isAllowedLlmPath(req.method, req.url, upstreamKind) && localAuthKind === undefined) {
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
  // Set synchronously before the async codex-auth exchange starts: the request stream's 'close' can
  // fire once its body is fully read, independent of whether handleCodexAuth has finished responding —
  // without this flag the generic "body never completed" guard below would tear the response down
  // while that exchange with the real IdP is still in flight.
  let handlingLocally = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    if (upstream && !upstream.destroyed) upstream.destroy();
    if (!res.writableEnded) res.destroy();
  };

  // Buffer the request body with a hard size cap (a tight one on the local auth paths, whose body is
  // ignored anyway).
  const maxBody = localAuthKind === undefined ? MAX_BODY_BYTES : MAX_AUTH_BODY_BYTES;
  const chunks = [];
  let size = 0;
  let overflow = false;

  req.on('data', (chunk) => {
    if (done || overflow) return;
    size += chunk.length;
    if (size > maxBody) {
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
    // If the body never completed (no forward/local-auth started yet), release the slot.
    if (!done && upstream === null && !handlingLocally) cleanup();
  });

  req.on('end', () => {
    if (done || overflow) return;
    // The cell's own refresh/revoke body is never trusted (Q4 of the spike) — ignore it entirely and
    // answer from the sidecar's own real auth.json instead.
    if (localAuthKind !== undefined) {
      handlingLocally = true;
      handleCodexAuth(localAuthKind, req, res, started, () => done).finally(cleanup);
      return;
    }
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

/**
 * POST a small JSON body to the real IdP's one refresh endpoint (AUTH_HOST/AUTH_PORT/AUTH_PATH, all
 * fixed at boot) and resolve its status + parsed JSON (null if unparseable).
 */
function postAuthJson(bodyObj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const upReq = authRequest(
      { host: AUTH_HOST, port: AUTH_PORT, method: 'POST', path: AUTH_PATH, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } },
      (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* non-JSON error body — treated as no json below */
          }
          resolve({ status: upRes.statusCode ?? 502, json });
        });
        upRes.on('error', reject);
      },
    );
    upReq.on('error', reject);
    upReq.setTimeout(REQUEST_TIMEOUT_MS, () => upReq.destroy(new Error('llm-proxy: codex auth request timed out')));
    upReq.end(body);
  });
}

/**
 * The ONE refresh exchange, serialized: concurrent cell requests share the single in-flight exchange
 * rather than each presenting the real refresh token, which the IdP rotates on use and flags on a
 * second presentation as reuse — permanently invalidating the credential (Q4 of the spike). Rotates the
 * in-memory real tokens on success and reports only whether it succeeded, never the IdP's own body.
 */
const refreshOnce = serializeRefresh(async () => {
  const { status, json } = await postAuthJson(buildRefreshBody(chatgptState));
  const ok = status >= 200 && status < 300 && json !== null;
  if (ok) chatgptState = applyRefreshResponse(chatgptState, json);
  return { ok, status };
});

/**
 * Answer a local auth path from the real auth.json held only in this process — never from the cell's
 * own request. Refresh performs the serialized real exchange and answers with fresh placeholders
 * (opaque access/refresh tokens + a synthetic id_token). Revoke is answered here and NEVER forwarded:
 * the cell must not be able to invalidate the host's credential, and there is nothing to revoke
 * locally (the cell's own tokens are placeholders), so it reports success without contacting anyone.
 */
async function handleCodexAuth(kind, req, res, started, isDone) {
  if (kind === 'revoke') {
    finish(req, res, 200, started); // success with no body, exactly what the real endpoint returns
    return;
  }
  try {
    const { ok, status } = await refreshOnce();
    // The cell may have hung up while the exchange was in flight; the response is already torn down.
    if (isDone()) return;
    if (!ok) {
      finish(req, res, status, started); // no body: never relay the real IdP's response verbatim
      return;
    }
    const placeholder = placeholderChatgptAuth(chatgptState);
    const payload = Buffer.from(JSON.stringify(placeholder.tokens), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) });
    res.end(payload);
    log(req, 200, payload.length, started);
  } catch {
    if (!isDone()) finish(req, res, 502, started);
  }
}

function forward(req, res, body, started, setUpstream, cleanup, isDone) {
  // Strip inbound auth + hop-by-hop + host; then apply upstream auth headers.
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'host') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'anthropic-beta') {
      // Every upstream, not just anthropic-auth ones: drop beta families that open upstream-side egress.
      const beta = filterAnthropicBeta(value);
      if (beta !== undefined) headers[lower] = beta;
      continue;
    }
    if (value !== undefined) headers[lower] = value;
  }

  const applied = AUTH_HEADERS_BY_STYLE[spec.authKind](req);
  for (const [key, value] of Object.entries(applied)) headers[key] = value;
  headers['content-length'] = String(body.length);

  const path = upstreamPath(upstreamKind, req.url);
  let responded = false;

  const upstream = httpsRequest(
    { host: UPSTREAM_HOST, port: 443, method: 'POST', path, headers },
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

server.listen(PORT, () => console.log(`llm-proxy on ${PORT}; upstream=${upstreamKind}`));
