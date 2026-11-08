// Type declarations for the plain-ESM `llm-proxy-rewrite.mjs` so the strict-TS app keeps types.
export type Upstream = 'anthropic' | 'openai' | 'zai' | 'openrouter' | 'chatgpt';
export type UpstreamAuth = { mode: 'subscription'; secret: string } | { mode: 'api'; secret: string };

/** One upstream's wiring: forward host, allowed POST paths, auth scheme, and optional base path prefix. */
export interface UpstreamSpec {
  host: string;
  paths: readonly string[];
  auth: 'anthropic' | 'bearer' | 'chatgpt';
  basePath?: string;
}

/** Single source of truth for every proxiable upstream, keyed by the secret file's UPSTREAM value. */
export declare const UPSTREAMS: Record<Upstream, UpstreamSpec>;

/** Hop-by-hop headers dropped from every forwarded request (shared with buildForwardHeaders). */
export declare const HOP_BY_HOP: ReadonlySet<string>;

export declare const OAUTH_BETA: 'oauth-2025-04-20';

/** The request's anthropic-beta minus blocked (egress-capable) feature families; undefined when none remain. */
export declare function filterAnthropicBeta(incoming: string | string[] | undefined): string | undefined;

/** The body minus egress-capable server tools (web_fetch*, code_execution*, mcp*) and `mcp_servers`; same Buffer when unchanged. */
export declare function stripEgressTools(body: Buffer): Buffer;

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export declare function mergeAnthropicBeta(incoming: string | string[] | undefined, extra: string): string;

/**
 * Headers to apply upstream for the chosen auth mode. Subscription => Authorization: Bearer + oauth beta
 * merged; api => x-api-key, no oauth beta.
 */
export declare function upstreamAuthHeaders(
  auth: UpstreamAuth,
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string>;

/**
 * Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored).
 * anthropic => /v1/messages, /v1/messages/count_tokens. openai => /v1/responses only.
 * zai/openrouter => same paths as anthropic (Anthropic-compatible upstreams). Defaults to anthropic.
 */
export declare function isAllowedLlmPath(method: string, path: string, upstream?: Upstream): boolean;

/** Headers to apply upstream for plain-Bearer providers (OpenAI, z.ai, OpenRouter): just Bearer SECRET (no anthropic-beta, no x-api-key). */
export declare function openaiAuthHeaders(secret: string): Record<string, string>;

/** Outbound upstream path: the upstream's base path prefix + the inbound request path (query kept). */
export declare function upstreamPath(upstream: Upstream, reqUrl: string | undefined): string;

/** Constant-time string compare (length-safe). */
export declare function constantTimeEqual(a: string, b: string): boolean;

/** Inbound headers rewritten for forwarding: hop-by-hop/auth/host dropped, beta filtered, then `applied` overlaid (replacing any inbound value for the same header). */
export declare function buildForwardHeaders(
  reqHeaders: Record<string, string | string[] | undefined>,
  applied: Record<string, string>,
): Record<string, string | string[]>;

/** Headers to apply upstream for the chatgpt-plan model-call auth: real access token Bearer + the host's real chatgpt-account-id. */
export declare function chatgptAuthHeaders(accessToken: string, accountId: string): Record<string, string>;

/** The real Codex CLI's public OAuth client id. */
export declare const CODEX_CLIENT_ID: string;

/** Path CODEX_REFRESH_TOKEN_URL_OVERRIDE is pointed at. */
export declare const CODEX_REFRESH_PATH: string;
/** Path CODEX_REVOKE_TOKEN_URL_OVERRIDE is pointed at. */
export declare const CODEX_REVOKE_PATH: string;

/** Which chatgpt-plan IdP route (if any) this request targets; undefined for anything else. */
export declare function chatgptIdpRoute(method: string, path: string | undefined): 'refresh' | 'revoke' | undefined;

/** Parses a refresh/revoke JSON body and reads the credential under `field`; undefined if malformed/missing. */
export declare function readIdpRequest(body: Buffer, field: string): string | undefined;

/** A three-segment JWT-shaped id_token carrying only the account id + plan type claims. */
export declare function buildSyntheticIdToken(accountId: string, planType: string): string;

/** The refresh response handed back to the cell: placeholders + a freshly built synthetic id_token. */
export declare function placeholderRefreshResponse(
  accessPlaceholder: string,
  refreshPlaceholder: string,
  accountId: string,
  planType: string,
): { access_token: string; refresh_token: string; id_token: string };
