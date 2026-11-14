import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitSkillSource, gitSkillSource, lineDiff, readSkillFiles, SkillFetchError } from '../context/skill-source.js';
import { sha256Hex } from '../context/skill-lock.js';
import type { SkillSource } from '../context/skill-source.js';
import { WorktreeManager } from '../worktree/manager.js';
import { parseCli } from './args.js';
import { skillsAdd, skillsCheck, skillsRemove, skillsUpdate, type SkillsDeps } from './skills.js';

const SRC = 'https://github.com/o/r';
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-skills-edit-'));
  dir = join(root, 'skills');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A stub git: `heads` maps a source to its head sha, `trees` a sha to files by repo path. */
function stub(heads: Record<string, string | undefined>, trees: Record<string, (tree: string) => Promise<void>>): SkillSource & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    resolve: async (source, ref) => (ref !== undefined && /^[0-9a-f]{40}$/.test(ref) ? ref : heads[source]),
    fetch: async (_source, commit) => {
      fetched.push(commit);
      const tree = await mkdtemp(join(tmpdir(), 'vg-tree-'));
      await trees[commit]?.(tree);
      return tree;
    },
  };
}
const skillTree = (body: string) => async (tree: string): Promise<void> => {
  await mkdir(join(tree, 'skills/a'), { recursive: true });
  await writeFile(join(tree, 'skills/a/SKILL.md'), body);
  await writeFile(join(tree, 'skills/a/extra.txt'), 'x');
  await writeFile(join(tree, 'README.md'), 'not part of the skill');
};
const readLock = async (d = dir): Promise<{ skills: Array<{ commit: string; sha256: string }> }> => JSON.parse(await readFile(join(d, 'skills.lock.json'), 'utf-8'));
const add = (source: SkillSource, extra: Record<string, string> = {}, d = dir): Promise<void> =>
  skillsAdd({ dir: d, source: SRC, path: 'skills/a', ...extra }, { source, today: () => '2026-01-01' }, () => {});

describe('skills add', () => {
  it('copies only the skill directory and writes the lock', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    expect((await readdir(join(dir, 'a'))).sort()).toEqual(['SKILL.md', 'extra.txt']);
    const lock = await readLock();
    expect(lock.skills[0]).toMatchObject({ name: 'a', commit: C1, path: 'skills/a', sha256: sha256Hex('one\n') });
  });
  it('refuses non-https sources and credentials', async () => {
    const s = stub({}, {});
    for (const source of ['http://github.com/o/r', 'git@github.com:o/r.git', 'file:///tmp/x', 'https://u:p@github.com/o/r']) {
      await expect(skillsAdd({ dir, source }, { source: s }, () => {})).rejects.toThrow(/https|credentials|URL/);
    }
    expect(s.fetched).toEqual([]);
  });
  it('refuses a symlink inside the skill and writes nothing', async () => {
    const s = stub({ [SRC]: C1 }, { [C1]: async (t) => { await skillTree('x')(t); await symlink('/etc/passwd', join(t, 'skills/a/link')); } });
    await expect(add(s)).rejects.toThrow(/symlink/);
    await expect(readdir(dir)).rejects.toThrow();
  });
  it('refuses a symlinked skill directory or parent', async () => {
    const s = stub({ [SRC]: C1 }, { [C1]: async (t) => { await mkdir(join(t, 'real')); await writeFile(join(t, 'real/SKILL.md'), 'x'); await symlink('real', join(t, 'skills')); } });
    await expect(add(s)).rejects.toThrow(/symlink/);
  });
  it.each(['../x', '/etc', 'skills/../../x'])('refuses a path that escapes: %s', async (path) => {
    await expect(add(stub({ [SRC]: C1 }, { [C1]: skillTree('x') }), { path })).rejects.toThrow(/inside the repository/);
  });
  it('refuses an existing skill and a bad name', async () => {
    const s = stub({ [SRC]: C1 }, { [C1]: skillTree('x') });
    await add(s);
    await expect(add(s)).rejects.toThrow(/already exists/);
    await expect(add(s, { name: '../evil' })).rejects.toThrow(/Invalid skill name/);
  });
});

