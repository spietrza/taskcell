import { mkdtemp, readFile, stat, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateToken, rotateToken } from './token-file.js';

async function tmpPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'hub-token-')), 'hub.key');
}

const posix = process.platform === 'win32' ? it.skip : it;

describe('token file', () => {
  posix('creates a 0600 file, then reuses its token', async () => {
    const p = await tmpPath();
    const token = await loadOrCreateToken(p);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(p)).toBe(token);
    expect(await readdir(dirname(p))).toEqual(['hub.key']);
  });

  posix('refuses a loose mode, naming the file and the fix', async () => {
    const p = await tmpPath();
    await writeFile(p, 'a'.repeat(64));
    await chmod(p, 0o644);
    await expect(loadOrCreateToken(p)).rejects.toThrow(new RegExp(`${p}.*chmod 600`));
  });

  it('refuses a short or non-token file', async () => {
    const p = await tmpPath();
    await writeFile(p, 'abcd\n', { mode: 0o600 });
    await expect(loadOrCreateToken(p)).rejects.toThrow(/32 bytes.*taskcell hub rotate-token/);
    await writeFile(p, `${'a'.repeat(40)}!!`, { mode: 0o600 });
    await expect(loadOrCreateToken(p)).rejects.toThrow(/32 bytes/);
  });

  it('accepts base64url', async () => {
    const p = await tmpPath();
    await writeFile(p, 'A'.repeat(43), { mode: 0o600 });
    expect(await loadOrCreateToken(p)).toBe('A'.repeat(43));
  });

  posix('rotate replaces the token, keeping 0600', async () => {
    const p = await tmpPath();
    const token = await loadOrCreateToken(p);
    const next = await rotateToken(p);
    expect(next).not.toBe(token);
    expect((await readFile(p, 'utf8')).trim()).toBe(next);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(p)).toBe(next);
  });
});
