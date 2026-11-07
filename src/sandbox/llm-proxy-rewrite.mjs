// Pure rewrite/lockdown logic for the host LLM reverse-proxy sidecar.
// Authored as plain ESM `.mjs` so BOTH the strict-TS app and the zero-dep sidecar
// (`llm-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `llm-proxy-rewrite.d.mts`. The sidecar gets this file
// `docker cp`'d next to it so the relative `import './llm-proxy-rewrite.mjs'` resolves.
import { timingSafeEqual, randomBytes } from 'node:crypto';

export const OAUTH_BETA = 'oauth-2025-04-20';

/** Coerce a node header value (string | string[] | undefined) to a single comma-joined string. */
function betaToString(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * anthropic-beta feature families the sidecar refuses to forward: each lets the upstream reach third-party
 * servers on the sandbox's behalf (MCP connector, web fetch, tunnels) or keep state/run code outside the
 * run (files, code execution, skills, batches, hosted agents/environments) — egress the sandbox
 * allowlist cannot see. Prefix-matched on whole name segments, so re-dated, undated and extended
 * variants (`code-execution-web-tools-…`, `mcp-anything`) are dropped too. A denylist rather than an
 * allowlist on purpose: Claude Code ships dozens of betas and adds new ones each release, and dropping
 * an unknown one turns its request fields into upstream 400s.
 */
const BLOCKED_BETA_PREFIXES = [
  'mcp',
  'web-fetch',
  'code-execution',
  'files-api',
  'skills',
  'message-batches',
  'managed-agents',
  'environments',
  'ccr',
];

/** Whether a beta value belongs to a blocked family: equal to a prefix or continuing it with `-`. */
function isBlockedBeta(value) {
  return BLOCKED_BETA_PREFIXES.some((p) => value === p || value.startsWith(`${p}-`));
}

// Server tools that make the upstream fetch URLs, run code or call MCP servers for the sandbox.
// web_search stays: Claude Code's WebSearch tool depends on it.
const BLOCKED_TOOL_TYPE = /^(web_fetch|code_execution|mcp)/i;

/**
 * The request body with egress-capable server tools removed from `tools[]` and the MCP-connector
 * `mcp_servers` parameter dropped. Returns the input Buffer untouched when there is nothing to strip or
 * it is not a JSON object (the upstream rejects a malformed body itself).
 */
export function stripEgressTools(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  let changed = false;
  if ('mcp_servers' in parsed) {
    delete parsed.mcp_servers;
    changed = true;
  }
  if (Array.isArray(parsed.tools)) {
    const kept = parsed.tools.filter((t) => !(t !== null && typeof t === 'object' && typeof t.type === 'string' && BLOCKED_TOOL_TYPE.test(t.type)));
    if (kept.length !== parsed.tools.length) {
      parsed.tools = kept;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(parsed), 'utf8') : body;
}

/**
 * The request's anthropic-beta with blocked families removed (trimmed, comma-joined); undefined when
 * nothing is left, so the caller omits the header.
 */
export function filterAnthropicBeta(incoming) {
  const kept = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !isBlockedBeta(s.toLowerCase()));
  return kept.length > 0 ? kept.join(',') : undefined;
}

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export function mergeAnthropicBeta(incoming, extra) {
  const parts = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!parts.includes(extra)) parts.push(extra);
  return parts.join(',');
}

/**
 * Headers to apply upstream for the chosen auth mode. Returns lowercase keys to set; caller deletes any
 * conflicting inbound auth headers first. Subscription => Authorization: Bearer + oauth beta merged;
 * api => x-api-key, no oauth beta.
 */
export function upstreamAuthHeaders(auth, reqHeaders) {
  const beta = filterAnthropicBeta(reqHeaders['anthropic-beta']);
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  // api mode: x-api-key, no oauth beta; pass through the request's (filtered) anthropic-beta if present.
  return { 'x-api-key': auth.secret, ...(beta !== undefined ? { 'anthropic-beta': beta } : {}) };
}

/**
 * Single source of truth for every upstream the sidecar can proxy, keyed by the UPSTREAM value in the
 * secret file. Add an upstream here and every consumer follows: host routing + allowlist drop
 * (UPSTREAMS[k].host), POST-path lockdown (.paths), auth scheme (.authKind), and boot validation (`k in UPSTREAMS`).
 *
 * - host:     where the sidecar forwards (and the host dropped from the sandbox egress allowlist).
 * - paths:    the ONLY POST paths tunnelled through (query string ignored, no wildcards) — the lockdown.
 * - authKind: which header builder presents the real credential upstream. 'anthropic' = mode-aware
 *             x-api-key or Bearer+oauth-beta (upstreamAuthHeaders). 'bearer' = a fixed Bearer value for
 *             the sidecar's lifetime (openaiAuthHeaders). 'chatgpt' = same Bearer shape, but read fresh
 *             on every request from the mutable real-auth state the sidecar maintains (rotates on
 *             refresh — see llm-proxy-server.mjs). z.ai/OpenRouter are Anthropic-Messages-compatible on
 *             the WIRE (same paths) but authenticate with plain bearer keys, so they pair anthropic
 *             paths with bearer auth.
 * - localPaths: POST paths this upstream's OWN sidecar terminates instead of forwarding (codex-chatgpt's
 *             refresh/revoke): never reach the upstream host untouched — see isLocalAuthPath.
 */