describe('skills remove', () => {
  it('deletes the directory and the lock entry', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('x') }));
    await skillsRemove(dir, 'a', () => {});
    expect(await readdir(dir)).toEqual(['skills.lock.json']);
    expect((await readLock()).skills).toEqual([]);
    await expect(skillsRemove(dir, 'a', () => {})).rejects.toThrow(/No skill/);
  });
});

describe('skills update', () => {
  const opts = (over = {}) => ({ dir, repo: root, dryRun: false, pr: false, ...over });
  const setup = async (): Promise<void> => add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\ntwo\n') }));

  it('changes nothing when every skill is current', async () => {
    await setup();
    const before = await readFile(join(dir, 'skills.lock.json'), 'utf-8');
    const s = stub({ [SRC]: C1 }, {});
    const lines: string[] = [];
    await skillsUpdate(opts(), { source: s }, (l) => lines.push(l));
    expect(lines).toEqual(['a\tcurrent']);
    expect(s.fetched).toEqual([]);
    expect(await readFile(join(dir, 'skills.lock.json'), 'utf-8')).toBe(before);
  });
  it('keeps the pinned commit when upstream is gone', async () => {
    await setup();
    const lines: string[] = [];
    await skillsUpdate(opts(), { source: stub({ [SRC]: undefined }, {}) }, (l) => lines.push(l));
    expect(lines).toEqual([`a\tupstream gone → kept ${C1.slice(0, 7)}`]);
    expect((await readLock()).skills[0]?.commit).toBe(C1);
    // The head resolves but the commit cannot be fetched: also kept.
    const failing: SkillSource = { resolve: async () => C2, fetch: async () => { throw new SkillFetchError('Could not fetch x'); } };
    const again: string[] = [];
    await skillsUpdate(opts(), { source: failing }, (l) => again.push(l));
    expect(again).toEqual(lines);
  });
  it('moves to the head, rewrites SKILL.md and the lock, and prints the diff', async () => {
    await setup();
    const s = stub({ [SRC]: C2 }, { [C1]: skillTree('one\ntwo\n'), [C2]: skillTree('one\nthree\nfour\n') });
    const lines: string[] = [];
    await skillsUpdate(opts(), { source: s, today: () => '2026-02-02' }, (l) => lines.push(l));
    expect(lines[0]).toBe(`a\t${C1.slice(0, 7)} → ${C2.slice(0, 7)} (+2 −1 lines)`);
    expect(lines[1]).toContain('-two');
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('one\nthree\nfour\n');
    expect((await readLock()).skills[0]).toMatchObject({ commit: C2, sha256: sha256Hex('one\nthree\nfour\n'), updatedAt: '2026-02-02' });
  });
  it('--dry-run prints the same and writes nothing', async () => {
    await setup();
    const lockBefore = await readFile(join(dir, 'skills.lock.json'), 'utf-8');
    const s = stub({ [SRC]: C2 }, { [C1]: skillTree('one\ntwo\n'), [C2]: skillTree('new\n') });
    const lines: string[] = [];
    await skillsUpdate(opts({ dryRun: true }), { source: s }, (l) => lines.push(l));
    expect(lines[0]).toContain('→');
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('one\ntwo\n');
    expect(await readFile(join(dir, 'skills.lock.json'), 'utf-8')).toBe(lockBefore);
  });
  it('skips a skill edited locally', async () => {
    await setup();
    await writeFile(join(dir, 'a/SKILL.md'), 'edited');
    const lines: string[] = [];
    await skillsUpdate(opts(), { source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\ntwo\n'), [C2]: skillTree('n') }) }, (l) => lines.push(l));
    expect(lines).toEqual(['a\tmodified locally → skipped']);
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('edited');
  });
});

describe('skills update --pr', () => {
  it('commits on a new branch and opens a PR whose body carries the diff', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    await g('init', '-b', 'main');
    const skills = join(repo, 'skills');
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }), {}, skills);
    await g('add', '.');
    await g('commit', '-m', 'init');
    const calls: Array<{ file: string; args: string[] }> = [];
    const deps: SkillsDeps = {
      source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('one\n```\n<b>@bob</b>\n') }),
      contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) },
      runner: async (file, args, cwd) => {
        calls.push({ file, args });
        if (file === 'gh') return 'https://github.com/o/repo/pull/1';
        if (args[0] === 'push' || args[0] === 'fetch') return '';
        return (await execa(file, args, { cwd })).stdout;
      },
    };
    const lines: string[] = [];
    await skillsUpdate({ dir: skills, repo, dryRun: false, pr: true }, deps, (l) => lines.push(l));
    const pr = calls.find((c) => c.file === 'gh');
    const body = pr?.args[pr.args.indexOf('--body') + 1] ?? '';
    expect(pr?.args[pr.args.indexOf('--base') + 1]).toBe('main');
    expect(pr?.args[pr.args.indexOf('--head') + 1]).not.toBe('main');
    expect(body).toContain(`/commit/${C2}`);
    expect(body).toContain('+&lt;b>@‍bob&lt;/b>');
    expect(body).toMatch(/````diff/);
    const pushes = calls.filter((c) => c.args[0] === 'push');
    expect(pushes.length).toBeGreaterThan(0);
    for (const p of pushes) expect(p.args.join(' ')).not.toMatch(/:refs\/heads\/main\b/);
    expect(lines.at(-1)).toBe('opened https://github.com/o/repo/pull/1');
    // The live checkout is untouched.
    expect(await readFile(join(skills, 'a/SKILL.md'), 'utf-8')).toBe('one\n');
  });
});

