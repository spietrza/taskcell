import { createCipheriv, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { BadRequestError, type SidecarDeps } from '../sidecar/sidecar.js';
import { createCredentialService, migrateLegacyCredentials, parseCredentialInput, ScopedCredentialStore } from './credentials.js';
import { createHubServer } from './server.js';
import { localOnlyIdentity } from './auth.js';

const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vanguard-hub-cred-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const SECRET_VALUE = 'sk-ant-oat01-SUPERSECRETVALUE1234';

/** A `credentials.enc` as the retired store wrote it. */
async function legacyFile(configDir: string, secret: string, data: Record<string, unknown>): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const file = join(configDir, '.vanguard-hub', 'credentials.enc');
  await mkdir(join(configDir, '.vanguard-hub'), { recursive: true });
  await writeFile(file, Buffer.concat([Buffer.from('VHC1'), iv, cipher.getAuthTag(), body]));
  return file;
}

describe('migrateLegacyCredentials', () => {
  it('moves the retired store into the instance scope, keeps names already saved, and removes the file', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    const file = await legacyFile(d, secret, { claude: SECRET_VALUE, zai: 'zai-key', openrouter: 'old' });
    const store = new ScopedCredentialStore(d);
    await store.put('instance', 'OPENROUTER_API_KEY', 'new');
    expect(await migrateLegacyCredentials(d, store, secret)).toEqual({
      moved: ['CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY'],
      skipped: ['OPENROUTER_API_KEY'],
    });
    expect(await store.values('instance')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE, ZAI_API_KEY: 'zai-key', OPENROUTER_API_KEY: 'new' });
    await expect(readFile(file)).rejects.toThrow();
    expect((await readFile(join(d, 'credentials.enc.json'))).includes(SECRET_VALUE)).toBe(false);
    expect(await migrateLegacyCredentials(d, store, secret)).toEqual({ moved: [], skipped: [] });
  });

  it('keeps the file and says why when the secret is missing or wrong', async () => {
    const d = await dir();
    const file = await legacyFile(d, randomBytes(32).toString('base64'), { claude: SECRET_VALUE });
    const store = new ScopedCredentialStore(d);
    await expect(migrateLegacyCredentials(d, store, undefined)).rejects.toThrow('TASKCELL_HUB_SECRET');
    await expect(migrateLegacyCredentials(d, store, randomBytes(32).toString('base64'))).rejects.toThrow('cannot be decrypted');
    expect((await readFile(file)).length).toBeGreaterThan(0);
  });

  it('is a no-op without a legacy file', async () => {
    const d = await dir();
    expect(await migrateLegacyCredentials(d, new ScopedCredentialStore(d), undefined)).toEqual({ moved: [], skipped: [] });
  });
});

describe('migrateLegacyCredentials secret handling', () => {
  it('rejects a secret that is not 32 bytes and ignores prototype-named keys', async () => {
    const d = await dir();
    const good = randomBytes(32).toString('base64');
    await legacyFile(d, good, { constructor: 'x', toString: 'y', claude: SECRET_VALUE });
    const store = new ScopedCredentialStore(d);
    await expect(migrateLegacyCredentials(d, store, 'c2hvcnQ=')).rejects.toThrow('32 bytes');
    expect(await migrateLegacyCredentials(d, store, good)).toEqual({ moved: ['CLAUDE_CODE_OAUTH_TOKEN'], skipped: [] });
    expect(Object.keys(await store.values('instance'))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('keeps a partially migrated file, verifies before deletion, and safely resumes', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    const file = await legacyFile(d, secret, { claude: SECRET_VALUE });
    const store = new ScopedCredentialStore(d, secret);
    const values = vi.spyOn(store, 'values');
    values.mockImplementationOnce(async () => ({})).mockRejectedValueOnce(new Error('read-back failed'));
    await expect(migrateLegacyCredentials(d, store, secret)).rejects.toThrow('read-back failed');
    expect((await readFile(file)).length).toBeGreaterThan(0);
    values.mockRestore();
    expect(await migrateLegacyCredentials(d, store, secret)).toEqual({ moved: [], skipped: ['CLAUDE_CODE_OAUTH_TOKEN'] });
    expect(await store.values('instance')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE });
    await expect(readFile(file)).rejects.toThrow();
  });

  it('keeps malformed legacy values instead of writing or discarding them', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    const file = await legacyFile(d, secret, { claude: { token: SECRET_VALUE } });
    await expect(migrateLegacyCredentials(d, new ScopedCredentialStore(d, secret), secret)).rejects.toThrow('non-string value for CLAUDE_CODE_OAUTH_TOKEN');
    expect((await readFile(file)).length).toBeGreaterThan(0);
  });
});

