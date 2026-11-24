import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCooldownFile, recordCooldownFile } from './cooldowns.js';

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'cool-'));
  dirs.push(d);
  return join(d, 'c.json');
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const now = new Date('2026-01-01T00:00:00Z');
const later = (h: number): Date => new Date(now.getTime() + h * 3600_000);

describe('cooldown file', () => {
  it('drops expired, malformed and non-string entries', async () => {
    const f = await tmp();
    await writeFile(f, JSON.stringify({ live: later(1).toISOString(), old: '2025-01-01T00:00:00Z', bad: 'nope', num: 5 }));
    expect([...(await readCooldownFile(f, now)).keys()]).toEqual(['live']);
  });
  it('reads a missing or non-object file as nothing cooling', async () => {
    const f = await tmp();
    expect((await readCooldownFile(f, now)).size).toBe(0);
    await writeFile(f, '[1]');
    expect((await readCooldownFile(f, now)).size).toBe(0);
  });
  it('keeps the later reset and writes atomically (no tmp left, mode 0600)', async () => {
    const f = await tmp();
    await recordCooldownFile(f, 'k', later(5), { now });
    await recordCooldownFile(f, 'k', later(2), { now });
    expect((await readCooldownFile(f, now)).get('k')?.toISOString()).toBe(later(5).toISOString());
    await recordCooldownFile(f, 'other', later(1), { now });
    expect(Object.keys(JSON.parse(await readFile(f, 'utf8')) as object).sort()).toEqual(['k', 'other']);
  });
  it('runs prepare for the file and its tmp path', async () => {
    const f = await tmp();
    const seen: string[] = [];
    await recordCooldownFile(f, 'k', later(1), { now, prepare: async (p) => void seen.push(p) });
    expect(seen[0]).toBe(f);
    expect(seen[1]).toMatch(/\.tmp$/);
  });
});