describe('parseCli skills add|remove|update', () => {
  it('parses add with #ref, --path, --name', () => {
    expect(parseCli(['skills', 'add', 'https://h/o/r#v1', '--path', 'p', '--name', 'n', '--dir', '/s'], '/w')).toEqual({ kind: 'skills', action: 'add', dir: '/s', source: 'https://h/o/r', ref: 'v1', path: 'p', name: 'n' });
  });
  it('parses update --pr as a bare switch', () => {
    expect(parseCli(['skills', 'update', 'a', '--pr', '--dry-run'], '/w')).toEqual({ kind: 'skills', action: 'update', dir: '/w/skills', repo: '/w', name: 'a', dryRun: true, pr: true });
    expect(parseCli(['skills', 'list', '--pr'], '/w')).toMatchObject({ kind: 'error' });
  });
  it('parses remove', () => expect(parseCli(['skills', 'remove', 'a'], '/w')).toMatchObject({ action: 'remove', name: 'a' }));
});

const lockWith = (...entries: Array<Record<string, unknown>>): string => JSON.stringify({ skills: entries });
const rawEntry = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ name, source: SRC, path: 'skills/a', commit: C1, sha256: sha256Hex('x'), updatedAt: '2026-01-01', ...over });
const upd = { dryRun: false, pr: false };

