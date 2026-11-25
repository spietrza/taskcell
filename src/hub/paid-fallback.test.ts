import { describe, expect, test } from 'vitest';
import { decidePaidFallback } from './paid-fallback.js';
import type { RunCredential } from '../wire.js';

const SOON = new Date('2030-01-01T10:00:00.000Z');
const LATER = new Date('2030-01-01T12:00:00.000Z');
const cooling = new Map([['claude/', SOON], ['codex/', LATER]]);
const sub: RunCredential = { source: 'instance', env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat', CODEX_AUTH_JSON: '{}', ANTHROPIC_API_KEY: 'sk-paid' } };
const base = { provider: 'claude', candidates: [{ provider: 'claude' }, { provider: 'codex' }], cooling, credential: sub, enabled: true, paidEnv: { ANTHROPIC_API_KEY: 'sk-paid', CODEX_API_KEY: 'cx-paid', CODEX_AUTH_JSON: '{}' } };

describe('decidePaidFallback', () => {
  test('off: every candidate cooling leaves the credential alone', () => {
    const out = decidePaidFallback({ ...base, enabled: false });
    expect(out.credential).toBe(sub);
    expect(out.credential.paid).toBeUndefined();
  });

  test('on: moves to the paid keys, strips subscription names, names entries and earliest reset', () => {
    const { credential } = decidePaidFallback(base);
    expect(credential.env).toEqual({ ANTHROPIC_API_KEY: 'sk-paid', CODEX_API_KEY: 'cx-paid' });
    expect(credential.paid?.until).toBe(SOON.toISOString());
    expect(credential.paid?.entries).toEqual(['claude', 'codex']);
    expect(credential.paid?.reason).toContain('every subscription account is out');
  });

  test('on: a candidate with quota changes nothing', () => {
    expect(decidePaidFallback({ ...base, cooling: new Map([['claude/', SOON]]) }).credential).toBe(sub);
  });

  test('on: no paid key for the primary is a warning, credential unchanged', () => {
    const out = decidePaidFallback({ ...base, paidEnv: { CODEX_API_KEY: 'cx' } });
    expect(out.credential).toBe(sub);
    expect(out.warning).toContain('no paid key for claude (ANTHROPIC_API_KEY)');
  });

  test('on: no subscription candidate (api-key only) changes nothing', () => {
    const apiOnly: RunCredential = { source: 'user', env: { ANTHROPIC_API_KEY: 'k' } };
    expect(decidePaidFallback({ ...base, credential: apiOnly, candidates: [{ provider: 'claude' }], paidEnv: { ANTHROPIC_API_KEY: 'k' } }).credential).toBe(apiOnly);
  });

  test('scope isolation: a user run whose scope has no paid key never gets one from elsewhere', () => {
    const user: RunCredential = { source: 'user', env: { CLAUDE_CODE_OAUTH_TOKEN: 'mine' } };
    const out = decidePaidFallback({ ...base, credential: user, candidates: [{ provider: 'claude' }], paidEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'mine' } });
    expect(out.credential).toBe(user);
    expect(out.warning).toBeDefined();
  });
});
