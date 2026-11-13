import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore } from './credentials.js';
import { dispatchRpc, type RpcContext } from './rpc.js';

const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vanguard-hub-cred-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const secret = (): string => randomBytes(32).toString('base64');
const SECRET_VALUE = 'sk-ant-oat01-SUPERSECRETVALUE1234';

describe('CredentialStore', () => {
  it('is disabled without a secret and says why', async () => {
    const store = new CredentialStore(await dir(), undefined, {});
    const s = await store.summary();
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('VANGUARD_HUB_SECRET');
    await expect(store.set('claude', 'x')).rejects.toThrow('VANGUARD_HUB_SECRET');
  });

  it('rejects a secret that is not 32 bytes', async () => {
    const s = await new CredentialStore(await dir(), 'c2hvcnQ=', {}).summary();
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('32 bytes');
  });

  it('encrypts at rest, overrides env, and restores env on delete', async () => {
    const d = await dir();
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' };
    const key = secret();
    const store = new CredentialStore(d, key, env);
    const s = await store.set('claude', SECRET_VALUE);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET_VALUE);
    expect(s.providers.find((p) => p.provider === 'claude')).toEqual({ provider: 'claude', set: true, last4: '1234', env: true });
    expect(JSON.stringify(s)).not.toContain(SECRET_VALUE);
    const raw = await readFile(join(d, '.vanguard-hub', 'credentials.enc'));
    expect(raw.includes(SECRET_VALUE)).toBe(false);
    expect(raw.toString('base64').includes(SECRET_VALUE)).toBe(false);

    // A fresh process with the same key sees it; a wrong key is a clear error.
    const env2: NodeJS.ProcessEnv = {};
    await new CredentialStore(d, key, env2).applyStored();
    expect(env2.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET_VALUE);
    const wrong = new CredentialStore(d, secret(), {});
    await expect(wrong.applyStored()).rejects.toThrow('cannot be decrypted');
    expect((await wrong.summary()).reason).toContain('cannot be decrypted');
    await expect(wrong.set('zai', 'k')).rejects.toThrow('cannot be decrypted');

    await store.delete('claude');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('from-env');
  });

  it('keeps every concurrent write, rejects an empty value, and hides last4 of a short value', async () => {
    const store = new CredentialStore(await dir(), secret(), {});
    await Promise.all([store.set('claude', SECRET_VALUE), store.set('zai', 'shortkey'), store.set('openrouter', SECRET_VALUE)]);
    const s = await store.summary();
    expect(s.providers.filter((p) => p.set).map((p) => p.provider)).toEqual(['claude', 'zai', 'openrouter']);
    expect(s.providers.find((p) => p.provider === 'zai')).toEqual({ provider: 'zai', set: true, env: false });
    await expect(store.set('codex', '')).rejects.toThrow('empty');
  });
});

describe('credential RPCs never return a stored value', () => {
  it('get/set/delete responses and errors hold only set + last4', async () => {
    const store = new CredentialStore(await dir(), secret(), {});
    const published: unknown[] = [];
    const ctx = {
      credentials: store,
      bind: { isLoopback: true, allowAdd: false },
      publish: (n: string, p: unknown) => published.push([n, p]),
    } as unknown as RpcContext;
    const out = [
      await dispatchRpc(ctx, 'set_credential', { provider: 'openrouter', value: SECRET_VALUE }),
      await dispatchRpc(ctx, 'get_credentials', {}),
      await dispatchRpc(ctx, 'delete_credential', { provider: 'openrouter' }),
    ];
    const err = await dispatchRpc(ctx, 'set_credential', { provider: 'nope', value: SECRET_VALUE }).catch((e: Error) => e.message);
    expect(JSON.stringify([out, err, published])).not.toContain(SECRET_VALUE);
    expect(out[1]).toMatchObject({ enabled: true });
  });

  it('refuses mutations on a non-loopback bind', async () => {
    const ctx = { credentials: new CredentialStore(await dir(), secret(), {}), bind: { isLoopback: false, allowAdd: false } } as unknown as RpcContext;
    await expect(dispatchRpc(ctx, 'set_credential', { provider: 'claude', value: 'x' })).rejects.toThrow();
  });
});