describe('ScopedCredentialStore at-rest keys', () => {
  it('uses TASKCELL_HUB_SECRET when supplied and creates credentials.key only without it', async () => {
    const protectedDir = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(protectedDir, secret).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    await expect(readFile(join(protectedDir, 'credentials.key'))).rejects.toThrow();
    await expect(new ScopedCredentialStore(protectedDir, randomBytes(32).toString('base64')).values('instance')).rejects.toThrow('TASKCELL_HUB_SECRET');
    await expect(new ScopedCredentialStore(protectedDir).values('instance')).rejects.toThrow('credentials.key');
    const unreadable = createCredentialService(protectedDir, [], randomBytes(32).toString('base64'));
    expect(await unreadable.instanceStatus()).toEqual({ names: [], reason: expect.stringContaining('cannot be decrypted') });

    const localDir = await dir();
    await new ScopedCredentialStore(localDir).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    expect((await readFile(join(localDir, 'credentials.key'), 'utf8')).trim()).toHaveLength(64);
  });

  it('re-encrypts an existing disk-key store under TASKCELL_HUB_SECRET', async () => {
    const d = await dir();
    const diskStore = new ScopedCredentialStore(d);
    await diskStore.put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    const secret = randomBytes(32).toString('base64');
    expect(await new ScopedCredentialStore(d, secret).values('instance')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE });
    await expect(readFile(join(d, 'credentials.key'))).rejects.toThrow();
    await expect(new ScopedCredentialStore(d).values('instance')).rejects.toThrow('cannot be decrypted');
    expect(await new ScopedCredentialStore(d, secret).names('instance')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('never overwrites a store it cannot decrypt and says which key recovers it', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    const before = await readFile(join(d, 'credentials.enc.json'));
    const wrong = createCredentialService(d, [], randomBytes(32).toString('base64'));
    await expect(wrong.putInstance('ZAI_API_KEY', 'k')).rejects.toThrow('saved under a different TASKCELL_HUB_SECRET value');
    await expect(wrong.removeInstance('CLAUDE_CODE_OAUTH_TOKEN')).rejects.toThrow('Restore that value');
    await expect(createCredentialService(d).putInstance('ZAI_API_KEY', 'k')).rejects.toThrow('no longer set');
    expect((await wrong.instanceStatus()).reason).toContain('saved under a different TASKCELL_HUB_SECRET value');
    expect((await readFile(join(d, 'credentials.enc.json'))).equals(before)).toBe(true);
    expect(await new ScopedCredentialStore(d, secret).values('instance')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE });
  });

  it('clears the migration reason without a restart once a later attempt succeeds', async () => {
    const d = await dir();
    const file = await legacyFile(d, randomBytes(32).toString('base64'), { claude: SECRET_VALUE });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = createCredentialService(d);
      await service.migrateLegacy();
      expect((await service.instanceStatus()).reason).toContain('TASKCELL_HUB_SECRET');
      await rm(file);
      expect(await service.instanceStatus()).toEqual({ names: [] });
      expect(error.mock.calls.flat().join(' ')).not.toContain(SECRET_VALUE);
    } finally {
      error.mockRestore();
    }
  });
});

