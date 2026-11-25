import { describe, it, expect, vi } from 'vitest';
import { runWithTokenRotation } from './source-adapter.js';
import { CredentialLimited } from './run-execution.js';
import type { RunIssueDeps } from './source-adapter.js';

const deps = (extra: Partial<RunIssueDeps> = {}): RunIssueDeps =>
  ({ repoPath: '/r', auth: { mode: 'subscription', token: 'a', tokens: ['a', 'b'] }, ...extra }) as RunIssueDeps;

describe('runWithTokenRotation', () => {
  it('a limit on token 1 continues on token 2 in the same run, recording which account and why', async () => {
    const limit = new Error('limit');
    const seen: { token: string; name: string | undefined; hasNext: boolean }[] = [];
    const attempt = vi.fn(async (d: RunIssueDeps) => {
      seen.push({ token: (d.auth as { token: string }).token, name: d.credentialName, hasNext: await d.credentialRotation!.hasNext() });
      if (seen.length === 1) throw new CredentialLimited(limit, new Date(Date.now() + 60_000));
      return 'done';
    });
    await expect(runWithTokenRotation('o/r#1', deps(), attempt)).resolves.toBe('done');
    expect(seen.map((s) => s.token)).toEqual(['a', 'b']);
    expect(seen[0]).toMatchObject({ hasNext: true, name: 'token 1 of 2' });
    expect(seen[1]!.name).toMatch(/^token 2 of 2 \(token 1 hit a plan limit until /);
    expect(seen[1]!.hasNext).toBe(false); // every token out -> the engine falls back (Codex), then parks
  });

  it('when the last token is limited the original limit escapes', async () => {
    const limit = new Error('limit');
    const attempt = vi.fn(async () => { throw new CredentialLimited(limit, new Date(Date.now() + 60_000)); });
    await expect(runWithTokenRotation('o/r#1', deps(), attempt)).rejects.toBe(limit);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('a single token or an LLM proxy runs once with the deps untouched', async () => {
    const single = deps({ auth: { mode: 'subscription', token: 'a' } });
    const attempt = vi.fn(async (d: RunIssueDeps) => d);
    expect(await runWithTokenRotation('o/r#1', single, attempt)).toBe(single);
    const proxied = deps({ sandboxContext: { proxyMode: true, llmProxy: { url: 'u', nonce: 'n', host: 'h' } } });
    expect(await runWithTokenRotation('o/r#1', proxied, attempt)).toBe(proxied);
  });
});
