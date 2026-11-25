import { describe, it, expect } from 'vitest';
import { injectedSecretValues } from '../core/secret-scan.js';
import { tokenRotationFor } from './token-rotation.js';
import { subscriptionTokens, llmProxyAuth, authSecrets, authFromEnv, agentAuthFromEnv, refuseLlmProxyWithoutPrimarySidecar, SUBSCRIPTION_ENV, API_ENV } from './auth.js';
import { CliUsageError } from '../core/errors.js';

describe('authSecrets', () => {
  it('forwards only the OAuth token in subscription mode', () => {
    expect(authSecrets({ mode: 'subscription', token: 't' })).toEqual({ [SUBSCRIPTION_ENV]: 't' });
  });

  it('forwards only the API key in api mode', () => {
    expect(authSecrets({ mode: 'api', apiKey: 'k' })).toEqual({ [API_ENV]: 'k' });
  });
});

describe('authFromEnv', () => {
  it('prefers the subscription token when both are set', () => {
    expect(authFromEnv({ [SUBSCRIPTION_ENV]: 't', [API_ENV]: 'k' })).toEqual({ mode: 'subscription', token: 't' });
  });

  it('falls back to the API key', () => {
    expect(authFromEnv({ [API_ENV]: 'k' })).toEqual({ mode: 'api', apiKey: 'k' });
  });

  it('returns undefined when neither is set', () => {
    expect(authFromEnv({})).toBeUndefined();
  });
});

