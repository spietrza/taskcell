import { describe, expect, it } from 'vitest';
import { asCode, maskUrl } from './asCode';

describe('asCode', () => {
  it('is the config as Publish writes it when nothing needs hiding', () => {
    const cfg = { label: 'go', budgetUsd: 4 };
    expect(asCode(cfg)).toBe(JSON.stringify(cfg, null, 2));
  });

  it('masks URL userinfo and query, keeps the host and path', () => {
    expect(maskUrl('https://user:pw@llm.example.com/api?key=SECRET')).not.toMatch(/user|pw|SECRET/);
    expect(maskUrl('https://llm.example.com/api')).toBe('https://llm.example.com/api');
    expect(maskUrl('not a url')).toBe('***');
  });

  it('masks a credentialed baseUrl and unknown custom-provider keys, but shows keyEnv', () => {
    const out = asCode({
      chatBaseUrl: 'https://u:p@chat.example.com/?t=SECRET2',
      customProviders: [{ name: 'p', baseUrl: 'https://a:b@x.example.com/v1?k=SECRET3', keyEnv: 'MY_KEY', model: 'm', token: 'SECRET4' }],
    });
    expect(out).not.toMatch(/SECRET|a:b|u:p/);
    expect(out).toContain('MY_KEY');
    expect(out).toContain('x.example.com/v1');
  });
});
