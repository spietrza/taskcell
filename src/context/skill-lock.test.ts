import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSkillLock, readSkillLock, sha256Hex, SKILL_LOCK_FILE } from './skill-lock.js';
import { skillRegistryForRun } from './skill-registry.js';
import { parseCli } from '../cli/args.js';
import { skillsCommand } from '../cli/skills.js';
import { skillsCheck, skillsList } from '../core/skills.js';

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
  it('rejects a source with credentials, without echoing them', () => {
    const parse = (): unknown => parseSkillLock(lockText({ source: 'https://user:secret@github.com/o/r' }));
    expect(parse).toThrow(/source.*credentials/);
    expect(parse).not.toThrow(/secret/);
  });
  it('rejects a skill listed twice', () => {
    expect(() => parseSkillLock(JSON.stringify({ skills: [entry(), entry()] }))).toThrow(/lists skill "a" twice/);
  });
});

describe('readSkillLock', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vg-readlock-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('returns undefined without a lock', async () => expect(await readSkillLock(root)).toBeUndefined());
  it('refuses a symlinked lock', async () => {
    await writeFile(join(root, 'real.json'), lockText());
    await symlink(join(root, 'real.json'), join(root, SKILL_LOCK_FILE));
    await expect(readSkillLock(root)).rejects.toThrow(/not a regular file/);
  });
  it('refuses a lock over the size cap', async () => {
    await writeFile(join(root, SKILL_LOCK_FILE), ' '.repeat(1024 * 1024 + 1));
    await expect(readSkillLock(root)).rejects.toThrow(/larger than/);
  });
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
  it('works silently without a lock or with one that pins nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await skillRegistryForRun(join(root, 'skills'), join(root, 'repo'));
    await writeFile(join(root, 'skills', SKILL_LOCK_FILE), JSON.stringify({ skills: [] }));
    await skillRegistryForRun(join(root, 'skills'), join(root, 'repo'));
    expect(warn).not.toHaveBeenCalled();
  });
  it('warns once for a skill missing from a lock that pins others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(join(root, 'skills', SKILL_LOCK_FILE), lockText({ name: 'other' }));
    await skillRegistryForRun(join(root, 'skills'), join(root, 'repo'));
    await skillRegistryForRun(join(root, 'skills'), join(root, 'repo'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skill\(s\) a in .* are local/));
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
  it('reports modified; --strict exits 1 on it', async () => {
    await writeFile(join(root, 'cur', 'SKILL.md'), 'edited');
    const lines: string[] = [];
    const onlyCur = async (s: string): Promise<string | undefined> => (s.endsWith('/old') ? undefined : resolver(s));
    expect(await skillsCheck(root, false, onlyCur, (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toMatch(/cur\t.*current, modified/);
    expect(await skillsCheck(root, true, onlyCur, () => {})).toBe(1);
  });
  it('lists only what the registry loads: no SKILL.md or a symlinked one is not a skill', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mkdir(join(root, 'empty'));
    await mkdir(join(root, 'linked'));
    await symlink(join(root, 'cur', 'SKILL.md'), join(root, 'linked', 'SKILL.md'));
    expect((await skillsList(root, () => {})).map((r) => r.name)).toEqual(['cur', 'old', 'unk']);
    vi.restoreAllMocks();
  });
  it('prints an invalid lock as one line and exits 1', async () => {
    await writeFile(join(root, SKILL_LOCK_FILE), '{');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await skillsCommand({ kind: 'skills', action: 'list', dir: root, strict: false })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^taskcell skills: .*is not valid JSON\.$/));
    vi.restoreAllMocks();
  });
});

describe('skills flags', () => {
  it('parses --dir and --strict on skills', () => {
    expect(parseCli(['skills', 'check', '--dir', '/s', '--strict'], '/work')).toEqual({ kind: 'skills', action: 'check', dir: '/s', strict: true });
  });
  it.each([['--dir', '/s'], ['--strict']])('rejects %s outside skills', (...flag) => {
    expect(parseCli(['run', '--linear', 'TES-1', ...flag], '/work')).toEqual({
      kind: 'error',
      message: `run does not accept ${flag[0]}; see \`taskcell run --help\`.`,
    });
  });
});