describe('agentAuthFromEnv', () => {
  it('resolves the z.ai key as an api-mode auth for --provider zai (no Anthropic token needed)', () => {
    expect(agentAuthFromEnv({ provider: 'zai' }, { ZAI_API_KEY: 'z-key' })).toEqual({ mode: 'api', apiKey: 'z-key' });
  });

  it('resolves the OpenRouter key as an api-mode auth for --provider openrouter (no Anthropic token needed)', () => {
    expect(agentAuthFromEnv({ provider: 'openrouter' }, { OPENROUTER_API_KEY: 'or-key' })).toEqual({
      mode: 'api',
      apiKey: 'or-key',
    });
  });

  it('throws when ZAI_API_KEY is missing for zai', () => {
    expect(() => agentAuthFromEnv({ provider: 'zai' }, {})).toThrow(/ZAI_API_KEY/);
  });

  it('throws when OPENROUTER_API_KEY is missing for openrouter', () => {
    expect(() => agentAuthFromEnv({ provider: 'openrouter' }, {})).toThrow(/OPENROUTER_API_KEY/);
  });

  it('falls back to Anthropic auth for non-zai providers', () => {
    expect(agentAuthFromEnv({ provider: 'claude' }, { [API_ENV]: 'k' })).toEqual({ mode: 'api', apiKey: 'k' });
    expect(agentAuthFromEnv({}, { [SUBSCRIPTION_ENV]: 't' })).toEqual({ mode: 'subscription', token: 't' });
  });

  it('throws when Anthropic auth is missing and Claude is used (codex implement + claude review)', () => {
    expect(() => agentAuthFromEnv({ provider: 'codex', reviewProvider: 'claude' }, {})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('names the used provider that asks for the Anthropic credential, with its role, on a mixed choice', () => {
    expect(() => agentAuthFromEnv({ provider: 'codex', reviewProvider: 'claude' }, {})).toThrow(
      'Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running with --review-provider claude.',
    );
    expect(() => agentAuthFromEnv({ provider: 'codex', fallbackProvider: 'claude' }, {})).toThrow(/with --fallback-provider claude\.$/);
    // A fallback list names the entry that wants the Anthropic credential, not the raw list.
    expect(() => agentAuthFromEnv({ provider: 'codex', fallbackProvider: 'cursor,claude' }, {})).toThrow(/with --fallback-provider claude\.$/);
    expect(() => agentAuthFromEnv({}, {})).toThrow(/with --provider claude\.$/);
  });

  it('does not throw and returns undefined when codex/cursor implement + zai review (no Anthropic needed)', () => {
    expect(agentAuthFromEnv({ provider: 'codex', reviewProvider: 'zai' }, { ZAI_API_KEY: 'z', CODEX_API_KEY: 'c' })).toBeUndefined();
  });

  it('returns undefined for codex/cursor alone — no Anthropic credential is consumed (#391)', () => {
    expect(agentAuthFromEnv({ provider: 'codex' }, {})).toBeUndefined();
    expect(agentAuthFromEnv({ provider: 'cursor' }, {})).toBeUndefined();
  });

  it('throws when ZAI_API_KEY is missing and provider is zai', () => {
    expect(() => agentAuthFromEnv({ provider: 'zai' }, {})).toThrow(/ZAI_API_KEY/);
  });

  it('returns subscription auth for claude provider', () => {
    expect(agentAuthFromEnv({ provider: 'claude' }, { [SUBSCRIPTION_ENV]: 't' })).toEqual({ mode: 'subscription', token: 't' });
  });
});

describe('refuseLlmProxyWithoutPrimarySidecar', () => {
  it('refuses a codex-only choice under --llm-proxy with the review-commands-only message', () => {
    expect(() => refuseLlmProxyWithoutPrimarySidecar(true, { provider: 'codex' }, { CODEX_API_KEY: 'k' })).toThrow(
      new CliUsageError('--llm-proxy with --provider codex is supported on review commands only for now'),
    );
  });

  it('passes without --llm-proxy, or when the run uses the primary sidecar or a provider no sidecar fronts', () => {
    expect(() => refuseLlmProxyWithoutPrimarySidecar(undefined, { provider: 'codex' }, { CODEX_API_KEY: 'k' })).not.toThrow();
    expect(() => refuseLlmProxyWithoutPrimarySidecar(true, { provider: 'codex', reviewProvider: 'claude' }, { CODEX_API_KEY: 'k' })).not.toThrow();
    expect(() => refuseLlmProxyWithoutPrimarySidecar(true, { provider: 'cursor' }, { CURSOR_API_KEY: 'k' })).not.toThrow();
  });
});

describe('several subscription tokens (one per line)', () => {
  it('splits, trims and dedupes; a single line is unchanged', () => {
    expect(subscriptionTokens('a\r\n b \n\na\nc\n')).toEqual(['a', 'b', 'c']);
    expect(authFromEnv({ [SUBSCRIPTION_ENV]: 'a\nb' })).toEqual({ mode: 'subscription', token: 'a', tokens: ['a', 'b'] });
    expect(authFromEnv({ [SUBSCRIPTION_ENV]: 'a\n' })).toEqual({ mode: 'subscription', token: 'a' });
  });

  it('injects only the first token into the sandbox env and hands the rest to the proxy', () => {
    const auth = authFromEnv({ [SUBSCRIPTION_ENV]: 'a\nb' })!;
    expect(authSecrets(auth)).toEqual({ [SUBSCRIPTION_ENV]: 'a' });
    expect(llmProxyAuth(auth)).toEqual({ mode: 'subscription', secret: 'a', more: ['b'] });
  });

  it('rotates per run: a limit moves to the next token, none left reports false', () => {
    const rotation = tokenRotationFor(authFromEnv({ [SUBSCRIPTION_ENV]: 'a\nb' }))!;
    expect(rotation.hasNext()).toBe(true);
    expect(rotation.limited(new Date(Date.now() + 1000))).toBe(true);
    expect(rotation.auth()).toMatchObject({ token: 'b' });
    expect(rotation.name()).toContain('token 2 of 2');
    expect(rotation.name()).not.toContain('b');
    expect(rotation.hasNext()).toBe(false);
    expect(rotation.limited(new Date(Date.now() + 1000))).toBe(false);
    expect(tokenRotationFor({ mode: 'subscription', token: 'a' })).toBeUndefined();
  });

  it('redacts every token from logs', () => {
    const t1 = 'sk-ant-oat01-AbCdEf0123456789xyzQWERTY1';
    const t2 = 'sk-ant-oat01-ZyXwVu9876543210abcDEFGHI2';
    const values = injectedSecretValues({ CLAUDE_CODE_OAUTH_TOKEN: `${t1}\n${t2}` });
    expect(values).toEqual(expect.arrayContaining([t1, t2]));
  });
});