describe('hardening', () => {
  it('update never treats a lock name as a path', async () => {
    const victim = join(root, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'SKILL.md'), 'x');
    await writeFile(join(victim, 'other'), 'keep');
    await mkdir(dir);
    await writeFile(join(dir, 'skills.lock.json'), lockWith(rawEntry('../victim')));
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd }, { source: stub({ [SRC]: C2 }, { [C2]: skillTree('evil') }) }, (l) => lines.push(l));
    expect(lines[0]).toContain('invalid skill name');
    expect(await readFile(join(victim, 'other'), 'utf-8')).toBe('keep');
  });
  it('update skips a skill whose other files were edited or added locally', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    await writeFile(join(dir, 'a/extra.txt'), 'mine');
    await writeFile(join(dir, 'a/mine.txt'), 'mine');
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd }, { source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') }) }, (l) => lines.push(l));
    expect(lines).toEqual(['a\tmodified locally → skipped']);
    expect(await readFile(join(dir, 'a/mine.txt'), 'utf-8')).toBe('mine');
  });
  it('one broken upstream does not stop the others', async () => {
    const s2: SkillSource = {
      resolve: async () => C2,
      fetch: async (_s, commit) => {
        const t = await mkdtemp(join(tmpdir(), 'vg-tree-'));
        await mkdir(join(t, 'skills/a'), { recursive: true });
        if (commit === C1) await skillTree('one\n')(t);
        else await writeFile(join(t, 'skills/a/other.txt'), 'no SKILL.md here');
        return t;
      },
    };
    await skillsAdd({ dir, source: SRC, path: 'skills/a', commit: undefined } as never, { source: { ...s2, resolve: async () => C1 } }, () => {});
    await skillsAdd({ dir, source: SRC, path: 'skills/a', name: 'b' }, { source: { ...s2, resolve: async () => C1 } }, () => {});
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await skillsUpdate({ dir, repo: root, ...upd }, { source: s2 }, (l) => lines.push(l));
    warn.mockRestore();
    expect(lines).toEqual([`a\tupstream refused → kept ${C1.slice(0, 7)}`, `b\tupstream refused → kept ${C1.slice(0, 7)}`]);
  });
  it('a failed lock write leaves the skill and the lock as they were', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    await mkdir(join(dir, `skills.lock.json.tmp-${process.pid}`));
    await expect(skillsUpdate({ dir, repo: root, ...upd }, { source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') }) }, () => {})).rejects.toThrow();
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('one\n');
    expect((await readLock()).skills[0]?.commit).toBe(C1);
  });
  it('update <name> touches only that skill; an unknown name is an error', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, name: 'a', ...upd }, { source: stub({ [SRC]: C1 }, {}) }, (l) => lines.push(l));
    expect(lines).toEqual(['a\tcurrent']);
    await expect(skillsUpdate({ dir, repo: root, name: 'zz', ...upd }, { source: stub({}, {}) }, () => {})).rejects.toThrow(/not pinned/);
  });
  it('add refuses the lock file name; remove refuses a non-skill directory', async () => {
    await expect(add(stub({ [SRC]: C1 }, { [C1]: skillTree('x') }), { name: 'skills.lock.json' })).rejects.toThrow(/Invalid skill name/);
    await mkdir(join(root, 'src'));
    await expect(skillsRemove(root, 'src', () => {})).rejects.toThrow(/not a skill/);
    expect((await lstat(join(root, 'src'))).isDirectory()).toBe(true);
  });
  it('add --path ./ names the skill after the repo; enforces the file limit', async () => {
    const url = 'https://github.com/o/myskill.git';
    await skillsAdd({ dir, source: url, path: './' }, { source: stub({ [url]: C1 }, { [C1]: async (t) => writeFile(join(t, 'SKILL.md'), 'x') }) }, () => {});
    expect((await readdir(dir)).sort()).toEqual(['myskill', 'skills.lock.json']);
    const big = stub({ [SRC]: C1 }, { [C1]: async (t) => { await writeFile(join(t, 'SKILL.md'), 'x'); for (let i = 0; i < 201; i++) await writeFile(join(t, `f${i}`), 'x'); } });
    await expect(skillsAdd({ dir, source: SRC, name: 'big' }, { source: big }, () => {})).rejects.toThrow(/more than 200 files/);
  });
  it('--pr outside the repo is refused; a secret in the update blocks delivery', async () => {
    await expect(skillsUpdate({ dir: '/elsewhere/skills', repo: root, dryRun: false, pr: true }, {}, () => {})).rejects.toThrow(/inside the repo/);
    const repo = join(root, 'repo');
    await mkdir(repo);
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    await g('init', '-b', 'main');
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }), {}, join(repo, 'skills'));
    await g('add', '.');
    await g('commit', '-m', 'init');
    const calls: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      skillsUpdate(
        { dir: join(repo, 'skills'), repo, dryRun: false, pr: true },
        { source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree(`token ghp_${'a'.repeat(36)}\n`) }), contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) }, runner: async (f, a) => { calls.push(`${f} ${a[0]}`); return ''; } },
        () => {},
      ),
    ).rejects.toThrow(/secret scan/);
    err.mockRestore();
    expect(calls).toEqual([]);
  });
});

