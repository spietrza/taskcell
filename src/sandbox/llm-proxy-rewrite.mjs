// Pure rewrite/lockdown logic for the host LLM reverse-proxy sidecar.
// Authored as plain ESM `.mjs` so BOTH the strict-TS app and the zero-dep sidecar
// (`llm-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `llm-proxy-rewrite.d.mts`. The sidecar gets this file
// `docker cp`'d next to it so the relative `import './llm-proxy-rewrite.mjs'` resolves.
import { timingSafeEqual } from 'node:crypto';

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

// Hop-by-hop headers must not be forwarded to any upstream. Shared with llm-proxy-server.mjs (and
// with buildForwardHeaders below) so the list lives in exactly one place.
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Parses `text` as JSON, returning it only when the result is a plain object (not null/array/etc); undefined otherwise. */
function parseJsonObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
}

/**
 * The request body with egress-capable server tools removed from `tools[]` and the MCP-connector
 * `mcp_servers` parameter dropped. Returns the input Buffer untouched when there is nothing to strip or
 * it is not a JSON object (the upstream rejects a malformed body itself).
 */
export function stripEgressTools(body) {
  const parsed = parseJsonObject(body.toString('utf8'));
  if (parsed === undefined) return body;
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
 * Inbound request headers rewritten for forwarding upstream: hop-by-hop + authorization + x-api-key +
 * host dropped, anthropic-beta filtered, then `applied` overlaid on top — so any inbound value for a
 * header `applied` also sets (e.g. a cell-forged `chatgpt-account-id`) is REPLACED, never merged or
 * left in place. Keys in `applied` are expected already-lowercase.
 */
export function buildForwardHeaders(reqHeaders, applied) {
  const headers = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'host') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'anthropic-beta') {
      const beta = filterAnthropicBeta(value);
      if (beta !== undefined) headers[lower] = beta;
      continue;
    }
    if (value !== undefined) headers[lower] = value;
  }
  for (const [key, value] of Object.entries(applied)) headers[key] = value;
  return headers;
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
 * (UPSTREAMS[k].host), POST-path lockdown (.paths), auth scheme (.auth), and boot validation (`k in UPSTREAMS`).
 *
 * - host:  where the sidecar forwards (and the host dropped from the sandbox egress allowlist).
 * - paths: the ONLY POST paths tunnelled through (query string ignored, no wildcards) — the lockdown.
 * - auth:  how the real credential is presented upstream. 'anthropic' = mode-aware x-api-key OR
 *          Bearer+oauth-beta (upstreamAuthHeaders). 'bearer' = plain Authorization: Bearer SECRET
 *          (openaiAuthHeaders). z.ai/OpenRouter are Anthropic-Messages-compatible on the WIRE (same
 *          paths) but authenticate with plain bearer keys, so they pair anthropic paths with bearer auth.
 */