export const UPSTREAMS = {
  anthropic: { host: 'api.anthropic.com', paths: ['/v1/messages', '/v1/messages/count_tokens'], authKind: 'anthropic' },
  openai: { host: 'api.openai.com', paths: ['/v1/responses'], authKind: 'bearer' },
  // basePath: keep in sync with ZAI_BASE_URL in src/agents/zai.ts
  zai: { host: 'api.z.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], authKind: 'bearer', basePath: '/api/coding/paas/v4' },
  // basePath: keep in sync with OPENROUTER_BASE_URL in src/agents/openrouter.ts
  openrouter: { host: 'openrouter.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], authKind: 'bearer', basePath: '/api' },
  // Codex on a ChatGPT plan (#625/#638 spike): model calls go to chatgpt.com's codex backend; refresh
  // and revoke are terminated locally (see localPaths) rather than forwarded — the cell must never
  // present the real refresh token itself (a stale copy racing the sidecar's own refresh would be
  // permanently invalidated as reuse by the real IdP), and must never be able to revoke it at all.
  'codex-chatgpt': {
    host: 'chatgpt.com',
    paths: ['/backend-api/codex/responses'],
    authKind: 'chatgpt',
    localPaths: { refresh: '/oauth/token', revoke: '/oauth/revoke' },
  },
};

/** Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored). */
export function isAllowedLlmPath(method, path, upstream = 'anthropic') {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  const spec = UPSTREAMS[upstream];
  if (spec === undefined) return false;
  const p = (path ?? '').split('?')[0] ?? '';
  return spec.paths.includes(p);
}

/**
 * Whether a POST path is one this upstream's sidecar handles itself (never forwarded upstream
 * untouched): 'refresh' | 'revoke' | undefined. Only codex-chatgpt defines localPaths today.
 */
export function isLocalAuthPath(method, path, upstream) {
  const spec = UPSTREAMS[upstream];
  if ((method ?? '').toUpperCase() !== 'POST' || spec?.localPaths === undefined) return undefined;
  const p = (path ?? '').split('?')[0] ?? '';
  if (p === spec.localPaths.refresh) return 'refresh';
  if (p === spec.localPaths.revoke) return 'revoke';
  return undefined;
}

/** Headers to apply upstream for plain-Bearer providers (OpenAI, z.ai, OpenRouter): just Bearer SECRET (no anthropic-beta, no x-api-key). */
export function openaiAuthHeaders(secret) {
  return { authorization: `Bearer ${secret}` };
}

/** Outbound upstream path: the upstream's base path prefix + the inbound request path (query kept). */
export function upstreamPath(upstream, reqUrl) {
  const spec = UPSTREAMS[upstream];
  return `${spec?.basePath ?? ''}${reqUrl ?? '/'}`;
}

// --- Codex ChatGPT-plan credential isolation (#625/#638): the real auth.json never leaves the
// sidecar; the cell gets opaque placeholders plus a syntactically valid but unsigned id_token. ---

/**
 * The ONE destination a refresh grant may ever be sent to: a constant `https://` URL under the single
 * accepted issuer. Deliberately not configurable — no env override, no cell-supplied destination, and
 * (unlike upstream Codex, which follows `tokens.oauth_provenance.issuer`) no destination read out of
 * the credential itself, which would let a swapped-in auth.json redirect the real refresh token to a
 * host of its choosing. A credential recording a different issuer is refused instead — see
 * codexIssuerAccepted.
 */
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_REFRESH_URL = `${CODEX_ISSUER}/oauth/token`;

/** Whether the credential's recorded issuer is the one CODEX_REFRESH_URL belongs to (absent = accepted). */
export function codexIssuerAccepted(real) {
  const issuer = real?.tokens?.oauth_provenance?.issuer;
  return issuer === undefined || issuer === null || issuer === '' || issuer === CODEX_ISSUER;
}

/**
 * Wraps a refresh exchange so at most ONE runs at a time: a call arriving while an exchange is in
 * flight is handed that SAME promise instead of starting a second one, so the real refresh token is
 * never presented twice. The IdP rotates the token on every exchange and flags a second presentation
 * of a now-stale value as reuse, which permanently invalidates the credential (Q4 of the spike) — so
 * concurrent cell requests must wait for the one in-flight result rather than race it.
 */
export function serializeRefresh(exchange) {
  let pending = null;
  // `??=`: the first caller starts the exchange (via `then`, so a synchronous throw still rejects);
  // every caller arriving before the `finally` clears `pending` gets that same promise back.
  return () => (pending ??= Promise.resolve()
    .then(exchange)
    .finally(() => {
      pending = null;
    }));
}

/** Random opaque value, base64url-encoded — never a JWT, never tied to any real credential. */
export function randomOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * The non-secret claims copied out of the real id_token's payload, under OpenAI's auth claim
 * namespace (plan type, account id — never anything else). Best-effort: an unparseable or
 * differently-shaped id_token yields `{}` rather than throwing.
 */
export function chatgptClaims(realIdToken) {
  try {
    const parts = String(realIdToken ?? '').split('.');
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'];
    if (auth === null || typeof auth !== 'object') return {};
    const { chatgpt_account_id, chatgpt_plan_type } = auth;
    return {
      ...(chatgpt_account_id !== undefined ? { chatgpt_account_id } : {}),
      ...(chatgpt_plan_type !== undefined ? { chatgpt_plan_type } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * A syntactically valid (three base64url segments) but unsigned JWT carrying only the given claims.
 * Codex's auth.json loader requires this exact shape or the whole file fails to parse; the signature
 * segment is opaque random, never a real signature, so this token can never pass upstream verification.
 */
export function syntheticIdToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': claims }), 'utf8').toString('base64url');
  return `${header}.${payload}.${randomOpaqueToken(16)}`;
}

/** The real (non-secret) ChatGPT account id carried in auth.json, or '' when absent. */
export function chatgptAccountId(real) {
  const id = real?.tokens?.account_id;
  return typeof id === 'string' ? id : '';
}

/**
 * Headers to apply upstream for a ChatGPT-plan credential: the same Bearer shape as the other
 * providers, carrying the REAL access token (re-read per request, since it rotates on refresh), plus
 * the account routing header. Codex attaches that header itself when it holds the real credential;
 * inside the cell it authenticates with the nonce instead and skips it, so the sidecar re-adds it from
 * the real auth.json it holds (the account id is not secret).
 */
export function chatgptAuthHeaders(real) {
  const accountId = chatgptAccountId(real);
  return {
    ...openaiAuthHeaders(real?.tokens?.access_token),
    ...(accountId !== '' ? { 'chatgpt-account-id': accountId } : {}),
  };
}

/**
 * The ONLY fields copied from the real auth.json into the cell's placeholder — an allowlist, not a
 * blocklist: anything not named here (the legacy top-level OPENAI_API_KEY, oauth_provenance, a field
 * OpenAI adds in a later release, a field someone planted in the host's file) is left out rather than
 * carried into the sandbox by default. These are the non-secret fields Codex parses locally (Q3 of the
 * spike): `auth_mode` selects the ChatGPT code path, `last_refresh` drives the scheduled-refresh
 * fallback, and tokens.account_id / tokens.login_owner_id the account/workspace match.
 */
const PLACEHOLDER_FIELDS = ['auth_mode', 'last_refresh'];
const PLACEHOLDER_TOKEN_FIELDS = ['account_id', 'login_owner_id'];

/** The allowlisted subset of `source`: listed keys that are actually present, nothing else. */
function pickFields(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/**
 * The placeholder auth.json the cell gets: the allowlisted non-secret fields above, plus token values
 * that are all synthetic — access_token/refresh_token opaque random values, id_token a syntactic JWT
 * carrying only non-secret claims. No real token material, and no unlisted field, ever reaches it.
 */
export function placeholderChatgptAuth(real) {
  const tokens = real?.tokens ?? {};
  const claims = chatgptClaims(typeof tokens.id_token === 'string' ? tokens.id_token : '');
  return {
    ...pickFields(real ?? {}, PLACEHOLDER_FIELDS),
    tokens: {
      ...pickFields(tokens, PLACEHOLDER_TOKEN_FIELDS),
      id_token: syntheticIdToken(claims),
      access_token: randomOpaqueToken(),
      refresh_token: randomOpaqueToken(),
    },
  };
}

/**
 * The OAuth refresh-grant body the sidecar sends to CODEX_REFRESH_URL with the REAL refresh token —
 * built from the host-held auth.json, never from anything the cell sent (a cell-supplied body is
 * ignored entirely: Q4 of the spike, reuse detection permanently invalidates a token presented twice,
 * so only the sidecar may ever present the real refresh token). There is no revoke counterpart on
 * purpose: revoke is answered inside the sidecar and never forwarded, so the cell cannot invalidate
 * the host's credential.
 */
export function buildRefreshBody(real) {
  const clientId = real?.tokens?.oauth_provenance?.client_id;
  return {
    grant_type: 'refresh_token',
    refresh_token: real?.tokens?.refresh_token,
    ...(typeof clientId === 'string' && clientId !== '' ? { client_id: clientId } : {}),
    scope: 'openid profile email',
  };
}

/** The sidecar's in-memory real-auth state after a successful refresh: rotated tokens applied. */
export function applyRefreshResponse(real, upstreamJson) {
  const tokens = real?.tokens ?? {};
  const u = upstreamJson ?? {};
  return {
    ...real,
    tokens: {
      ...tokens,
      ...(typeof u.access_token === 'string' ? { access_token: u.access_token } : {}),
      ...(typeof u.refresh_token === 'string' ? { refresh_token: u.refresh_token } : {}),
      ...(typeof u.id_token === 'string' ? { id_token: u.id_token } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

/** Constant-time string compare (length-safe). */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of which arg differs, then return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
