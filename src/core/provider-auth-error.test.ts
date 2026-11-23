import { describe, it, expect } from 'vitest';
import { AgentError, formatFailureComment, isProviderAuthError, isProviderLimitError } from './errors.js';

const AUTH = [
  'claude exited 1: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  'Claude: OAuth token has expired. Please run /login',
  'POST /v1/messages -> 401 (3ms)',
  'codex: unexpected status 401 Unauthorized: Missing bearer',
  'Error: invalid_api_key — Incorrect API key provided',
  'the ChatGPT sign-in was refused: the refresh token was revoked. Sign in again (codex login)',
  '{"error":{"code":"refresh_token_reused"}}',
  'cursor-agent: Not logged in. Run cursor-agent login',
  'cursor-agent error: Unauthorized',
  'the Claude credential was refused (expired or revoked)',
  'HTTP 403 Forbidden',
];
const NOT_AUTH = [
  "You've hit your session limit · resets 9pm (UTC)",
  'rate_limit_error: 429 too many requests',
  'Claude AI usage limit reached|1762722000',
  'ECONNRESET: socket hang up',
  'getaddrinfo ENOTFOUND api.anthropic.com',
  'the diff mentions 401 in a stack frame at line 403',
];

describe('isProviderAuthError', () => {
  it.each(AUTH)('matches %s', (m) => expect(isProviderAuthError(new AgentError(m))).toBe(true));
  it.each(NOT_AUTH)('does not match %s', (m) => expect(isProviderAuthError(new AgentError(m))).toBe(false));
  it('does not overlap limit errors', () => {
    for (const m of AUTH) expect(isProviderLimitError(new AgentError(m))).toBe(false);
  });
});

describe('formatFailureComment auth headline', () => {
  it('names the refused Claude credential', () => {
    const out = formatFailureComment('Taskcell run failed', new AgentError('API Error: 401 authentication_error'));
    expect(out).toContain('the Claude credential (CLAUDE_CODE_OAUTH_TOKEN) was refused — expired or revoked; refresh the secret and re-apply the trigger label');
  });
  it('names Codex', () => {
    expect(formatFailureComment('x', new AgentError('codex: refresh_token_expired'))).toContain('CODEX_AUTH_JSON');
  });
  it('leaves limit wording unchanged', () => {
    expect(formatFailureComment('x', new AgentError("You've hit your session limit"))).toContain('usage/rate limit');
  });
});