describe('re-review hardening', () => {
  const quiet = (): ReturnType<typeof vi.spyOn> => vi.spyOn(console, 'error').mockImplementation(() => undefined);

  it('does not re-key or drop credentials.key while credentials.enc is unmigrated, so one secret recovers everything', async () => {
    const d = await dir();
    const oldSecret = randomBytes(32).toString('base64');
    await legacyFile(d, oldSecret, { zai: 'zai-legacy' });
    await new ScopedCredentialStore(d).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    const error = quiet();
    try {
      const mismatched = createCredentialService(d, [], randomBytes(32).toString('base64'));
      await mismatched.migrateLegacy();
      expect(await mismatched.instanceStatus()).toEqual({ names: ['CLAUDE_CODE_OAUTH_TOKEN'], reason: expect.stringContaining('credentials.enc cannot be decrypted') });
      await mismatched.putInstance('OPENROUTER_API_KEY', 'or-key');
      expect((await readFile(join(d, 'credentials.key'), 'utf8')).trim()).toHaveLength(64);
      expect(Object.keys(await new ScopedCredentialStore(d).values('instance')).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY']);

      const restored = createCredentialService(d, [], oldSecret);
      await restored.migrateLegacy();
      expect(await restored.instanceStatus()).toEqual({ names: ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY', 'ZAI_API_KEY'] });
      await expect(readFile(join(d, 'credentials.key'))).rejects.toThrow();
      expect(Object.keys(await new ScopedCredentialStore(d, oldSecret).values('instance'))).toHaveLength(3);
    } finally {
      error.mockRestore();
    }
  });

  it('an unusable or mismatched secret does not stop a run the start-up environment or the disk-key store can fund', async () => {
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const d = await dir();
      await new ScopedCredentialStore(d).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
      const short = createCredentialService(d, [], 'c2hvcnQ=');
      expect(await short.resolveForRun(undefined)).toEqual({ source: 'instance', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE } });
      expect(await short.instanceStatus()).toEqual({ names: ['CLAUDE_CODE_OAUTH_TOKEN'], reason: expect.stringContaining('32 bytes') });

      const locked = await dir();
      await new ScopedCredentialStore(locked, randomBytes(32).toString('base64')).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
      const wrong = createCredentialService(locked, [], randomBytes(32).toString('base64'));
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'startup';
      expect(await wrong.resolveForRun(undefined)).toEqual({ source: 'instance', env: {} });
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const refused = await wrong.resolveForRun(undefined).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BadRequestError);
      expect((refused as Error).message).toContain('saved under a different TASKCELL_HUB_SECRET value');
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'startup';
      await wrong.setPolicy('user-only');
      await expect(wrong.resolveForRun({ id: 'u1', email: 'u@example.com', name: 'U' })).rejects.toBeInstanceOf(BadRequestError);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    }
  });

  it('concurrent migration attempts share one run and leave no reason', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await legacyFile(d, secret, { claude: SECRET_VALUE });
    const error = quiet();
    try {
      const service = createCredentialService(d, [], secret);
      await Promise.all([service.migrateLegacy(), service.migrateLegacy()]);
      expect(error.mock.calls.flat().filter((line: unknown) => String(line).includes('migrated credentials'))).toHaveLength(1);
      expect(await service.instanceStatus()).toEqual({ names: ['CLAUDE_CODE_OAUTH_TOKEN'] });
    } finally {
      error.mockRestore();
    }
  });

  it('never falls back to a credentials.key once the store was keyed under the secret', async () => {
    const d = await dir();
    const planted = await dir();
    const store = new ScopedCredentialStore(d, randomBytes(32).toString('base64'));
    await store.put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    await new ScopedCredentialStore(planted).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', 'attacker');
    for (const name of ['credentials.key', 'credentials.enc.json']) await copyFile(join(planted, name), join(d, name));
    await expect(store.values('instance')).rejects.toThrow('cannot be decrypted');
    expect((await readFile(join(d, 'credentials.enc.json'))).equals(await readFile(join(planted, 'credentials.enc.json')))).toBe(true);
  });

  it('shows a fixed reason without paths for a file-system failure, and doc chat keeps the last good values', async () => {
    const d = await dir();
    const service = createCredentialService(d);
    await service.putInstance('CLAUDE_CODE_OAUTH_TOKEN', 'saved');
    await rm(join(d, 'credentials.enc.json'));
    await mkdir(join(d, 'credentials.enc.json'));
    const error = quiet();
    try {
      const status = await service.instanceStatus();
      expect(status).toEqual({ names: [], reason: expect.stringContaining('cannot be read') });
      expect(status.reason).not.toContain(d);
      expect(service.childEnv('claude').CLAUDE_CODE_OAUTH_TOKEN).toBe('saved');
    } finally {
      error.mockRestore();
    }
  });
});

