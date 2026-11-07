import { describe, it, expect } from 'vitest';
import {
  mergeAnthropicBeta,
  filterAnthropicBeta,
  stripEgressTools,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  isAllowedLlmPath,
  isLocalAuthPath,
  constantTimeEqual,
  upstreamPath,
  UPSTREAMS,
  chatgptClaims,
  syntheticIdToken,
  chatgptAccountId,
  chatgptAuthHeaders,
  codexIssuerAccepted,
  serializeRefresh,
  placeholderChatgptAuth,
  buildRefreshBody,
  applyRefreshResponse,
  CODEX_ISSUER,
  type CodexAuthJson,
} from './llm-proxy-rewrite.mjs';

describe('mergeAnthropicBeta', () => {
  it('appends the oauth beta and dedupes, preserving request betas', () => {
    expect(mergeAnthropicBeta('foo-1,bar-2', 'oauth-2025-04-20')).toBe('foo-1,bar-2,oauth-2025-04-20');
    expect(mergeAnthropicBeta('oauth-2025-04-20,foo', 'oauth-2025-04-20')).toBe('oauth-2025-04-20,foo');
    expect(mergeAnthropicBeta(undefined, 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
  it('drops empty/whitespace segments', () => {
    expect(mergeAnthropicBeta('foo,,bar', 'oauth-2025-04-20')).toBe('foo,bar,oauth-2025-04-20');
    expect(mergeAnthropicBeta(' , ', 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
  it('coerces an array input to a comma-joined string', () => {
    expect(mergeAnthropicBeta(['foo', 'bar'], 'oauth-2025-04-20')).toBe('foo,bar,oauth-2025-04-20');
    expect(mergeAnthropicBeta(['oauth-2025-04-20'], 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
});

describe('filterAnthropicBeta', () => {
  it('keeps the betas Claude Code sends for normal runs', () => {
    const cc = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24';
    expect(filterAnthropicBeta(cc)).toBe(cc);
  });
  it('drops egress-capable families, including re-dated and mixed-case variants', () => {
    expect(filterAnthropicBeta('mcp-client-2025-04-04,foo,web-fetch-2025-09-10,Files-API-2025-04-14,code-execution-2099-01-01')).toBe('foo');
    expect(filterAnthropicBeta(['mcp-servers-2025-12-04', 'skills-2025-10-02'])).toBeUndefined();
  });
  it('prefix-matches families on whole segments: extended and undated variants are dropped', () => {
    expect(filterAnthropicBeta('code-execution-web-tools-2026-01-01,mcp,skills-extra,web-fetch,foo')).toBe('foo');
    // A different word that only starts with the same letters is not the family.
    expect(filterAnthropicBeta('mcpx-2026-01-01,ccrypto')).toBe('mcpx-2026-01-01,ccrypto');
  });
  it('keeps every beta the current Claude Code release ships outside the blocked families', () => {
    const cc = 'advanced-tool-use-2025-11-20,context-1m-2025-08-07,structured-outputs-2025-12-15,tool-search-tool-2025-10-19,web-search-2025-03-05,redact-thinking-2026-02-12';
    expect(filterAnthropicBeta(cc)).toBe(cc);
  });
  it('blocked betas never reach the upstream in either auth mode', () => {
    const req = { 'anthropic-beta': 'mcp-client-2025-04-04,foo' };
    expect(upstreamAuthHeaders({ mode: 'subscription', secret: 'oat' }, req)['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    expect(upstreamAuthHeaders({ mode: 'api', secret: 'sk' }, req)['anthropic-beta']).toBe('foo');
    expect('anthropic-beta' in upstreamAuthHeaders({ mode: 'api', secret: 'sk' }, { 'anthropic-beta': 'web-fetch-2025-09-10' })).toBe(false);
  });
});

describe('stripEgressTools', () => {
  const json = (b: Buffer): unknown => JSON.parse(b.toString('utf8'));
  it('drops web_fetch / code_execution / mcp server tools and mcp_servers, keeps web_search and client tools', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'm',
      mcp_servers: [{ type: 'url', url: 'https://evil.example/mcp' }],
      tools: [
        { name: 'Bash', input_schema: {} },
        { type: 'web_search_20250305', name: 'web_search' },
        { type: 'web_fetch_20250910', name: 'web_fetch' },
        { type: 'code_execution_20250825', name: 'code_execution' },
        { type: 'mcp_toolset', mcp_server_name: 'x' },
      ],
    }));
    expect(json(stripEgressTools(body))).toEqual({
      model: 'm',
      tools: [{ name: 'Bash', input_schema: {} }, { type: 'web_search_20250305', name: 'web_search' }],
    });
  });
  it('returns the same buffer when nothing needs stripping or the body is not a JSON object', () => {
    const plain = Buffer.from('{"model":"m","tools":[{"name":"Read"}]}');
    expect(stripEgressTools(plain)).toBe(plain);
    const junk = Buffer.from('not json');
    expect(stripEgressTools(junk)).toBe(junk);
    const arr = Buffer.from('[1]');
    expect(stripEgressTools(arr)).toBe(arr);
  });
});

describe('upstreamAuthHeaders', () => {
  it('subscription: Bearer + merged oauth beta, drops x-api-key', () => {
    const h = upstreamAuthHeaders({ mode: 'subscription', secret: 'oat' }, { 'anthropic-beta': 'foo' });
    expect(h.authorization).toBe('Bearer oat');
    expect(h['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    expect('x-api-key' in h).toBe(false);
  });
  it('api: x-api-key, no oauth beta, no authorization', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, { 'anthropic-beta': 'foo' });
    expect(h['x-api-key']).toBe('sk-ant');
    expect('authorization' in h).toBe(false);
    expect(h['anthropic-beta']).toBe('foo'); // unchanged in api mode
  });
  it('api: omits anthropic-beta when the request has none', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, {});
    expect(h['x-api-key']).toBe('sk-ant');
    expect('anthropic-beta' in h).toBe(false);
    expect('authorization' in h).toBe(false);
  });
});

describe('isAllowedLlmPath', () => {
  it('allows only the two messages endpoints by POST', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true')).toBe(true); // query allowed
    expect(isAllowedLlmPath('GET', '/v1/messages')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/complete')).toBe(false);
  });

  it('defaults to anthropic when no upstream arg is given', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'anthropic')).toBe(isAllowedLlmPath('POST', '/v1/messages'));
    expect(isAllowedLlmPath('POST', '/v1/responses')).toBe(false); // anthropic default rejects responses
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
  });

  it('openai: allows only POST /v1/responses (query ignored)', () => {
    expect(isAllowedLlmPath('POST', '/v1/responses', 'openai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/responses?x=1', 'openai')).toBe(true);
    expect(isAllowedLlmPath('GET', '/v1/responses', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/messages', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/chat/completions', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models', 'openai')).toBe(false);
  });
});

describe('openaiAuthHeaders', () => {
  it('returns only a Bearer authorization header', () => {
    const h = openaiAuthHeaders('sk-openai');
    expect(h.authorization).toBe('Bearer sk-openai');
    expect('anthropic-beta' in h).toBe(false);
    expect('x-api-key' in h).toBe(false);
    expect(Object.keys(h)).toEqual(['authorization']);
  });

  it('presents the OpenRouter key as a plain Bearer header (openrouter upstream authenticates by bearer)', () => {
    expect(UPSTREAMS.openrouter.authKind).toBe('bearer');
    expect(openaiAuthHeaders('sk-or')).toEqual({ authorization: 'Bearer sk-or' });
  });
});

describe('codex-chatgpt upstream wiring', () => {
  it('routes model calls to the chatgpt.com codex backend only, by POST', () => {
    expect(isAllowedLlmPath('POST', '/backend-api/codex/responses', 'codex-chatgpt')).toBe(true);
    expect(isAllowedLlmPath('GET', '/backend-api/codex/responses', 'codex-chatgpt')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/responses', 'codex-chatgpt')).toBe(false);
  });

  it('terminates refresh/revoke locally instead of forwarding them, and only for codex-chatgpt', () => {
    expect(isLocalAuthPath('POST', '/oauth/token', 'codex-chatgpt')).toBe('refresh');
    expect(isLocalAuthPath('POST', '/oauth/revoke', 'codex-chatgpt')).toBe('revoke');
    expect(isLocalAuthPath('GET', '/oauth/token', 'codex-chatgpt')).toBeUndefined();
    expect(isLocalAuthPath('POST', '/oauth/token', 'openai')).toBeUndefined();
    expect(isAllowedLlmPath('POST', '/oauth/token', 'codex-chatgpt')).toBe(false); // not forwarded upstream
  });
});

// The token fields these tests read back off an auth.json: the `.d.mts` types `tokens` as loose JSON,
// so assert it is present and narrow it here rather than reading `unknown` per field.
type ChatgptTokens = { id_token: string; access_token: string; refresh_token: string; account_id: string };
function tokensOf(auth: CodexAuthJson): ChatgptTokens {
  expect(auth.tokens).toBeDefined();
  return auth.tokens as ChatgptTokens;
}

describe('Codex ChatGPT-plan placeholder credential', () => {
  const realIdToken = syntheticIdToken({ chatgpt_account_id: 'acct-real', chatgpt_plan_type: 'pro' });
  const real = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: realIdToken,
      access_token: 'real-access-token-value-xyz',
      refresh_token: 'real-refresh-token-value-xyz',
      account_id: 'acct-real',
      oauth_provenance: { client_id: 'client-abc' },
    },
    last_refresh: '2020-01-01T00:00:00.000Z',
    OPENAI_API_KEY: 'legacy-should-be-dropped',
  };

  it('extracts only plan type and account id from the real id_token', () => {
    expect(chatgptClaims(realIdToken)).toEqual({ chatgpt_account_id: 'acct-real', chatgpt_plan_type: 'pro' });
    expect(chatgptClaims('not-a-jwt')).toEqual({});
    expect(chatgptClaims(undefined)).toEqual({});
  });

  it('builds a three-segment, base64url-decodable synthetic JWT', () => {
    const token = syntheticIdToken({ chatgpt_account_id: 'a', chatgpt_plan_type: 'plus' });
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    for (const s of segments) expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'));
    expect(payload['https://api.openai.com/auth']).toEqual({ chatgpt_account_id: 'a', chatgpt_plan_type: 'plus' });
  });

  it('placeholderChatgptAuth replaces every token field, carries no real secret, and drops the legacy key field', () => {
    const placeholder = placeholderChatgptAuth(real);
    const tokens = tokensOf(placeholder);
    expect(tokens.access_token).not.toBe(real.tokens.access_token);
    expect(tokens.refresh_token).not.toBe(real.tokens.refresh_token);
    expect(tokens.id_token).not.toBe(real.tokens.id_token);
    expect(tokens.id_token.split('.')).toHaveLength(3);
    expect(JSON.stringify(placeholder)).not.toContain('real-access-token-value-xyz');
    expect(JSON.stringify(placeholder)).not.toContain('real-refresh-token-value-xyz');
    expect(JSON.stringify(placeholder)).not.toContain('legacy-should-be-dropped');
    // Non-secret fields pass through unchanged.
    expect(tokens.account_id).toBe('acct-real');
    expect(chatgptAccountId(real)).toBe('acct-real');
  });

  it('buildRefreshBody carries the real refresh token and provenance client id, never the access token', () => {
    const refreshBody = buildRefreshBody(real);
    expect(refreshBody).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'real-refresh-token-value-xyz', client_id: 'client-abc' });
    expect(JSON.stringify(refreshBody)).not.toContain('real-access-token-value-xyz');
  });

  it('chatgptAuthHeaders presents the real access token as Bearer plus the account routing header', () => {
    expect(chatgptAuthHeaders(real)).toEqual({
      authorization: 'Bearer real-access-token-value-xyz',
      'chatgpt-account-id': 'acct-real',
    });
    // No account id recorded → no routing header at all (never an empty one).
    expect(chatgptAuthHeaders({ tokens: { access_token: 'at' } })).toEqual({ authorization: 'Bearer at' });
  });

  it('codexIssuerAccepted accepts the one real issuer (or none recorded) and refuses any other', () => {
    expect(codexIssuerAccepted(real)).toBe(true); // provenance without an issuer field
    expect(codexIssuerAccepted({ tokens: { oauth_provenance: { issuer: CODEX_ISSUER } } })).toBe(true);
    expect(codexIssuerAccepted({ tokens: { oauth_provenance: { issuer: '' } } })).toBe(true);
    expect(codexIssuerAccepted({ tokens: { oauth_provenance: { issuer: 'https://evil.example' } } })).toBe(false);
  });

  it('serializeRefresh runs one exchange at a time: concurrent callers share the in-flight promise', async () => {
    let calls = 0;
    const once = serializeRefresh(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return calls;
    });
    const first = once();
    expect(once()).toBe(first); // the very same promise — never a second presentation of the token
    expect(await Promise.all([first, once()])).toEqual([1, 1]);
    expect(calls).toBe(1);
    // Settled → the next caller starts a fresh exchange.
    expect(await once()).toBe(2);
  });

  it('applyRefreshResponse rotates the stored real tokens from the upstream response', () => {
    const rotated = applyRefreshResponse(real, { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new.id.token' });
    const tokens = tokensOf(rotated);
    expect(tokens.access_token).toBe('new-access');
    expect(tokens.refresh_token).toBe('new-refresh');
    expect(tokens.id_token).toBe('new.id.token');
    expect(tokens.account_id).toBe('acct-real'); // untouched
  });
});

describe('isAllowedLlmPath (zai)', () => {
  it('accepts the anthropic-compatible paths z.ai serves and rejects the rest', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'zai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens', 'zai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true', 'zai')).toBe(true);
    // z.ai is not OpenAI-Responses-compatible.
    expect(isAllowedLlmPath('POST', '/v1/responses', 'zai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/chat/completions', 'zai')).toBe(false);
    expect(isAllowedLlmPath('GET', '/v1/messages', 'zai')).toBe(false);
  });
});

describe('isAllowedLlmPath (openrouter)', () => {
  it('accepts the Anthropic-compatible paths OpenRouter serves and rejects the rest', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'openrouter')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens', 'openrouter')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/responses', 'openrouter')).toBe(false);
    expect(isAllowedLlmPath('GET', '/v1/messages', 'openrouter')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others without leaking length via early return', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('upstreamPath', () => {
  it('prepends the z.ai Coding-Plan base path for the zai upstream', () => {
    expect(upstreamPath('zai', '/v1/messages')).toBe('/api/coding/paas/v4/v1/messages');
  });
  it('prepends the OpenRouter Anthropic-skin base path for the openrouter upstream', () => {
    expect(upstreamPath('openrouter', '/v1/messages')).toBe('/api/v1/messages');
  });
  it('preserves query strings when prepending', () => {
    expect(upstreamPath('zai', '/v1/messages?beta=1')).toBe('/api/coding/paas/v4/v1/messages?beta=1');
  });
  it('passes through the path unchanged for anthropic (no base path)', () => {
    expect(upstreamPath('anthropic', '/v1/messages')).toBe('/v1/messages');
  });
  it('falls back to base path + "/" when reqUrl is undefined', () => {
    expect(upstreamPath('zai', undefined)).toBe('/api/coding/paas/v4/');
  });
});
