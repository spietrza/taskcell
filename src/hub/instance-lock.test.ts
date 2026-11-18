import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireHubLock } from './instance-lock.js';

describe('acquireHubLock', () => {
  it('refuses a second hub on the same config dir while the first one lives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-lock-'));
    const release = await acquireHubLock(dir);
    // The test runner's parent stands in for another live hub.
    await writeFile(join(dir, 'hub.lock'), String(process.ppid));
    await expect(acquireHubLock(dir)).rejects.toThrow(`another Taskcell Hub (pid ${process.ppid}) already uses ${dir}`);
    release();
  });

  it('takes over the lock of a hub that is gone, and releases it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-lock-'));
    await writeFile(join(dir, 'hub.lock'), '2147483646');
    const release = await acquireHubLock(dir);
    expect(await readFile(join(dir, 'hub.lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(join(dir, 'hub.lock'))).toBe(false);
  });
});