describe('instance credential child environments', () => {
  it('trims saves, never mutates process.env, and falls back to the start-up value after delete', async () => {
    const d = await dir();
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'startup';
    try {
      const service = createCredentialService(d);
      await service.instanceStatus();
      const parsed = parseCredentialInput({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '  saved  ' });
      expect(parsed.value).toBe('saved');
      await service.putInstance(parsed.name, parsed.value);
      await service.putInstance('OPENAI_API_KEY', 'codex-saved');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('startup');
      expect(service.childEnv('claude').CLAUDE_CODE_OAUTH_TOKEN).toBe('saved');
      expect(service.childEnv('claude').OPENAI_API_KEY).not.toBe('codex-saved');
      await service.removeInstance(parsed.name);
      expect(service.childEnv('claude').CLAUDE_CODE_OAUTH_TOKEN).toBe('startup');
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    }
  });
});

describe('createHubServer migration wiring', () => {
  it('listen() waits for a verified migration without exporting the instance scope to process.env', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await legacyFile(d, secret, { claude: SECRET_VALUE });
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'startup';
    const h = createHubServer({ uiDir: d, configDir: d, browseRoot: d, bind: { isLoopback: true, allowAdd: false }, seedRepoPath: d, deps: {} as SidecarDeps, token: 't'.repeat(64), hubSecret: secret });
    await h.listen(0, '127.0.0.1');
    try {
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('startup');
      expect(await new ScopedCredentialStore(d, secret).names('instance')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      await expect(readFile(join(d, 'credentials.key'))).rejects.toThrow();
      await expect(readFile(join(d, '.vanguard-hub', 'credentials.enc'))).rejects.toThrow();
    } finally {
      await h.close();
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  });

  it('a token owner gets the mutation-gate message, while a signed-in admin can write on a non-loopback bind', async () => {
    const d = await dir();
    const h = createHubServer({
      uiDir: d,
      configDir: d,
      browseRoot: d,
      bind: { isLoopback: false, allowAdd: false },
      seedRepoPath: d,
      deps: {} as SidecarDeps,
      token: 't'.repeat(64),
      adminGithubLogins: ['root'],
      identity: {
        ...localOnlyIdentity(),
        sessionUser: async (req) => req.headers['x-test-admin'] === '1'
          ? { id: 'root-id', email: 'root@example.com', name: 'Root', login: 'github:root' }
          : undefined,
      },
    });
    await h.listen(0, '127.0.0.1');
    try {
      const { port } = h.server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const res = await fetch(`${origin}/rpc/save_instance_credential`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-vanguard-hub-token': 't'.repeat(64) }, body: JSON.stringify({ name: 'ZAI_API_KEY', value: 'k' }) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('TASKCELL_HUB_ALLOW_ADD=1');
      const admin = await fetch(`${origin}/rpc/save_instance_credential`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-test-admin': '1' }, body: JSON.stringify({ name: 'ZAI_API_KEY', value: 'k' }) });
      expect(admin.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('surfaces a value-free migration failure in Settings status and logs no credential value', async () => {
    const d = await dir();
    const file = await legacyFile(d, randomBytes(32).toString('base64'), { claude: SECRET_VALUE });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = createHubServer({ uiDir: d, configDir: d, browseRoot: d, bind: { isLoopback: true, allowAdd: false }, seedRepoPath: d, deps: {} as SidecarDeps, token: 't'.repeat(64) });
    await h.listen(0, '127.0.0.1');
    try {
      const { port } = h.server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const res = await fetch(`${origin}/rpc/instance_credentials_status`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-vanguard-hub-token': 't'.repeat(64) }, body: '{}' });
      expect(await res.json()).toMatchObject({ result: { names: [], reason: expect.stringContaining('TASKCELL_HUB_SECRET') } });
      expect(error.mock.calls.flat().join(' ')).not.toContain(SECRET_VALUE);
      expect((await readFile(file)).length).toBeGreaterThan(0);
    } finally {
      error.mockRestore();
      await h.close();
    }
  });
});
