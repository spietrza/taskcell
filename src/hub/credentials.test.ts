import { createCipheriv, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { BadRequestError, type SidecarDeps } from '../sidecar/sidecar.js';
import { CREDENTIAL_NAMES, createCredentialService, termsWarningFor, migrateLegacyCredentials, parseCredentialInput, ScopedCredentialStore } from './credentials.js';
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
    expect(await unreadable.instanceStatus()).toMatchObject({ names: [], reason: expect.stringContaining('cannot be decrypted') });

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
      expect(await service.instanceStatus()).toMatchObject({ names: [] });
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
      expect(await mismatched.instanceStatus()).toMatchObject({ names: ['CLAUDE_CODE_OAUTH_TOKEN'], reason: expect.stringContaining('credentials.enc cannot be decrypted') });
      await mismatched.putInstance('OPENROUTER_API_KEY', 'or-key');
      expect((await readFile(join(d, 'credentials.key'), 'utf8')).trim()).toHaveLength(64);
      expect(Object.keys(await new ScopedCredentialStore(d).values('instance')).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY']);

      const restored = createCredentialService(d, [], oldSecret);
      await restored.migrateLegacy();
      expect(await restored.instanceStatus()).toMatchObject({ names: ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY', 'ZAI_API_KEY'] });
      await expect(readFile(join(d, 'credentials.key'))).rejects.toThrow();
      expect(Object.keys(await new ScopedCredentialStore(d, oldSecret).values('instance'))).toHaveLength(3);
    } finally {
      error.mockRestore();
    }
  });

  it('an unusable or mismatched secret does not stop a run the start-up environment or the disk-key store can fund', async () => {
    // Every Claude name in the start-up environment can fund the run: clear them all, not only the one this test sets.
    const claudeNames = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
    const original = Object.fromEntries(claudeNames.map((n) => [n, process.env[n]]));
    for (const n of claudeNames) delete process.env[n];
    try {
      const d = await dir();
      await new ScopedCredentialStore(d).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
      const short = createCredentialService(d, [], 'c2hvcnQ=');
      expect(await short.resolveForRun(undefined)).toMatchObject({ source: 'instance', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE } });
      expect(await short.instanceStatus()).toMatchObject({ names: ['CLAUDE_CODE_OAUTH_TOKEN'], reason: expect.stringContaining('32 bytes') });

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
      for (const n of claudeNames) {
        if (original[n] === undefined) delete process.env[n];
        else process.env[n] = original[n];
      }
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
      expect(await service.instanceStatus()).toMatchObject({ names: ['CLAUDE_CODE_OAUTH_TOKEN'] });
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
    await expect(store.values('instance')).rejects.toThrow('credentials.key is not trusted');
    expect((await readFile(join(d, 'credentials.enc.json'))).equals(await readFile(join(planted, 'credentials.enc.json')))).toBe(true);
  });

  it('keeps refusing a planted credentials.key after a restart', async () => {
    const d = await dir();
    const planted = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', SECRET_VALUE);
    await new ScopedCredentialStore(planted).put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', 'attacker');
    for (const name of ['credentials.key', 'credentials.enc.json']) await copyFile(join(planted, name), join(d, name));
    await expect(new ScopedCredentialStore(d, secret).values('instance')).rejects.toThrow('credentials.key is not trusted');
    expect((await readFile(join(d, 'credentials.enc.json'))).equals(await readFile(join(planted, 'credentials.enc.json')))).toBe(true);
  });

  it('a first save into an empty store stays on credentials.key while credentials.enc is unmigrated', async () => {
    const d = await dir();
    const oldSecret = randomBytes(32).toString('base64');
    await legacyFile(d, oldSecret, { zai: 'zai-legacy' });
    const error = quiet();
    try {
      await createCredentialService(d, [], randomBytes(32).toString('base64')).putInstance('OPENROUTER_API_KEY', 'or-key');
      expect(await new ScopedCredentialStore(d).values('instance')).toEqual({ OPENROUTER_API_KEY: 'or-key' });
      const restored = createCredentialService(d, [], oldSecret);
      await restored.migrateLegacy();
      expect(await restored.instanceStatus()).toMatchObject({ names: ['OPENROUTER_API_KEY', 'ZAI_API_KEY'] });
    } finally {
      error.mockRestore();
    }
  });

  it('resolveForRun surfaces a store read error for custom providers unless the start-up environment funds them', async () => {
    const saved = Object.fromEntries(CREDENTIAL_NAMES.map((n) => [n, process.env[n]]));
    try {
      for (const n of CREDENTIAL_NAMES) delete process.env[n];
      const d = await dir();
      await new ScopedCredentialStore(d, randomBytes(32).toString('base64')).put('instance', 'X', 'v');
      const service = createCredentialService(d, [], randomBytes(32).toString('base64'));
      const refused = await service.resolveForRun(undefined, 'meridian').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BadRequestError);
      expect((refused as Error).message).toContain('saved under a different TASKCELL_HUB_SECRET value');
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'unrelated';
      await expect(service.resolveForRun(undefined, 'meridian')).rejects.toBeInstanceOf(BadRequestError);
      await expect(service.resolveForRun(undefined, 'my-custom')).rejects.toBeInstanceOf(BadRequestError);
      process.env.MERIDIAN_API_KEY = 'startup';
      expect(await service.resolveForRun(undefined, 'meridian')).toEqual({ source: 'instance', env: {} });
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  it('reads a store under the secret even when the marker cannot be written', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'v');
    await rm(join(d, 'credentials.keyed'));
    await symlink(join(d, 'missing', 'x'), join(d, 'credentials.keyed')); // a dangling link: not present, and the write fails (ENOENT), even as root
    expect(await new ScopedCredentialStore(d, secret).values('instance')).toEqual({ X: 'v' });
  });

  it('a deferred re-key never adopts a credentials.key it did not write', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await legacyFile(d, randomBytes(32).toString('base64'), { zai: 'junk' });
    const planted = await dir();
    await new ScopedCredentialStore(planted).put('instance', 'X', 'attacker');
    await copyFile(join(planted, 'credentials.key'), join(d, 'credentials.key'));
    const known = await readFile(join(d, 'credentials.key'), 'utf8');
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'v');
    expect(await readFile(join(d, 'credentials.key'), 'utf8')).not.toBe(known);
    expect(await new ScopedCredentialStore(planted).values('instance')).toEqual({ X: 'attacker' });
    await copyFile(join(d, 'credentials.enc.json'), join(planted, 'credentials.enc.json'));
    await expect(new ScopedCredentialStore(planted).values('instance')).rejects.toThrow();
  });

  it('a marker that cannot be removed raises a fixed error and nothing is written', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await legacyFile(d, randomBytes(32).toString('base64'), { zai: 'z' });
    await mkdir(join(d, 'credentials.keyed')); // rm without recursive fails (EISDIR)
    await expect(new ScopedCredentialStore(d, secret).put('instance', 'X', 'w')).rejects.toThrow('credentials.keyed could not be removed');
    await expect(stat(join(d, 'credentials.enc.json'))).rejects.toThrow();
    await expect(stat(join(d, 'credentials.key'))).rejects.toThrow();
  });

  it('with no usable secret, a marker and no store file the save has its own message and Settings shows it', async () => {
    const d = await dir();
    await new ScopedCredentialStore(d, randomBytes(32).toString('base64')).put('instance', 'X', 'v');
    await rm(join(d, 'credentials.enc.json'));
    const store = new ScopedCredentialStore(d);
    await expect(store.put('instance', 'X', 'w')).rejects.toThrow('no store file');
    await expect(store.put('instance', 'X', 'w')).rejects.not.toThrow('cannot be decrypted');
    expect(await store.markerIssue()).toContain('no store file');
    expect((await createCredentialService(d, []).instanceStatus()).reason).toContain('no store file');
  });

  it('with no usable secret a save beside a marker is refused, also with no store file, and the marker is kept', async () => {
    for (const bad of [undefined, 'short']) {
      const d = await dir();
      await new ScopedCredentialStore(d, randomBytes(32).toString('base64')).put('instance', 'X', 'v');
      await rm(join(d, 'credentials.enc.json'));
      const store = new ScopedCredentialStore(d, bad);
      await expect(store.put('instance', 'X', 'w')).rejects.toThrow('remove credentials.keyed');
      expect((await stat(join(d, 'credentials.keyed'))).isFile()).toBe(true);
      await expect(stat(join(d, 'credentials.enc.json'))).rejects.toThrow();
      await expect(stat(join(d, 'credentials.key'))).rejects.toThrow();
      // The operator removes the marker: saves go to credentials.key again.
      await rm(join(d, 'credentials.keyed'));
      await store.put('instance', 'X', 'w');
      expect(await new ScopedCredentialStore(d, bad).values('instance')).toEqual({ X: 'w' });
    }
  });

  it('never adopts a planted marker or credentials.key as the key, nor re-keys and trusts a planted store', async () => {
    const secret = randomBytes(32).toString('base64');
    // A marker holding key material is not a key: a store under that key is not read with it.
    const d = await dir();
    const fake = await dir();
    await new ScopedCredentialStore(fake).put('instance', 'X', 'attacker');
    await copyFile(join(fake, 'credentials.enc.json'), join(d, 'credentials.enc.json'));
    await copyFile(join(fake, 'credentials.key'), join(d, 'credentials.keyed'));
    for (const s of [secret, undefined]) await expect(new ScopedCredentialStore(d, s).values('instance')).rejects.toThrow();
    // A planted credentials.key plus store beside a marker (planted or real) is neither read nor re-keyed under the secret.
    for (const marker of ['keyed under TASKCELL_HUB_SECRET\n', 'anything\n']) {
      const e = await dir();
      await copyFile(join(fake, 'credentials.key'), join(e, 'credentials.key'));
      await copyFile(join(fake, 'credentials.enc.json'), join(e, 'credentials.enc.json'));
      await writeFile(join(e, 'credentials.keyed'), marker);
      for (const s of [secret, undefined]) {
        const store = new ScopedCredentialStore(e, s);
        await expect(store.values('instance')).rejects.toThrow('remove credentials.keyed');
        await expect(store.put('instance', 'Y', 'w')).rejects.toThrow('credentials.keyed');
      }
      expect((await readFile(join(e, 'credentials.enc.json'))).equals(await readFile(join(fake, 'credentials.enc.json')))).toBe(true);
      expect((await stat(join(e, 'credentials.key'))).isFile()).toBe(true);
      expect((await stat(join(e, 'credentials.keyed'))).isFile()).toBe(true);
    }
  });

  it('a marker in any format or from another secret still blocks a planted credentials.key', async () => {
    for (const content of ['keyed under TASKCELL_HUB_SECRET\n', 'other\n']) {
      const d = await dir();
      const planted = await dir();
      await new ScopedCredentialStore(planted).put('instance', 'X', 'attacker');
      for (const name of ['credentials.key', 'credentials.enc.json']) await copyFile(join(planted, name), join(d, name));
      await writeFile(join(d, 'credentials.keyed'), content);
      await expect(new ScopedCredentialStore(d, randomBytes(32).toString('base64')).values('instance')).rejects.toThrow('credentials.key is not trusted');
    }
  });

  it('with no usable secret a marker blocks the disk-key read and the hub never deletes it', async () => {
    const d = await dir();
    const planted = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'v');
    await new ScopedCredentialStore(planted).put('instance', 'X', 'attacker');
    for (const name of ['credentials.key', 'credentials.enc.json']) await copyFile(join(planted, name), join(d, name));
    for (const bad of [undefined, 'short']) {
      const store = new ScopedCredentialStore(d, bad);
      await expect(store.values('instance')).rejects.toThrow('remove credentials.keyed');
      await expect(store.put('instance', 'Y', 'w')).rejects.toThrow('credentials.keyed');
      expect((await stat(join(d, 'credentials.keyed'))).isFile()).toBe(true);
    }
  });

  it('names credentials.keyed when a marker locks out a readable disk-key store, and removing it recovers', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'v');
    const backup = await dir();
    await new ScopedCredentialStore(backup).put('instance', 'X', 'old');
    for (const name of ['credentials.key', 'credentials.enc.json']) await copyFile(join(backup, name), join(d, name));
    await expect(new ScopedCredentialStore(d, secret).values('instance')).rejects.toThrow('remove credentials.keyed');
    await rm(join(d, 'credentials.keyed'));
    expect(await new ScopedCredentialStore(d, secret).values('instance')).toEqual({ X: 'old' });
  });

  it('removes a stale marker before a disk-key write', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'v');
    await rm(join(d, 'credentials.enc.json'));
    await legacyFile(d, randomBytes(32).toString('base64'), { zai: 'z' });
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'w');
    await expect(stat(join(d, 'credentials.keyed'))).rejects.toThrow();
    expect(await new ScopedCredentialStore(d).values('instance')).toEqual({ X: 'w' });
  });

  it('says the store stays on credentials.key while an unmigratable credentials.enc is present, and writes no marker', async () => {
    const d = await dir();
    await legacyFile(d, randomBytes(32).toString('base64'), { zai: 'z' });
    const secret = randomBytes(32).toString('base64');
    const error = quiet();
    try {
      const service = createCredentialService(d, [], secret);
      await service.putInstance('OPENROUTER_API_KEY', 'k');
      await service.migrateLegacy();
      expect((await service.instanceStatus()).reason).toContain('stays on credentials.key');
      await expect(stat(join(d, 'credentials.keyed'))).rejects.toThrow();
    } finally {
      error.mockRestore();
    }
  });

  it('keeps the marker across a restart with the legacy file present', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).put('instance', 'X', 'v');
    await legacyFile(d, randomBytes(32).toString('base64'), { zai: 'z' });
    const planted = await dir();
    await new ScopedCredentialStore(planted).put('instance', 'X', 'attacker');
    for (const name of ['credentials.key', 'credentials.enc.json']) await copyFile(join(planted, name), join(d, name));
    await expect(new ScopedCredentialStore(d, secret).values('instance')).rejects.toThrow('credentials.key is not trusted');
  });

  it('does not rewrite the marker on reads, and once the operator removes it a disk-key store re-keys', async () => {
    const d = await dir();
    const a = randomBytes(32).toString('base64');
    const store = new ScopedCredentialStore(d, a);
    await store.put('instance', 'X', 'v');
    const before = (await stat(join(d, 'credentials.keyed'))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.values('instance');
    expect((await stat(join(d, 'credentials.keyed'))).mtimeMs).toBe(before);
    await rm(join(d, 'credentials.enc.json'));
    await expect(new ScopedCredentialStore(d).put('instance', 'X', 'w')).rejects.toThrow('remove credentials.keyed');
    expect((await stat(join(d, 'credentials.keyed'))).mtimeMs).toBe(before);
    await rm(join(d, 'credentials.keyed'));
    await new ScopedCredentialStore(d).put('instance', 'X', 'w');
    expect(await new ScopedCredentialStore(d, randomBytes(32).toString('base64')).values('instance')).toEqual({ X: 'w' });
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
      expect(status).toMatchObject({ names: [], reason: expect.stringContaining('cannot be read') });
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

describe('hub admins by sign-in identity', () => {
  const user = (over: Record<string, unknown>) => ({ id: 'u1', email: 'a@x.com', name: 'A', ...over });
  it('matches github/gitlab logins, and e-mail or domain only when verified', async () => {
    const svc = createCredentialService(await dir(), ['Octo'], undefined, ['gitlab:alice', 'bob@example.com', '@corp.com']);
    expect(svc.isAdmin(user({ login: 'gitlab:Alice' }))).toBe(true);
    expect(svc.isAdmin(user({ login: 'github:octo' }))).toBe(true); // --admin-github-login
    expect(svc.isAdmin(user({ login: 'gitlab:octo' }))).toBe(false);
    expect(svc.isAdmin(user({ login: 'github:alice' }))).toBe(false);
    expect(svc.isAdmin(user({ email: 'bob@example.com', emailVerified: true }))).toBe(true);
    expect(svc.isAdmin(user({ email: 'bob@example.com', emailVerified: false }))).toBe(false);
    expect(svc.isAdmin(user({ email: 'c@corp.com', emailVerified: true }))).toBe(true);
    expect(svc.isAdmin(user({ email: 'c@corp.com' }))).toBe(false);
    expect(svc.isAdmin(undefined)).toBe(false);
    expect(() => svc.assertManager(user({ login: 'gitlab:alice' }), false)).not.toThrow();
    expect(() => svc.assertManager(user({ login: 'gitlab:mallory' }), false)).toThrow('hub admin');
  });
});

describe('multiple Claude accounts (store)', () => {
  const user = { id: 'u1', email: 'u@x.y', name: 'U' } as never;
  const acct = (name: string, over: Record<string, unknown> = {}) => ({ name, type: 'api-key' as const, value: `sk-${name}`, ...over });

  it('v1 store upgrades in memory to accounts named after their variables; legacy put/remove keep working', async () => {
    const d = await dir();
    const store = new ScopedCredentialStore(d);
    await store.put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', 'oauth');
    await store.put('instance', 'ANTHROPIC_API_KEY', 'key');
    await store.put('instance', 'OPENAI_API_KEY', 'openai');
    expect((await store.accounts('instance')).map((a) => [a.name, a.type])).toEqual([['CLAUDE_CODE_OAUTH_TOKEN', 'subscription'], ['ANTHROPIC_API_KEY', 'api-key']]);
    expect(await store.names('instance')).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']);
    await store.remove('instance', 'ANTHROPIC_API_KEY');
    expect(await store.names('instance')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']);
  });

  it('reads a v1 file (bare scope → env map) as accounts', async () => {
    const d = await dir();
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ instance: { ANTHROPIC_API_KEY: 'k1', ZAI_API_KEY: 'z' } }), 'utf8'), cipher.final()]);
    await writeFile(join(d, 'credentials.key'), `${key.toString('hex')}\n`);
    await writeFile(join(d, 'credentials.enc.json'), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    const store = new ScopedCredentialStore(d);
    expect((await store.accounts('instance')).map((a) => a.name)).toEqual(['ANTHROPIC_API_KEY']);
    expect(await store.values('instance')).toEqual({ ANTHROPIC_API_KEY: 'k1', ZAI_API_KEY: 'z' });
  });

  it('putAccount creates and updates without the secret; reorder needs a permutation; the cap is 20; names are unique', async () => {
    const store = new ScopedCredentialStore(await dir());
    const id = await store.putAccount('instance', acct('A'));
    await store.putAccount('instance', { id, name: 'A2', enabled: false });
    expect(await store.accounts('instance')).toMatchObject([{ id, name: 'A2', enabled: false, value: 'sk-A' }]);
    await expect(store.putAccount('instance', acct('a2'))).rejects.toThrow(/already has that name/);
    const b = await store.putAccount('instance', acct('B'));
    await expect(store.reorderAccounts('instance', [id])).rejects.toThrow(/exactly once/);
    await store.reorderAccounts('instance', [b, id]);
    expect((await store.accounts('instance')).map((a) => a.id)).toEqual([b, id]);
    await store.removeAccount('instance', b);
    for (let i = 0; i < 19; i++) await store.putAccount('instance', acct(`n${i}`));
    await expect(store.putAccount('instance', acct('one-too-many'))).rejects.toThrow(/at most 20/);
  });

  it('values() is the first enabled account per variable', async () => {
    const store = new ScopedCredentialStore(await dir());
    await store.putAccount('instance', acct('off', { enabled: false, value: 'sk-off' }));
    await store.putAccount('instance', acct('first', { value: 'sk-first' }));
    await store.putAccount('instance', acct('second', { value: 'sk-second' }));
    expect((await store.values('instance')).ANTHROPIC_API_KEY).toBe('sk-first');
  });

  it.each(['instance', 'user:u1'] as const)('terms (%s): a second enabled subscription token needs acknowledgeTerms; a disabled one does not count', async (scope) => {
    const store = new ScopedCredentialStore(await dir());
    const sub = (name: string, over: Record<string, unknown> = {}) => acct(name, { type: 'subscription', ...over });
    await store.putAccount(scope, sub('one'));
    await store.putAccount(scope, sub('off', { enabled: false }));
    await expect(store.putAccount(scope, sub('two'))).rejects.toThrow(/acknowledgeTerms.*individual usage/);
    await store.putAccount(scope, sub('two', { acknowledgeTerms: true }));
    expect((await store.accounts(scope)).filter((a) => a.type === 'subscription' && a.enabled)).toHaveLength(2);
    expect(termsWarningFor(await store.accounts(scope))).toMatch(/ordinary, individual usage/);
    expect(termsWarningFor((await store.accounts(scope)).slice(0, 2))).toBeUndefined();
    const svc = createCredentialService(await dir());
    await svc.store.putAccount('instance', sub('a'));
    expect((await svc.instanceStatus()).termsWarning).toBeUndefined();
    await svc.store.putAccount('instance', sub('b', { acknowledgeTerms: true }));
    expect((await svc.instanceStatus()).termsWarning).toMatch(/ordinary, individual usage/);
  });

  describe('resolution and rotation', () => {
    it('picks the first enabled, non-cooling account with exactly one Anthropic variable', async () => {
      const svc = createCredentialService(await dir());
      await svc.store.putAccount('instance', acct('off', { enabled: false }));
      await svc.store.putAccount('instance', acct('A'));
      await svc.store.putAccount('instance', acct('B', { type: 'auth-token' }));
      const cred = await svc.resolveForRun(undefined, 'claude');
      expect(cred).toMatchObject({ source: 'instance', env: { ANTHROPIC_API_KEY: 'sk-A' }, accountName: 'A' });
      expect(Object.keys(cred.env)).toEqual(['ANTHROPIC_API_KEY']);
    });

    it('limited() cools the account until the reset (hub-level file, no secret), continues on the next, and returns undefined when all are out', async () => {
      const d = await dir();
      const svc = createCredentialService(d);
      const a = await svc.store.putAccount('instance', acct('A'));
      const b = await svc.store.putAccount('instance', acct('B'));
      const first = await svc.resolveForRun(undefined, 'claude');
      const rotation = svc.rotationFor(undefined, 'claude', first)!;
      expect(await rotation.hasNext()).toBe(true);
      const until = new Date(Date.now() + 3600_000);
      const next = await rotation.limited(a, until);
      expect(next).toMatchObject({ accountId: b, accountName: 'B', env: { ANTHROPIC_API_KEY: 'sk-B' } });
      const file = JSON.parse(await readFile(join(d, 'credential-cooldowns.json'), 'utf8')) as Record<string, string>;
      expect(file).toEqual({ [`credential:instance:${a}`]: until.toISOString() });
      expect(await rotation.hasNext()).toBe(false);
      expect(await rotation.limited(b, until)).toBeUndefined();
      // new runs refuse with the reset, naming no value
      await expect(svc.resolveForRun(undefined, 'claude')).rejects.toThrow(/all 2 Claude credentials are cooling down.*resets at/);
      expect((await svc.accountViews('instance')).every((v) => v.coolingUntil === until.toISOString())).toBe(true);
    });

    it('a failed cooldown write still skips the account in this run; refresh() re-picks a cooled account', async () => {
      const d = await dir();
      const svc = createCredentialService(d);
      const a = await svc.store.putAccount('instance', acct('A'));
      await svc.store.putAccount('instance', acct('B'));
      const first = await svc.resolveForRun(undefined, 'claude');
      await mkdir(join(d, 'credential-cooldowns.json')); // a directory: the write fails
      const rotation = svc.rotationFor(undefined, 'claude', first)!;
      expect((await rotation.limited(a, new Date(Date.now() + 1000)))?.accountName).toBe('B');
      await rm(join(d, 'credential-cooldowns.json'), { recursive: true });
      const other = svc.rotationFor(undefined, 'claude', first)!;
      await other.cool(a, new Date(Date.now() + 3600_000));
      expect((await other.refresh(first)).accountName).toBe('B');
    });

    it('user-first: a user whose accounts all cool is refused, not moved onto the instance accounts', async () => {
      const svc = createCredentialService(await dir());
      await svc.setPolicy('user-first');
      await svc.store.putAccount('instance', acct('inst'));
      const own = await svc.store.putAccount('user:u1', acct('mine'));
      const first = await svc.resolveForRun(user, 'claude');
      expect(first).toMatchObject({ source: 'user', accountName: 'mine' });
      await svc.rotationFor(user, 'claude', first)!.cool(own, new Date(Date.now() + 3600_000));
      await expect(svc.resolveForRun(user, 'claude')).rejects.toThrow(/cooling down/);
    });

    it('no accounts: the instance credential is empty (the start-up environment funds the run, as before)', async () => {
      const svc = createCredentialService(await dir());
      expect(await svc.resolveForRun(undefined, 'claude')).toEqual({ source: 'instance', env: {} });
      expect(svc.rotationFor(undefined, 'claude', { source: 'instance', env: {} })).toBeUndefined();
    });

    it('a migrated v1 store with an OAuth token and ANTHROPIC_AUTH_TOKEN never rotates onto the auth token (the run parks)', async () => {
      const d = await dir();
      const old = new ScopedCredentialStore(d);
      await old.put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', 'oauth');
      await old.put('instance', 'ANTHROPIC_AUTH_TOKEN', 'gateway');
      const svc = createCredentialService(d);
      expect((await svc.store.accounts('instance')).map((a) => a.type)).toEqual(['subscription', 'auth-token']);
      const first = await svc.resolveForRun(undefined, 'claude');
      expect(first).toMatchObject({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' } });
      const rotation = svc.rotationFor(undefined, 'claude', first)!;
      expect(await rotation.hasNext()).toBe(false);
      expect(await rotation.limited(first.accountId!, new Date(Date.now() + 3600_000))).toBeUndefined();
      // a new run is refused while the OAuth account cools, never picked onto the auth token
      await expect(svc.resolveForRun(undefined, 'claude')).rejects.toThrow(/all 1 Claude credentials are cooling down/);
    });
  });
});

describe('v1 → v2 store upgrade survives re-key and the marker', () => {
  const v1File = async (d: string, key: Buffer): Promise<void> => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ instance: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'k1', ZAI_API_KEY: 'z' } }), 'utf8'), cipher.final()]);
    await writeFile(join(d, 'credentials.enc.json'), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  };

  it('a v1 disk-key store re-keys under the secret as ordered accounts, writes the marker, and reads back', async () => {
    const d = await dir();
    const diskKey = randomBytes(32);
    await writeFile(join(d, 'credentials.key'), `${diskKey.toString('hex')}\n`);
    await v1File(d, diskKey);
    const secret = randomBytes(32).toString('base64');
    const store = new ScopedCredentialStore(d, secret);
    expect((await store.accounts('instance')).map((a) => [a.name, a.type])).toEqual([['CLAUDE_CODE_OAUTH_TOKEN', 'subscription'], ['ANTHROPIC_API_KEY', 'api-key']]);
    await expect(stat(join(d, 'credentials.key'))).rejects.toThrow(); // re-keyed: the disk key is gone
    await expect(stat(join(d, 'credentials.keyed'))).resolves.toBeDefined();
    // a fresh store under the same secret reads the same accounts and plain variables
    const again = new ScopedCredentialStore(d, secret);
    expect(await again.values('instance')).toEqual({ ZAI_API_KEY: 'z', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'k1' });
    // the first save writes v2, which still loads
    await again.putAccount('instance', { name: 'extra', type: 'api-key', value: 'k2' });
    expect((await new ScopedCredentialStore(d, secret).accounts('instance')).map((a) => a.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'extra']);
  });

  it('with the marker present and no secret, the store is refused (accounts are not exposed)', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await new ScopedCredentialStore(d, secret).putAccount('instance', { name: 'A', type: 'api-key', value: 'k' });
    await expect(new ScopedCredentialStore(d).accounts('instance')).rejects.toThrow(/credentials\.keyed/);
  });

  it('concurrent cool-downs through the service lose no key', async () => {
    const d = await dir();
    const svc = createCredentialService(d);
    const ids = [];
    for (const n of ['A', 'B', 'C']) ids.push(await svc.store.putAccount('instance', { name: n, type: 'api-key', value: `k${n}` }));
    const rotation = svc.rotationFor(undefined, 'claude', await svc.resolveForRun(undefined, 'claude'))!;
    const until = new Date(Date.now() + 3600_000);
    await Promise.all(ids.map((id) => rotation.cool(id, until)));
    const file = JSON.parse(await readFile(join(d, 'credential-cooldowns.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(file).sort()).toEqual(ids.map((id) => `credential:instance:${id}`).sort());
  });
});

describe('resolveForRun with fallback-chain providers (extra)', () => {
  const u = { id: 'u1', email: 'u@example.com', name: 'U' };
  // The stored-account id/name ride along on a Claude credential; these checks are about source and env.
  const plain = (c: { source: string; env: Record<string, string> }): { source: string; env: Record<string, string> } => ({ source: c.source, env: c.env });
  it('merges the chain providers\' names; the source is decided by the primary; no instance top-up on a user run', async () => {
    const d = await dir();
    const store = new ScopedCredentialStore(d);
    await store.put('instance', 'CLAUDE_CODE_OAUTH_TOKEN', 'inst-claude');
    await store.put('instance', 'CODEX_API_KEY', 'inst-codex');
    await store.put('instance', 'CURSOR_API_KEY', 'inst-cursor');
    const svc = createCredentialService(d);
    // extra absent: today's behaviour, only the primary's names.
    expect(plain(await svc.resolveForRun(undefined, 'claude'))).toEqual({ source: 'instance', env: { CLAUDE_CODE_OAUTH_TOKEN: 'inst-claude' } });
    expect(plain(await svc.resolveForRun(undefined, 'claude', ['codex']))).toEqual({ source: 'instance', env: { CLAUDE_CODE_OAUTH_TOKEN: 'inst-claude', CODEX_API_KEY: 'inst-codex' } });

    await svc.setPolicy('user-first');
    await store.put('user:u1', 'CLAUDE_CODE_OAUTH_TOKEN', 'mine');
    // The user has no codex key: the chain entry is not funded from the instance.
    expect(plain(await svc.resolveForRun(u, 'claude', ['codex']))).toEqual({ source: 'user', env: { CLAUDE_CODE_OAUTH_TOKEN: 'mine' } });
    await store.put('user:u1', 'CODEX_API_KEY', 'my-codex');
    expect(plain(await svc.resolveForRun(u, 'claude', ['codex']))).toEqual({ source: 'user', env: { CLAUDE_CODE_OAUTH_TOKEN: 'mine', CODEX_API_KEY: 'my-codex' } });
    // A user key for a fallback provider alone does not make it a user run: the primary decides.
    expect(plain(await svc.resolveForRun(u, 'cursor', ['codex']))).toEqual({ source: 'instance', env: { CURSOR_API_KEY: 'inst-cursor', CODEX_API_KEY: 'inst-codex' } });
  });

  it('a stored Claude account carries the chain providers\' keys, also onto the next account after a limit', async () => {
    const d = await dir();
    const svc = createCredentialService(d);
    await svc.store.put('instance', 'CODEX_API_KEY', 'inst-codex');
    const a = await svc.store.putAccount('instance', { name: 'A', type: 'api-key', value: 'sk-A' });
    await svc.store.putAccount('instance', { name: 'B', type: 'subscription', value: 'oat-B' });
    const first = await svc.resolveForRun(undefined, 'claude', ['codex']);
    expect(first).toMatchObject({ accountName: 'A', env: { ANTHROPIC_API_KEY: 'sk-A', CODEX_API_KEY: 'inst-codex' } });
    expect(Object.keys(first.env).sort()).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    const next = await svc.rotationFor(undefined, 'claude', first)!.limited(a, new Date(Date.now() + 3600_000));
    expect(next?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-B', CODEX_API_KEY: 'inst-codex' });
  });
});