export const UPSTREAMS = {
  anthropic: { host: 'api.anthropic.com', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'anthropic' },
  openai: { host: 'api.openai.com', paths: ['/v1/responses'], auth: 'bearer' },
  // basePath: keep in sync with ZAI_BASE_URL in src/agents/zai.ts
  zai: { host: 'api.z.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'bearer', basePath: '/api/coding/paas/v4' },
  // basePath: keep in sync with OPENROUTER_BASE_URL in src/agents/openrouter.ts
  openrouter: { host: 'openrouter.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'bearer', basePath: '/api' },
  // Codex ChatGPT-plan model calls. host+basePath mirror CHATGPT_CODEX_BASE_URL
  // (chatgpt.com/backend-api/codex, see docs/research/codex-credential-isolation.md Q1); the inbound
  // path is bare /responses (wire_api="responses"), matching how the 'openai' entry's /v1/responses
  // is reached relative to its own base_url.
  chatgpt: { host: 'chatgpt.com', paths: ['/responses'], auth: 'chatgpt', basePath: '/backend-api/codex' },
};

/** Request path with the query string stripped. */
function pathOnly(path) {
  return (path ?? '').split('?')[0] ?? '';
}

/** Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored). */
export function isAllowedLlmPath(method, path, upstream = 'anthropic') {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  const spec = UPSTREAMS[upstream];
  if (spec === undefined) return false;
  return spec.paths.includes(pathOnly(path));
}

/** Headers to apply upstream for plain-Bearer providers (OpenAI, z.ai, OpenRouter): just Bearer SECRET (no anthropic-beta, no x-api-key). */
export function openaiAuthHeaders(secret) {
  return { authorization: `Bearer ${secret}` };
}

/**
 * Headers to apply upstream for the chatgpt-plan model-call auth: the host's real access token as
 * Bearer, and the host's real chatgpt-account-id — ALWAYS this value. Combined with
 * buildForwardHeaders (which overlays these AFTER copying the cell's inbound headers), a forged
 * inbound `chatgpt-account-id` is replaced, never merged.
 */
export function chatgptAuthHeaders(accessToken, accountId) {
  return { authorization: `Bearer ${accessToken}`, 'chatgpt-account-id': accountId };
}

// The real Codex CLI's registered OAuth client id (public, not a secret — it identifies the
// application, the same way a User-Agent would) used when the sidecar talks to the real IdP.
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// Paths CODEX_REFRESH_TOKEN_URL_OVERRIDE / CODEX_REVOKE_TOKEN_URL_OVERRIDE will be pointed at,
// mirroring the real https://auth.openai.com/oauth/token and /oauth/revoke endpoints they replace.
export const CODEX_REFRESH_PATH = '/oauth/token';
export const CODEX_REVOKE_PATH = '/oauth/revoke';

/**
 * Which chatgpt-plan IdP route (if any) this request targets; undefined for anything else. These
 * routes exist only when the upstream's auth style is 'chatgpt' — the caller gates on that before
 * using the result. Unlike the model-call path, the Codex client sends no nonce header here, so
 * these never go through the Authorization-header check.
 */
export function chatgptIdpRoute(method, path) {
  if ((method ?? '').toUpperCase() !== 'POST') return undefined;
  const p = pathOnly(path);
  if (p === CODEX_REFRESH_PATH) return 'refresh';
  if (p === CODEX_REVOKE_PATH) return 'revoke';
  return undefined;
}

/**
 * Parses a refresh/revoke JSON request body and reads the credential it carries under `field`
 * (`refresh_token` for the /oauth/token grant, `token` for the /oauth/revoke request — RFC 7009).
 * Returns undefined when the body isn't a JSON object or the field is missing/empty/non-string; the
 * caller treats that exactly like a wrong credential (401), never a different error path. ONLY the
 * credential is returned, never the parsed body: nothing the cell sends may reach the real IdP, and
 * the refresh body the sidecar sends upstream is built from fixed fields instead.
 */
export function readIdpRequest(body, field) {
  const parsed = parseJsonObject(body.toString('utf8'));
  if (parsed === undefined) return undefined;
  const credential = parsed[field];
  if (typeof credential !== 'string' || credential === '') return undefined;
  return credential;
}

/** Base64url-encode a JSON-serializable value (one JWT segment). */
function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * A three-segment JWT-shaped id_token carrying only non-secret claims (account id, plan type) — the
 * real id_token never reaches the cell. Codex's auth.json loader requires three non-empty,
 * base64url-decodable, dot-separated segments but never verifies the signature (see
 * docs/research/codex-credential-isolation.md Q3/Q5), so the signature segment is a non-empty
 * placeholder rather than a real one.
 */
export function buildSyntheticIdToken(accountId, planType) {
  const header = base64urlJson({ alg: 'none', typ: 'JWT' });
  const payload = base64urlJson({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: planType } });
  const signature = base64urlJson({ vanguard: 'placeholder' });
  return `${header}.${payload}.${signature}`;
}

/**
 * The refresh response handed back to the cell: the SAME placeholders it already holds (the
 * model-call nonce as access_token, the run-bound refresh-binding value, both unchanged) plus a
 * freshly built synthetic id_token. The real access/refresh/id tokens never appear here.
 */
export function placeholderRefreshResponse(accessPlaceholder, refreshPlaceholder, accountId, planType) {
  return {
    access_token: accessPlaceholder,
    refresh_token: refreshPlaceholder,
    id_token: buildSyntheticIdToken(accountId, planType),
  };
}

/** Outbound upstream path: the upstream's base path prefix + the inbound request path (query kept). */
export function upstreamPath(upstream, reqUrl) {
  const spec = UPSTREAMS[upstream];
  return `${spec?.basePath ?? ''}${reqUrl ?? '/'}`;
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
