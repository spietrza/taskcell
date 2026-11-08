import { describe, it, expect } from 'vitest';
import {
  mergeAnthropicBeta,
  filterAnthropicBeta,
  stripEgressTools,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  isAllowedLlmPath,
  constantTimeEqual,
  upstreamPath,
  UPSTREAMS,
  buildForwardHeaders,
  chatgptAuthHeaders,
  chatgptIdpRoute,
  readIdpRequest,
  buildSyntheticIdToken,
  placeholderRefreshResponse,
  CODEX_REFRESH_PATH,
  CODEX_REVOKE_PATH,
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
    expect(UPSTREAMS.openrouter.auth).toBe('bearer');
    expect(openaiAuthHeaders('sk-or')).toEqual({ authorization: 'Bearer sk-or' });
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
  it('prepends the Codex ChatGPT-plan backend path for the chatgpt upstream', () => {
    expect(upstreamPath('chatgpt', '/responses')).toBe('/backend-api/codex/responses');
  });
});

describe('isAllowedLlmPath (chatgpt)', () => {
  it('accepts only POST /responses', () => {
    expect(isAllowedLlmPath('POST', '/responses', 'chatgpt')).toBe(true);
    expect(isAllowedLlmPath('GET', '/responses', 'chatgpt')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/responses', 'chatgpt')).toBe(false);
    expect(isAllowedLlmPath('POST', CODEX_REFRESH_PATH, 'chatgpt')).toBe(false);
  });
});

describe('buildForwardHeaders', () => {
  it('overlays applied headers after copying inbound ones, replacing (not merging) a collision', () => {
    const headers = buildForwardHeaders(
      { 'content-type': 'application/json', 'chatgpt-account-id': 'forged-account-id', connection: 'keep-alive' },
      { authorization: 'Bearer real-token-value', 'chatgpt-account-id': 'real-account-id' },
    );
    expect(headers).toEqual({
      'content-type': 'application/json',
      'chatgpt-account-id': 'real-account-id',
      authorization: 'Bearer real-token-value',
    });
  });
  it('drops authorization, x-api-key, host and hop-by-hop headers from the inbound copy', () => {
    const headers = buildForwardHeaders(
      { authorization: 'Bearer forged', 'x-api-key': 'forged', host: 'cell-internal', 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
      {},
    );
    expect(headers).toEqual({ 'content-type': 'application/json' });
  });
  it('filters anthropic-beta the same way as before', () => {
    const headers = buildForwardHeaders({ 'anthropic-beta': 'mcp-client-2025-04-04,foo' }, {});
    expect(headers['anthropic-beta']).toBe('foo');
  });
});

describe('chatgptAuthHeaders', () => {
  it('returns the real access token as Bearer plus the real chatgpt-account-id', () => {
    const accessToken = 'x'.repeat(40);
    expect(chatgptAuthHeaders(accessToken, 'acct_real123')).toEqual({
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': 'acct_real123',
    });
  });
  it('a forged inbound chatgpt-account-id never survives the overlay', () => {
    const accessToken = 'y'.repeat(40);
    const applied = chatgptAuthHeaders(accessToken, 'acct_real123');
    const headers = buildForwardHeaders({ 'chatgpt-account-id': 'acct_forged', authorization: 'Bearer placeholder-nonce' }, applied);
    expect(headers['chatgpt-account-id']).toBe('acct_real123');
    expect(headers.authorization).toBe(`Bearer ${accessToken}`);
  });
});

describe('chatgptIdpRoute', () => {
  it('recognizes the refresh and revoke paths by POST only', () => {
    expect(chatgptIdpRoute('POST', CODEX_REFRESH_PATH)).toBe('refresh');
    expect(chatgptIdpRoute('POST', CODEX_REVOKE_PATH)).toBe('revoke');
    expect(chatgptIdpRoute('GET', CODEX_REFRESH_PATH)).toBeUndefined();
    expect(chatgptIdpRoute('POST', '/responses')).toBeUndefined();
    expect(chatgptIdpRoute('POST', undefined)).toBeUndefined();
  });
  it('ignores the query string', () => {
    expect(chatgptIdpRoute('POST', `${CODEX_REFRESH_PATH}?x=1`)).toBe('refresh');
  });
});

describe('readIdpRequest', () => {
  it('reads the named credential field out of a JSON body', () => {
    const placeholder = 'p'.repeat(32);
    const body = Buffer.from(JSON.stringify({ grant_type: 'refresh_token', refresh_token: placeholder }));
    expect(readIdpRequest(body, 'refresh_token')).toEqual({ credential: placeholder, parsed: { grant_type: 'refresh_token', refresh_token: placeholder } });
  });
  it('reads the revoke field name (token) separately from the refresh field (refresh_token)', () => {
    const placeholder = 'q'.repeat(32);
    const body = Buffer.from(JSON.stringify({ token: placeholder, token_type_hint: 'refresh_token' }));
    expect(readIdpRequest(body, 'token')?.credential).toBe(placeholder);
    expect(readIdpRequest(body, 'refresh_token')).toBeUndefined();
  });
  it('returns undefined for malformed JSON, non-objects, or a missing/empty/non-string field', () => {
    expect(readIdpRequest(Buffer.from('not json'), 'refresh_token')).toBeUndefined();
    expect(readIdpRequest(Buffer.from('[1,2]'), 'refresh_token')).toBeUndefined();
    expect(readIdpRequest(Buffer.from('{}'), 'refresh_token')).toBeUndefined();
    expect(readIdpRequest(Buffer.from(JSON.stringify({ refresh_token: '' })), 'refresh_token')).toBeUndefined();
    expect(readIdpRequest(Buffer.from(JSON.stringify({ refresh_token: 42 })), 'refresh_token')).toBeUndefined();
  });
});

describe('buildSyntheticIdToken', () => {
  it('produces a three-segment, base64url-decodable JWT shape carrying only account id + plan type', () => {
    const token = buildSyntheticIdToken('acct_real123', 'pro');
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    for (const seg of segments) expect(seg.length).toBeGreaterThan(0);
    const payload = JSON.parse(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'));
    expect(payload).toEqual({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_real123', chatgpt_plan_type: 'pro' } });
  });
  it('never embeds a real-looking secret value — only the two non-secret claims', () => {
    const token = buildSyntheticIdToken('acct_real123', 'pro');
    expect(token).not.toContain('access_token');
    expect(token).not.toContain('refresh_token');
  });
});

describe('placeholderRefreshResponse', () => {
  it('returns only placeholders plus a synthetic id_token — never the real tokens', () => {
    const realAccessToken = 'r'.repeat(40);
    const realRefreshToken = 's'.repeat(40);
    const accessPlaceholder = 'nonce-placeholder';
    const refreshPlaceholder = 'refresh-placeholder';
    const response = placeholderRefreshResponse(accessPlaceholder, refreshPlaceholder, 'acct_real123', 'pro');
    expect(response.access_token).toBe(accessPlaceholder);
    expect(response.refresh_token).toBe(refreshPlaceholder);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(realAccessToken);
    expect(serialized).not.toContain(realRefreshToken);
    const idPayload = JSON.parse(Buffer.from(response.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    expect(idPayload).toEqual({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_real123', chatgpt_plan_type: 'pro' } });
  });
});
