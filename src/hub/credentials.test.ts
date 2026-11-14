import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { SidecarDeps } from '../sidecar/sidecar.js';
import { migrateLegacyCredentials, ScopedCredentialStore } from './credentials.js';
import { createHubServer } from './server.js';

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
async function legacyFile(configDir: string, secret: string, data: Record<string, string>): Promise<string> {
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
    expect(await migrateLegacyCredentials(d, store, secret)).toBe(2);
    expect(await store.values('instance')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE, ZAI_API_KEY: 'zai-key', OPENROUTER_API_KEY: 'new' });
    await expect(readFile(file)).rejects.toThrow();
    expect((await readFile(join(d, 'credentials.enc.json'))).includes(SECRET_VALUE)).toBe(false);
    expect(await migrateLegacyCredentials(d, store, secret)).toBe(0);
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
    expect(await migrateLegacyCredentials(d, new ScopedCredentialStore(d), undefined)).toBe(0);
  });
});

describe('migrateLegacyCredentials secret handling', () => {
  it('rejects a secret that is not 32 bytes and ignores prototype-named keys', async () => {
    const d = await dir();
    const good = randomBytes(32).toString('base64');
    await legacyFile(d, good, { constructor: 'x', toString: 'y', claude: SECRET_VALUE });
    const store = new ScopedCredentialStore(d);
    await expect(migrateLegacyCredentials(d, store, 'c2hvcnQ=')).rejects.toThrow('32 bytes');
    expect(await migrateLegacyCredentials(d, store, good)).toBe(1);
    expect(Object.keys(await store.values('instance'))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });
});

describe('createHubServer migration wiring', () => {
  it('listen() waits for the migration and the instance scope reaches the process env', async () => {
    const d = await dir();
    const secret = randomBytes(32).toString('base64');
    await legacyFile(d, secret, { claude: SECRET_VALUE });
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const h = createHubServer({ uiDir: d, configDir: d, browseRoot: d, bind: { isLoopback: true, allowAdd: false }, seedRepoPath: d, deps: {} as SidecarDeps, token: 't'.repeat(64), hubSecret: secret });
    await h.listen(0, '127.0.0.1');
    try {
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET_VALUE);
      expect(await new ScopedCredentialStore(d).names('instance')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      await expect(readFile(join(d, '.vanguard-hub', 'credentials.enc'))).rejects.toThrow();
    } finally {
      await h.close();
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  });

  it('a token owner cannot write instance credentials on a non-loopback bind without TASKCELL_HUB_ALLOW_ADD', async () => {
    const d = await dir();
    const h = createHubServer({ uiDir: d, configDir: d, browseRoot: d, bind: { isLoopback: false, allowAdd: false }, seedRepoPath: d, deps: {} as SidecarDeps, token: 't'.repeat(64) });
    await h.listen(0, '127.0.0.1');
    try {
      const { port } = h.server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const res = await fetch(`${origin}/rpc/save_instance_credential`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-vanguard-hub-token': 't'.repeat(64) }, body: JSON.stringify({ name: 'ZAI_API_KEY', value: 'k' }) });
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
