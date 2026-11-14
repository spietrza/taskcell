import { describe, expect, it } from 'vitest';
import { customProviderRowError, customProviderRows, PROVIDERS } from './customProviders';

const ROW = { name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_API_KEY' };

describe('customProviderRowError (grammar mirror of the core predicate)', () => {
  it('accepts the reference row with and without model', () => {
    expect(customProviderRowError(ROW, 0, [ROW])).toBeUndefined();
    expect(customProviderRowError({ ...ROW, model: 'glm-5.2' }, 0, [ROW])).toBeUndefined();
  });

  it.each([
    ['bad name grammar', { ...ROW, name: 'My-Proxy' }, /lowercase/],
    ['empty name', { ...ROW, name: '' }, /lowercase/],
    ['built-in collision', { ...ROW, name: 'zai' }, /built-in/],
    ['relative baseUrl', { ...ROW, baseUrl: '/api' }, /absolute http/],
    ['bad keyEnv', { ...ROW, keyEnv: '1BAD' }, /environment variable/],
    ['empty model', { ...ROW, model: '' }, /non-empty/],
  ])('rejects %s', (_label, row, re) => {
    expect(customProviderRowError(row, 0, [row])).toMatch(re);
  });

  it.each(['TASKCELL_HUB_SECRET', 'Taskcell_Hub_Secret', 'VANGUARD_PUSH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'anthropic_api_key', 'GLAB_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLOUDFLARE_AUTH_TOKEN', 'LANGFUSE_SECRET_KEY'])(
    'rejects the reserved keyEnv %s, as the server does',
    (keyEnv) => {
      const row = { ...ROW, keyEnv };
      expect(customProviderRowError(row, 0, [row])).toMatch(/must not name a credential/);
    },
  );

  it.each(['MY_TASKCELL_KEY', 'TASKCELLKEY', 'DEEPSEEK_API_KEY'])('still accepts the provider-owned keyEnv %s', (keyEnv) => {
    const row = { ...ROW, keyEnv };
    expect(customProviderRowError(row, 0, [row])).toBeUndefined();
  });

  it('flags an unknown key from a hand-edited file — core would reject it at run time', () => {
    const row = { ...ROW, futureKey: true } as typeof ROW;
    expect(customProviderRowError(row, 0, [row])).toMatch(/unknown key "futureKey"/);
  });

  it('flags the SECOND duplicate, not the first', () => {
    const rows = [ROW, { ...ROW }];
    expect(customProviderRowError(rows[0]!, 0, rows)).toBeUndefined();
    expect(customProviderRowError(rows[1]!, 1, rows)).toMatch(/duplicate/);
  });

  it('PROVIDERS mirrors the six built-ins', () => {
    expect(PROVIDERS).toEqual(['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian']);
  });
});

describe('customProviderRows (narrowing the opaque wire field)', () => {
  it('keeps every array entry, including ones the editor would flag', () => {
    const rows = [ROW, { ...ROW, name: 'My-Proxy', futureKey: true }];
    expect(customProviderRows({ customProviders: rows })).toEqual(rows);
  });

  it.each([
    ['absent', undefined],
    ['null (Rust emit-all)', null],
    ['non-array JSON from a hand-edited file', { 'my-proxy': { baseUrl: 'https://llm.example.com' } }],
  ])('yields no rows when the field is %s', (_label, value) => {
    expect(customProviderRows({ customProviders: value })).toEqual([]);
  });
});
