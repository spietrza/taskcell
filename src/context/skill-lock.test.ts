import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSkillLock, sha256Hex, SKILL_LOCK_FILE } from './skill-lock.js';
import { skillRegistryForRun } from './skill-registry.js';
import { skillsCheck } from '../cli/skills.js';

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'a',
  source: 'https://github.com/o/r',
  path: 'skills/a',
  commit: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  updatedAt: '2026-01-01',
  ...over,
});
const lockText = (over: Record<string, unknown> = {}): string => JSON.stringify({ skills: [entry(over)] });

describe('parseSkillLock', () => {
  it('accepts a valid lock', () => expect(parseSkillLock(lockText()).a?.commit).toBe('a'.repeat(40)));
  it('rejects a non-https source', () => expect(() => parseSkillLock(lockText({ source: 'http://github.com/o/r' }))).toThrow(/source/));
  it('rejects a non-40-hex commit', () => expect(() => parseSkillLock(lockText({ commit: 'main' }))).toThrow(/commit/));
  it('rejects a missing sha256', () => expect(() => parseSkillLock(lockText({ sha256: undefined }))).toThrow(/sha256/));
});

describe('registry verification', () => {
  let root: string;
  const body = '---\nname: a\n---\nhi\n';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vg-lock-'));
    await mkdir(join(root, 'skills', 'a'), { recursive: true });
    await mkdir(join(root, 'repo'));
    await writeFile(join(root, 'skills', 'a', 'SKILL.md'), body);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('fails the run when content does not match the lock', async () => {
    await writeFile(join(root, 'skills', SKILL_LOCK_FILE), lockText({ sha256: sha256Hex('other') }));
    await expect(skillRegistryForRun(join(root, 'skills'), join(root, 'repo'))).rejects.toThrow(/Skill "a".*does not match/);
  });
  it('loads a matching skill', async () => {
    await writeFile(join(root, 'skills', SKILL_LOCK_FILE), lockText({ sha256: sha256Hex(body) }));
    await expect(skillRegistryForRun(join(root, 'skills'), join(root, 'repo'))).resolves.toBeDefined();
  });
  it('works silently without a lock; warns for a skill missing from an existing lock', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await skillRegistryForRun(join(root, 'skills'), join(root, 'repo'));
    expect(warn).not.toHaveBeenCalled();
    await writeFile(join(root, 'skills', SKILL_LOCK_FILE), JSON.stringify({ skills: [] }));
    await skillRegistryForRun(join(root, 'skills'), join(root, 'repo'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skill a is local'));
  });
});

describe('skills check', () => {
  let root: string;
  const body = 'x';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vg-check-'));
    for (const n of ['cur', 'old', 'unk']) {
      await mkdir(join(root, n));
      await writeFile(join(root, n, 'SKILL.md'), body);
    }
    const mk = (name: string): Record<string, unknown> => entry({ name, source: `https://example.com/${name}`, sha256: sha256Hex(body) });
    await writeFile(join(root, SKILL_LOCK_FILE), JSON.stringify({ skills: [mk('cur'), mk('old'), mk('unk')] }));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const resolver = async (s: string): Promise<string | undefined> =>
    s.endsWith('/cur') ? 'a'.repeat(40) : s.endsWith('/old') ? 'c'.repeat(40) : undefined;

  it('reports current, outdated and unknown; --strict sets the exit code', async () => {
    const lines: string[] = [];
    expect(await skillsCheck(root, false, resolver, (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toMatch(/cur\t.*current/);
    expect(lines.join('\n')).toMatch(/old\t.*outdated \(upstream ccccccc\)/);
    expect(lines.join('\n')).toMatch(/unk\t.*unknown/);
    expect(await skillsCheck(root, true, resolver, () => {})).toBe(1);
  });
});
