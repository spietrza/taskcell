import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { credentialLabel, pushToken, releaseToken, repoSlugOf, signAppJwt, tokenProviderFor } from './push-token.js';
import { selectAgents } from '../agents/registry.js';
import { injectedSecretValues, redactInjectedSecrets } from './secret-scan.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const env = { TASKCELL_APP_CLIENT_ID: 'Iv1.abc', TASKCELL_APP_PRIVATE_KEY: privateKey };

function fakeFetch(calls: string[], opts: { installStatus?: number } = {}): typeof fetch {
  let n = 0;
  return (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    if (String(url).endsWith('/installation')) return new Response(JSON.stringify({ id: 42 }), { status: opts.installStatus ?? 200 });
    n += 1;
    return new Response(JSON.stringify({ token: `ghs_minted_token_${n}_Zx9Qw8Er7Ty6Ui5Op4` }), { status: 201 });
  }) as typeof fetch;
}

describe('pushToken', () => {
  it('mints a fresh token at every call', async () => {
    const calls: string[] = [];
    const deps = { env, fetch: fakeFetch(calls), now: () => 1_700_000_000_000 };
    const a = await pushToken('o/r', deps);
    const b = await pushToken('o/r', deps);
    expect(a).not.toBe(b);
    expect(calls).toEqual([
      'GET https://api.github.com/repos/o/r/installation',
      'POST https://api.github.com/app/installations/42/access_tokens',
      'GET https://api.github.com/repos/o/r/installation',
      'POST https://api.github.com/app/installations/42/access_tokens',
    ]);
  });

  it('signs an RS256 JWT with iss, iat = now - 60 and exp 9 minutes after iat', () => {
    const now = 1_700_000_000_000;
    const [h, p] = signAppJwt('Iv1.abc', privateKey, now).split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x!, 'base64url').toString()));
    expect(h.alg).toBe('RS256');
    expect(p.iss).toBe('Iv1.abc');
    expect(p.iat).toBe(now / 1000 - 60);
    expect(p.exp).toBe(p.iat + 540);
  });

  it('falls back to TASKCELL_PUSH_TOKEN, then undefined', async () => {
    expect(await pushToken('o/r', { env: { TASKCELL_PUSH_TOKEN: 'pat' } })).toBe('pat');
    expect(await pushToken('o/r', { env: {} })).toBeUndefined();
    expect(await pushToken('o/r', { env: { TASKCELL_APP_CLIENT_ID: 'x' } })).toBeUndefined();
  });

  it('a malformed key fails naming the App and repo, without printing the key', async () => {
    const bad = 'not-a-key-SECRETMATERIAL';
    const err = await pushToken('o/r', { env: { ...env, TASKCELL_APP_PRIVATE_KEY: bad }, fetch: fakeFetch([]) }).catch((e: Error) => e);
    expect((err as Error).message).toContain('Iv1.abc');
    expect((err as Error).message).toContain('o/r');
    expect((err as Error).message).not.toContain('SECRETMATERIAL');
  });

  it('a missing installation fails naming the App and repo', async () => {
    const err = await pushToken('o/r', { env, fetch: fakeFetch([], { installStatus: 404 }) }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Iv1\.abc.*o\/r/);
    expect((err as Error).message).not.toContain('BEGIN');
  });

  it('redacts the private key and minted tokens', async () => {
    const token = await pushToken('o/r', { env, fetch: fakeFetch([]) });
    const values = injectedSecretValues({ ...env });
    expect(values).toContain(privateKey);
    expect(values).toContain(token);
    expect(redactInjectedSecrets(`k=${privateKey} t=${token}`, values)).not.toMatch(/BEGIN|ghs_minted/);
  });

  it('the private key is never forwarded into the sandbox secrets', () => {
    const selected = selectAgents({ provider: 'claude' }, { ...process.env, ...env });
    expect(Object.keys(selected.secrets)).not.toContain('TASKCELL_APP_PRIVATE_KEY');
    expect(Object.values(selected.secrets)).not.toContain(privateKey);
    expect(Object.values(selected.proxySecrets)).not.toContain(privateKey);
  });

  it('scopes the installation token to the repo and the permissions it is used for', async () => {
    const bodies: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/installation')) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ token: 'ghs_scoped_Zx9Qw8Er7Ty6Ui5Op4' }), { status: 201 });
    }) as typeof fetch;
    await pushToken('o/r', { env, fetch: f });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ repositories: ['r'], permissions: { contents: 'write', pull_requests: 'write' } });
  });

  it('a failed mint is retried once, then falls back to TASKCELL_PUSH_TOKEN with a warning', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const f = (async (url: string) => { calls.push(String(url)); return new Response('{"message":"boom"}', { status: 500 }); }) as typeof fetch;
    expect(await pushToken('o/r', { env: { ...env, TASKCELL_PUSH_TOKEN: 'pat' }, fetch: f, warn: (m) => warnings.push(m) })).toBe('pat');
    expect(calls).toHaveLength(2);
    expect(warnings[0]).toMatch(/boom.*TASKCELL_PUSH_TOKEN/);
  });

  it('rejects a malformed repo slug before calling the API', async () => {
    const calls: string[] = [];
    for (const slug of ['o', 'o/r?x=1', 'o/..', 'o/r#x']) {
      await expect(pushToken(slug, { env, fetch: fakeFetch(calls) })).rejects.toThrow(/valid owner\/repo/);
    }
    expect(calls).toEqual([]);
  });

  it('reports 403 as a refusal and includes GitHub\'s message', async () => {
    const err = await pushToken('o/r', { env, fetch: (async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 })) as typeof fetch }).catch((e: Error) => e);
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as Error).message).toContain('API rate limit exceeded');
    expect((err as Error).message).not.toContain('rejected the App credentials');
  });

  it('releaseToken revokes a minted token and drops it from redaction; a PAT is left alone', async () => {
    const calls: string[] = [];
    const base = fakeFetch(calls);
    const f = (async (url: string, init?: RequestInit) => (init?.method === 'DELETE' ? (calls.push(`DELETE ${url}`), new Response(null, { status: 204 })) : base(url, init))) as typeof fetch;
    const token = await pushToken('o/r', { env, fetch: f });
    expect(credentialLabel(token, {})).toBe(' (taskcell App token)');
    expect(injectedSecretValues({})).toContain(token);
    await releaseToken(token);
    expect(calls.at(-1)).toBe('DELETE https://api.github.com/installation/token');
    expect(injectedSecretValues({})).not.toContain(token);
    expect(credentialLabel(token, {})).toBe('');
    await releaseToken('pat');
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
    expect(credentialLabel('pat', { TASKCELL_PUSH_TOKEN: 'pat' })).toBe(' (TASKCELL_PUSH_TOKEN)');
  });

  it('wraps network errors and null bodies, and reports 401 as a credential problem', async () => {
    const netErr = await pushToken('o/r', { env, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }).catch((e: Error) => e);
    expect((netErr as Error).message).toMatch(/Iv1\.abc.*o\/r/);
    const nullBody = await pushToken('o/r', { env, fetch: (async () => new Response('null', { status: 200 })) as typeof fetch }).catch((e: Error) => e);
    expect((nullBody as Error).message).toMatch(/Iv1\.abc.*o\/r/);
    const unauth = await pushToken('o/r', { env, fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch }).catch((e: Error) => e);
    expect((unauth as Error).message).toContain('rejected the App credentials');
  });

  it('redacts the escaped key form and a single key line', () => {
    const escaped = privateKey.replace(/\n/g, '\\n');
    const values = injectedSecretValues({ TASKCELL_APP_PRIVATE_KEY: escaped });
    const line = privateKey.split('\n')[2] ?? '';
    expect(redactInjectedSecrets(privateKey, values)).not.toContain(line);
    expect(redactInjectedSecrets(escaped, values)).not.toContain(line);
  });

  it('tokenProviderFor resolves per call and throws without a slug when the App is configured', async () => {
    const calls: string[] = [];
    const provider = tokenProviderFor('/nonexistent', 'o/r', { env, fetch: fakeFetch(calls) });
    expect(await provider()).not.toBe(await provider());
    expect(calls).toHaveLength(4);
    await expect(tokenProviderFor('/nonexistent', undefined, { env: { ...env, GITHUB_REPOSITORY: '' } })()).rejects.toThrow(/owner\/repo/);
    expect(await tokenProviderFor('/nonexistent', undefined, { env: { TASKCELL_PUSH_TOKEN: 'pat' } })()).toBe('pat');
  });

  it('repoSlugOf parses the origin URL first, then falls back to GITHUB_REPOSITORY', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slug-'));
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      for (const url of ['https://github.com/own/rep.git', 'git@github.com:own/rep.git', 'https://github.com/own/rep']) {
        await execa('git', ['remote', 'remove', 'origin'], { cwd: dir, reject: false });
        await execa('git', ['remote', 'add', 'origin', url], { cwd: dir });
        expect(await repoSlugOf(dir, { GITHUB_REPOSITORY: 'a/b' })).toBe('own/rep');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await repoSlugOf('/x', { GITHUB_REPOSITORY: 'a/b' })).toBe('a/b');
    expect(await repoSlugOf('/definitely/not/a/repo', {})).toBeUndefined();
  });
});