describe('lineDiff and readSkillFiles', () => {
  it('counts changed lines and returns hunks', async () => {
    expect(await lineDiff('a\n', 'a\n')).toEqual({ added: 0, removed: 0, text: '' });
    const d = await lineDiff('one\ntwo\n', 'one\nthree\nfour\n');
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(d.text).toMatch(/^@@/);
    expect(d.text).toContain('-two');
  });
  it('returns undefined for a missing path', async () => expect(await readSkillFiles(root, 'nope')).toBeUndefined());
});

describe('gitSkillSource', () => {
  it('only resolves https sources by default', async () => {
    await expect(gitSkillSource.resolve('file:///tmp/x')).rejects.toThrow(/https/);
    await expect(gitSkillSource.fetch('ssh://h/x', C1)).rejects.toThrow(/https/);
  });
  it('resolves HEAD, branches, annotated tags and shas, fetches a commit and keeps symlinks refusable', async () => {
    const up = join(root, 'up');
    await mkdir(join(up, 'skills/a'), { recursive: true });
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: up });
    await g('init', '-b', 'main');
    await writeFile(join(up, 'skills/a/SKILL.md'), 'hello');
    await symlink('/etc/passwd', join(up, 'skills/a/link'));
    await g('add', '.');
    await g('commit', '-m', 'one');
    await g('tag', '-a', 'v1', '-m', 'v1');
    const head = (await g('rev-parse', 'HEAD')).stdout.trim();
    const url = `file://${up}`;
    const src = createGitSkillSource('file');
    expect(await src.resolve(url)).toBe(head);
    expect(await src.resolve(url, 'v1')).toBe(head);
    expect(await src.resolve(url, 'main')).toBe(head);
    expect(await src.resolve(url, head)).toBe(head);
    expect(await src.resolve(url, 'nope')).toBeUndefined();
    await expect(src.resolve(`file://${root}/missing`)).rejects.toThrow(/ls-remote/);
    const tree = await src.fetch(url, head);
    try {
      await expect(readSkillFiles(tree, 'skills/a')).rejects.toThrow(/symlink/);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
    await expect(src.fetch(url, 'f'.repeat(40))).rejects.toThrow(/Could not fetch/);
  });
});

describe('parseCli skills edge cases', () => {
  it('finds the command after leading options and refuses --pr=value', () => {
    expect(parseCli(['--repo', '/x', 'skills', 'update', '--pr'], '/w')).toMatchObject({ kind: 'skills', action: 'update', repo: '/x', pr: true });
    expect(parseCli(['skills', 'update', '--pr=1'], '/w')).toEqual({ kind: 'help' });
    expect(parseCli(['skills', 'update', '--pr', '--base', 'dev'], '/w')).toMatchObject({ baseBranch: 'dev' });
  });
  it('reports each misuse by name', () => {
    expect(parseCli(['skills', 'add', 'https://h/o/r', '--strict'], '/w')).toEqual({ kind: 'error', message: '--strict only applies to skills check.' });
    expect(parseCli(['skills', 'list', 'extra'], '/w')).toMatchObject({ action: 'list' });
    expect(parseCli(['skills', 'add'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['skills', 'add', 'https://h/o/r#'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['skills', 'remove'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['skills', 'list', '--dry-run'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['skills', 'list', '--name', 'n'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['skills', 'frob'], '/w')).toMatchObject({ kind: 'error' });
  });
});

describe('skills check resolver', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('follows the operator url.insteadOf rewrite, so --strict still fails an outdated skill', async () => {
    const up = join(root, 'up');
    await mkdir(join(up, 'skills/a'), { recursive: true });
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: up });
    await g('init', '-b', 'main');
    await writeFile(join(up, 'skills/a/SKILL.md'), 'one\n');
    await g('add', '.');
    await g('commit', '-m', 'one');
    const head = (await g('rev-parse', 'HEAD')).stdout.trim();
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    // The pinned https source is rewritten to a non-https transport by the operator's own git config.
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${up}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', SRC);
    const lines: string[] = [];
    expect(await skillsCheck(dir, true, undefined, (l) => lines.push(l))).toBe(1);
    expect(lines).toEqual([`a\t${SRC}\t${C1.slice(0, 7)}\toutdated (upstream ${head.slice(0, 7)})`]);
  });
});
