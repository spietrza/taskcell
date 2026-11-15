import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitSkillSource, gitSkillSource, lineDiff, readSkillFiles, SkillFetchError } from '../context/skill-source.js';
import { sha256Hex, type SkillLockEntry } from '../context/skill-lock.js';
import type { SkillSource } from '../context/skill-source.js';
import { WorktreeManager } from '../worktree/manager.js';
import { parseCli } from './args.js';
import { commitLink, skillsAdd, skillsCheck, skillsCommand, skillsList, skillsRemove, recordedMetrics, skillsUpdate, skillUpdateBody, type SkillsDeps, type SkillUpdate } from './skills.js';

// A rename that can be made to fail, for the install rollback tests.
const fsHook = vi.hoisted(() => ({ failRename: undefined as ((from: string, to: string) => boolean) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string): Promise<void> => {
      if (fsHook.failRename?.(from, to) === true) throw new Error('EIO: injected rename failure');
      return real.rename(from, to);
    },
  };
});

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
  fsHook.failRename = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** A stub git: `heads` maps a source to its head sha, `trees` a sha to files by repo path. */
function stub(heads: Record<string, string | undefined>, trees: Record<string, (tree: string) => Promise<void>>): SkillSource & { fetched: string[] } {
  const fetched: string[] = [];
  const dirs: string[] = [];
  return {
    fetched,
    dispose: async () => {
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    },
    resolve: async (source, ref) => (ref !== undefined && /^[0-9a-f]{40}$/.test(ref) ? ref : heads[source]),
    fetch: async (_source, commit) => {
      fetched.push(commit);
      const tree = await mkdtemp(join(tmpdir(), 'vg-tree-'));
      dirs.push(tree);
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
const add = async (source: SkillSource, extra: Record<string, string> = {}, d = dir): Promise<void> => {
  await skillsAdd({ dir: d, source: SRC, path: 'skills/a', ...extra }, { source, today: () => '2026-01-01' }, () => {});
};

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
        calls.push({ file, args: file === 'gh' ? [...args, '--body', await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8')] : args });
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

describe('skills update --pr: hardening', () => {
  it('works through a skills directory that is a symlink inside the repo', async () => {
    const { repo } = await prRepo(async (r) => {
      await mkdir(join(r, 'vendor'));
      await rename(join(r, 'skills'), join(r, 'vendor/skills'));
      await symlink('vendor/skills', join(r, 'skills'));
    });
    let committed = '';
    const base = runner([]);
    const deps: SkillsDeps = {
      source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') }),
      contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) },
      runner: async (file, args, cwd) => {
        if (file === 'git' && args[0] === 'push') committed = (await execa('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd })).stdout;
        return base(file, args, cwd);
      },
    };
    await skillsUpdate({ dir: join(repo, 'skills'), repo, dryRun: false, pr: true }, deps, () => {});
    expect(committed.split('\n')).toContain('vendor/skills/a/SKILL.md');
  });
  const prRepo = async (prep?: (repo: string, g: (...a: string[]) => Promise<unknown>) => Promise<void>): Promise<{ repo: string; skills: string; g: (...a: string[]) => ReturnType<typeof execa> }> => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    await g('init', '-b', 'main');
    const skills = join(repo, 'skills');
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }), {}, skills);
    await prep?.(repo, g);
    await g('add', '.');
    await g('commit', '-m', 'init');
    return { repo, skills, g };
  };
  const libTree = (body: string) => async (tree: string): Promise<void> => {
    await skillTree(body)(tree);
    await mkdir(join(tree, 'skills/a/lib'), { recursive: true });
    await writeFile(join(tree, 'skills/a/lib/x.js'), 'x');
  };
  const runner = (calls: Array<{ file: string; args: string[] }>, onGh?: () => string) => async (file: string, args: string[], cwd: string): Promise<string> => {
    calls.push({ file, args });
    if (file === 'gh') return onGh?.() ?? 'https://github.com/o/repo/pull/1';
    if (args[0] === 'push' || args[0] === 'fetch') return '';
    return (await execa(file, args, { cwd })).stdout;
  };
  it('commits a skill file that a .gitignore matches', async () => {
    const { repo, skills } = await prRepo(async (r) => writeFile(join(r, '.gitignore'), 'lib/\n'));
    const calls: Array<{ file: string; args: string[] }> = [];
    let committed = '';
    const base = runner(calls);
    const deps: SkillsDeps = {
      source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: libTree('two\n') }),
      contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) },
      runner: async (file, args, cwd) => {
        if (file === 'git' && args[0] === 'push') committed = (await execa('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd })).stdout;
        return base(file, args, cwd);
      },
    };
    await skillsUpdate({ dir: skills, repo, dryRun: false, pr: true }, deps, () => {});
    expect(committed.split('\n')).toContain('skills/a/lib/x.js');
  });
  it('names the pushed branch when gh pr create fails', async () => {
    const { repo, skills } = await prRepo();
    const calls: Array<{ file: string; args: string[] }> = [];
    const deps: SkillsDeps = {
      source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') }),
      contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) },
      runner: runner(calls, () => {
        throw new Error('gh: not logged in');
      }),
    };
    await expect(skillsUpdate({ dir: skills, repo, dryRun: false, pr: true }, deps, () => {})).rejects.toThrow(/after pushing origin\/chore\/taskcell-skills-update.*not logged in/);
  });
  it('refuses a skills directory that is a symlink out of the worktree', async () => {
    const outside = join(root, 'outside');
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }), {}, outside);
    const { repo, skills } = await prRepo(async (r) => {
      await rm(join(r, 'skills'), { recursive: true });
      await symlink(outside, join(r, 'skills'));
    });
    const deps: SkillsDeps = {
      source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') }),
      contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) },
      runner: runner([]),
    };
    await expect(skillsUpdate({ dir: skills, repo, dryRun: false, pr: true }, deps, () => {})).rejects.toThrow(/resolves outside the repo/);
    expect(await readFile(join(outside, 'a/SKILL.md'), 'utf-8')).toBe('one\n');
  });
});

describe('parseCli skills add|remove|update', () => {
  it('parses add with #ref, --path, --name', () => {
    expect(parseCli(['skills', 'add', 'https://h/o/r#v1', '--path', 'p', '--name', 'n', '--dir', '/s'], '/w')).toEqual({ kind: 'skills', action: 'add', dir: '/s', source: 'https://h/o/r', ref: 'v1', path: 'p', name: 'n' });
  });
  it('parses update --pr as a bare switch', () => {
    expect(parseCli(['skills', 'update', 'a', '--pr', '--dry-run'], '/w')).toEqual({ kind: 'skills', action: 'update', dir: '/w/skills', repo: '/w', name: 'a', dryRun: true, pr: true, force: false });
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
    // Neither the branch nor the worktree with the flagged content is left behind.
    expect((await g('branch', '--format=%(refname:short)')).stdout).toBe('main');
    expect(await readdir(join(root, 'wt'))).toEqual([]);
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
    // Refused from the tree listing, before anything is checked out.
    await expect(src.fetch(url, head, 'skills/a')).rejects.toThrow(/link is a symlink/);
    await expect(src.fetch(url, 'f'.repeat(40))).rejects.toThrow(/Could not fetch/);
    await src.dispose?.();
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

describe('install is safe to fail', () => {
  const next = (): SkillSource => stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') });
  it('a failed swap puts the installed skill back and leaves no staging directory', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    fsHook.failRename = (from) => from.endsWith('/new');
    await expect(skillsUpdate({ dir, repo: root, ...upd }, { source: next() }, () => {})).rejects.toThrow(/injected/);
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('one\n');
    expect(await readFile(join(dir, 'a/extra.txt'), 'utf-8')).toBe('x');
    expect((await readLock()).skills[0]?.commit).toBe(C1);
    expect((await readdir(dir)).sort()).toEqual(['a', 'skills.lock.json']);
  });
  it('a failure to move the installed skill aside leaves it in place', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    fsHook.failRename = (from) => from === join(dir, 'a');
    await expect(skillsUpdate({ dir, repo: root, ...upd }, { source: next() }, () => {})).rejects.toThrow(/injected/);
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('one\n');
    expect((await readdir(dir)).sort()).toEqual(['a', 'skills.lock.json']);
  });
  it('when the old version cannot be put back it is kept, named, and never loads as a skill', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    fsHook.failRename = (from) => from.endsWith('/new') || from.endsWith('/old');
    const failure = await skillsUpdate({ dir, repo: root, ...upd }, { source: next() }, () => {}).catch((e: Error) => e);
    expect((failure as Error).message).toMatch(/could not put the previous version back: it is in .*\/old/);
    const kept = /it is in (.*)\.$/.exec((failure as Error).message)?.[1] ?? '';
    expect(await readFile(join(kept, 'SKILL.md'), 'utf-8')).toBe('one\n');
    expect(await skillsList(dir, () => {})).toEqual([]);
  });
});

describe('file modes', () => {
  const withScript = (body: string, mode: number) => async (tree: string): Promise<void> => {
    await skillTree(body)(tree);
    await writeFile(join(tree, 'skills/a/run.sh'), '#!/bin/sh\n');
    await chmod(join(tree, 'skills/a/run.sh'), mode);
  };
  it('add keeps the executable bit; a local mode change counts as a local edit', async () => {
    const s = stub({ [SRC]: C2 }, { [C1]: withScript('one\n', 0o755), [C2]: withScript('two\n', 0o755) });
    await add({ ...s, resolve: async () => C1 });
    expect((await lstat(join(dir, 'a/run.sh'))).mode & 0o111).not.toBe(0);
    expect((await lstat(join(dir, 'a/SKILL.md'))).mode & 0o111).toBe(0);
    await chmod(join(dir, 'a/run.sh'), 0o644);
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd }, { source: s }, (l) => lines.push(l));
    expect(lines).toEqual(['a\tmodified locally → skipped']);
  });
  it('update reports a mode change upstream and applies it', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: withScript('one\n', 0o644) }));
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd }, { source: stub({ [SRC]: C2 }, { [C1]: withScript('one\n', 0o644), [C2]: withScript('one\n', 0o755) }) }, (l) => lines.push(l));
    expect(lines[1]).toBe('a: files changed besides SKILL.md:\n  M run.sh');
    expect((await lstat(join(dir, 'a/run.sh'))).mode & 0o111).not.toBe(0);
  });
});

describe('output', () => {
  it('never prints upstream control, newline or bidi characters', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    const evil = async (tree: string): Promise<void> => {
      await skillTree('two\u001b[2J\u202e\n')(tree);
      await writeFile(join(tree, 'skills/a/x\u001b[31m\nb\tcurrent\u202e.txt'), 'x');
    };
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, dryRun: true, pr: false }, { source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: evil }) }, (l) => lines.push(l));
    const shown = lines.join('\n');
    expect(shown).not.toMatch(/[\u001b\u202e]/);
    expect(shown).toContain('  A x?[31m?b\tcurrent?.txt');
    expect(shown.split('\n').some((l) => l.startsWith('b\t'))).toBe(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await skillsCommand({ kind: 'skills', action: 'remove', dir, name: 'x\u001b[31m\ny' })).toBe(1);
    expect(err.mock.calls[0]?.[0]).toBe('taskcell skills: Invalid skill name "x?[31m?y": use letters, digits, ".", "_" and "-", starting with a letter or digit.');
    err.mockRestore();
  });
  it('lists the changed files besides SKILL.md in place', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    const c2 = async (tree: string): Promise<void> => {
      await skillTree('one\n')(tree);
      await rm(join(tree, 'skills/a/extra.txt'));
      await mkdir(join(tree, 'skills/a/scripts'));
      await writeFile(join(tree, 'skills/a/scripts/run.sh'), 'echo');
    };
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd }, { source: stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: c2 }) }, (l) => lines.push(l));
    expect(lines).toEqual([`a\t${C1.slice(0, 7)} → ${C2.slice(0, 7)} (+0 −0 lines)`, 'a: files changed besides SKILL.md:\n  D extra.txt\n  A scripts/run.sh']);
    expect((await readdir(join(dir, 'a'))).sort()).toEqual(['SKILL.md', 'scripts']);
  });
});

describe('why a pinned commit cannot check local files', () => {
  const lineFor = async (pinnedTree: (t: string) => Promise<void>): Promise<string[]> => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await skillsUpdate({ dir, repo: root, ...upd }, { source: stub({ [SRC]: C2 }, { [C1]: pinnedTree, [C2]: skillTree('two\n') }) }, (l) => lines.push(l));
    warn.mockRestore();
    return lines;
  };
  it('names a path that is missing in the pinned commit', async () => {
    expect(await lineFor(async () => {})).toEqual([`a\tskills/a is not in pinned commit ${C1.slice(0, 7)}, so local files cannot be checked against it → skipped (--force replaces them unchecked)`]);
  });
  it('names content the pinned commit holds but that is refused', async () => {
    const noSkillMd = async (t: string): Promise<void> => {
      await mkdir(join(t, 'skills/a'), { recursive: true });
      await writeFile(join(t, 'skills/a/other.txt'), 'x');
    };
    expect(await lineFor(noSkillMd)).toEqual([`a\tpinned commit ${C1.slice(0, 7)} was refused (see stderr), so local files cannot be checked against it → skipped (--force replaces them unchecked)`]);
  });
});

describe('a pinned commit that is gone', () => {
  it('says so, and --force moves the skill anyway', async () => {
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }));
    const base = stub({ [SRC]: C2 }, { [C2]: skillTree('two\n') });
    const source: SkillSource = { ...base, fetch: async (s, c) => (c === C1 ? Promise.reject(new SkillFetchError('Could not fetch x: fatal: remote error: upload-pack: not our ref')) : base.fetch(s, c)) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lines: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd }, { source }, (l) => lines.push(l));
    expect(lines).toEqual([`a\tpinned commit ${C1.slice(0, 7)} can no longer be fetched, so local files cannot be checked against it → skipped (--force replaces them unchecked)`]);
    expect(warn.mock.calls[0]?.[0]).toContain('not our ref');
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('one\n');
    const forced: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd, force: true }, { source }, (l) => forced.push(l));
    warn.mockRestore();
    expect(forced[0]).toContain('local files not checked against the pinned commit');
    expect(await readFile(join(dir, 'a/SKILL.md'), 'utf-8')).toBe('two\n');
    // --force never overrides a local edit of SKILL.md.
    await writeFile(join(dir, 'a/SKILL.md'), 'mine');
    const edited: string[] = [];
    await skillsUpdate({ dir, repo: root, ...upd, force: true }, { source: stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }) }, (l) => edited.push(l));
    expect(edited).toEqual(['a\tmodified locally → skipped']);
  });
});

describe('PR body', () => {
  const moved = (name: string, text: string, changed: string[] = [], source = SRC): SkillUpdate => ({
    name,
    detail: `${C1.slice(0, 7)} → ${C2.slice(0, 7)} (+1 −1 lines)`,
    from: C1,
    entry: { ...rawEntry(name), source, commit: C2 } as SkillLockEntry,
    files: new Map(),
    diff: { added: 1, removed: 1, text },
    changed,
  });
  const bigDiff = `@@ -1 +1 @@\n${'+a line of the diff\n'.repeat(8000)}`;
  it('stays under GitHub\'s limit whatever the number of skills and the size of the diffs', async () => {
    const files = Array.from({ length: 200 }, (_, i) => `M ${'dir/'.repeat(20)}file-${i}.sh`);
    const rest: SkillUpdate[] = Array.from({ length: 400 }, (_, i) => ({ name: `kept-${i}`, detail: `upstream gone → kept ${C1.slice(0, 7)}`, from: C1 }));
    const body = skillUpdateBody([moved('s0', bigDiff, files), moved('s1', bigDiff, files), moved('s2', bigDiff), ...rest]);
    expect(body.length).toBeLessThan(65_536);
    for (const part of ['### `s0`', '### `s1`', '### `s2`', '### Not moved', 'diff truncated', 'file list truncated', 'more (list truncated']) expect(body).toContain(part);
    // Every fence that opens also closes.
    expect((body.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(skillUpdateBody(Array.from({ length: 3000 }, (_, i) => moved(`s${i}`, bigDiff))).length).toBeLessThan(65_536);
  });
  it('lists the other changed files and keeps a name from the lock on one line', () => {
    const body = skillUpdateBody([moved('a', '@@ -1 +1 @@\n-one\n+two', ['M run.sh', 'A new\n# heading.txt']), { name: 'x`\n# Injected\n@bob', detail: 'invalid skill name → skipped', from: C1 }]);
    expect(body).toContain('```text\nM run.sh\nA new?# heading.txt\n```');
    expect(body).toContain("- `x'?# Injected?@‍bob`: invalid skill name → skipped");
    expect(body).not.toMatch(/^# /m);
  });
  it('links the commit per host and drops a query or fragment', () => {
    expect(commitLink('https://github.com/o/r.git?x=1#frag', C1)).toBe(`[${C1.slice(0, 7)}](https://github.com/o/r/commit/${C1})`);
    expect(commitLink('https://gitlab.example.com/g/sub/r', C1)).toBe(`[${C1.slice(0, 7)}](https://gitlab.example.com/g/sub/r/-/commit/${C1})`);
    expect(commitLink('https://git.example.com/o/r', C1)).toBe(`\`${C1.slice(0, 7)}\``);
  });
  it('adds recent recorded usage for each updated skill with records', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    const ts = '2026-11-10T00:00:00Z';
    const metrics = [
      JSON.stringify({ evt: 'run_complete', taskId: 't', ts, skillsUsed: ['a'], costUsd: 1 }),
      JSON.stringify({ evt: 'run_complete', taskId: 't', ts, skillsUsed: [], verdict: 'pass', costUsd: 1 }),
    ].join('\n');
    expect(skillUpdateBody([moved('a', '')], metrics, now)).toContain('Usage, last 30 days: 1 run, 100% pass rate.');
    const unreviewed = JSON.stringify({ evt: 'run_complete', taskId: 'u', ts, skillsUsed: ['a'], costUsd: 1 });
    expect(skillUpdateBody([moved('a', ''), moved('b', '')], unreviewed, now)).toContain('Usage, last 30 days: 1 run, no review verdict recorded.');
    // Records older than the window do not count.
    expect(skillUpdateBody([moved('a', '')], metrics, now + 40 * 86_400_000)).not.toContain('Usage, last 30 days');
  });
  it('reads usage from the metrics branch when the local file is missing or records no skills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tc-usage-'));
    try {
      const withSkills = JSON.stringify({ evt: 'run_complete', taskId: 'b', skillsUsed: ['a'], costUsd: 1 });
      const branch = async (): Promise<string> => withSkills;
      expect(await recordedMetrics(dir, branch)).toBe(withSkills);
      await mkdir(join(dir, '.taskcell', 'runs'), { recursive: true });
      const old = JSON.stringify({ evt: 'run_complete', taskId: 'l', costUsd: 1 });
      await writeFile(join(dir, '.taskcell', 'runs', 'metrics.jsonl'), old);
      expect(await recordedMetrics(dir, branch)).toBe(withSkills);
      expect(await recordedMetrics(dir, async () => { throw new Error('no remote'); })).toBe(old);
      const local = JSON.stringify({ evt: 'run_complete', taskId: 'l', skillsUsed: [], costUsd: 1 });
      await writeFile(join(dir, '.taskcell', 'runs', 'metrics.jsonl'), local);
      expect(await recordedMetrics(dir, branch)).toBe(local);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('omits recent usage when the updated skill has no records', () => {
    const metrics = JSON.stringify({ evt: 'run_complete', taskId: 't', ts: '2026-11-10T00:00:00Z', skillsUsed: ['other'], costUsd: 1 });
    expect(skillUpdateBody([moved('a', '')], metrics, Date.parse('2026-11-15T00:00:00Z'))).not.toContain('Usage, last 30 days');
  });
});

describe('skills update --pr leftovers', () => {
  const prRepo = async (): Promise<{ repo: string; skills: string; branches: () => Promise<string>; calls: string[]; deps: (source: SkillSource) => SkillsDeps }> => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
    await g('init', '-b', 'main');
    const skills = join(repo, 'skills');
    await add(stub({ [SRC]: C1 }, { [C1]: skillTree('one\n') }), {}, skills);
    await g('add', '.');
    await g('commit', '-m', 'init');
    const calls: string[] = [];
    return {
      repo,
      skills,
      calls,
      branches: async () => (await g('branch', '--format=%(refname:short)')).stdout,
      deps: (source) => ({
        source,
        contextDeps: { worktrees: new WorktreeManager(repo, join(root, 'wt')) },
        runner: async (file, args, cwd) => {
          calls.push(`${file} ${args[0]}`);
          if (file === 'gh') return 'https://github.com/o/repo/pull/1';
          if (args[0] === 'push' || args[0] === 'fetch') return '';
          return (await execa(file, args, { cwd })).stdout;
        },
      }),
    };
  };
  const newer = (): SkillSource => stub({ [SRC]: C2 }, { [C1]: skillTree('one\n'), [C2]: skillTree('two\n') });

  it('--dry-run --pr plans against the base branch and commits, pushes and opens nothing', async () => {
    const r = await prRepo();
    // The live checkout has a local edit; the base branch does not, and that is what a PR would be made from.
    await writeFile(join(r.skills, 'a/SKILL.md'), 'edited in the checkout');
    const lines: string[] = [];
    await skillsUpdate({ dir: r.skills, repo: r.repo, dryRun: true, pr: true }, r.deps(newer()), (l) => lines.push(l));
    expect(lines[0]).toBe(`a\t${C1.slice(0, 7)} → ${C2.slice(0, 7)} (+1 −1 lines)`);
    expect(r.calls).toEqual([]);
    expect(await r.branches()).toBe('main');
    expect(await readdir(join(root, 'wt'))).toEqual([]);
    expect(await readFile(join(r.skills, 'a/SKILL.md'), 'utf-8')).toBe('edited in the checkout');
  });
  it('leaves no branch or worktree when nothing moves, after a delivery, or with a relative --dir', async () => {
    const r = await prRepo();
    await skillsUpdate({ dir: r.skills, repo: r.repo, dryRun: false, pr: true }, r.deps(stub({ [SRC]: C1 }, {})), () => {});
    expect(await r.branches()).toBe('main');
    const lines: string[] = [];
    await skillsUpdate({ dir: 'skills', repo: r.repo, dryRun: false, pr: true }, r.deps(newer()), (l) => lines.push(l));
    expect(lines.at(-1)).toBe('opened https://github.com/o/repo/pull/1');
    expect(r.calls).toContain('git push');
    expect(await r.branches()).toBe('main');
    expect(await readdir(join(root, 'wt'))).toEqual([]);
  });
  it('refuses a lock with an invalid name before anything is pushed', async () => {
    const r = await prRepo();
    const lock = JSON.parse(await readFile(join(r.skills, 'skills.lock.json'), 'utf-8')) as { skills: unknown[] };
    await writeFile(join(r.skills, 'skills.lock.json'), lockWith(...(lock.skills as Array<Record<string, unknown>>), rawEntry('# Injected\nheading')));
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-am', 'bad lock'], { cwd: r.repo });
    await expect(skillsUpdate({ dir: r.skills, repo: r.repo, dryRun: false, pr: true }, r.deps(newer()), () => {})).rejects.toThrow(/not a plain directory name \("# Injected\?heading"\)/);
    expect(r.calls).toEqual([]);
    expect(await r.branches()).toBe('main');
  });
});

describe('hardened git source', () => {
  const upstream = async (): Promise<{ url: string; up: string; g: (...a: string[]) => Promise<{ stdout: string }> }> => {
    const up = join(root, 'up');
    await mkdir(join(up, 'skills/a'), { recursive: true });
    await mkdir(join(up, 'skills/b'), { recursive: true });
    const g = (...a: string[]) => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: up });
    await g('init', '-b', 'main');
    await writeFile(join(up, 'skills/a/SKILL.md'), 'a');
    await writeFile(join(up, 'skills/a/run.sh'), '#!/bin/sh\n');
    await chmod(join(up, 'skills/a/run.sh'), 0o755);
    await writeFile(join(up, 'skills/b/SKILL.md'), 'b');
    await writeFile(join(up, 'README.md'), 'not a skill');
    await g('add', '.');
    await g('commit', '-m', 'one');
    return { url: `file://${up}`, up, g };
  };
  it('checks out only the skill path, reuses the tree for the same commit, and removes it on dispose', async () => {
    const { url } = await upstream();
    const src = createGitSkillSource('file');
    const head = (await src.resolve(url)) ?? '';
    const tree = await src.fetch(url, head, 'skills/a');
    expect((await readdir(tree)).sort()).toEqual(['.git', 'skills']);
    expect(await readdir(join(tree, 'skills'))).toEqual(['a']);
    const files = await readSkillFiles(tree, 'skills/a');
    expect([files?.get('run.sh')?.exec, files?.get('SKILL.md')?.exec]).toEqual([true, false]);
    expect(await src.fetch(url, head, 'skills/b')).toBe(tree);
    expect((await readdir(join(tree, 'skills'))).sort()).toEqual(['a', 'b']);
    await src.dispose?.();
    await expect(lstat(tree)).rejects.toThrow();
  });
  it('lists a file path as an empty tree, but refuses the fetch when ls-tree fails for another reason', async () => {
    const { url } = await upstream();
    const src = createGitSkillSource('file');
    const head = (await src.resolve(url)) ?? '';
    // Not a tree: no listing, and readSkillFiles finds nothing there.
    const tree = await src.fetch(url, head, 'skills/a/SKILL.md');
    expect(await readSkillFiles(tree, 'skills/a/SKILL.md')).toBeUndefined();
    // Any other ls-tree failure (here: the repo is gone) is a refusal, not "nothing to check".
    await rm(join(tree, '.git'), { recursive: true, force: true });
    await expect(src.fetch(url, head, 'skills/a')).rejects.toThrow(/Could not fetch.*not a git repository/s);
    await src.dispose?.();
  });
  it('lists a path starting with ":" literally, so a symlink in it is refused', async () => {
    const { url, up, g } = await upstream();
    await mkdir(join(up, ':foo'));
    await writeFile(join(up, ':foo/SKILL.md'), 'x');
    await symlink('/etc/passwd', join(up, ':foo/link'));
    await g('--literal-pathspecs', 'add', '--', ':foo');
    await g('commit', '-m', 'colon');
    const src = createGitSkillSource('file');
    const head = (await src.resolve(url)) ?? '';
    await expect(src.fetch(url, head, ':foo')).rejects.toThrow(/:foo\/link is a symlink/);
    await src.dispose?.();
  });
  it('ignores env that redirects git or injects config, and follows a rewrite from a config file', async () => {
    const { url, up } = await upstream();
    const config = join(root, 'gitconfig');
    await writeFile(config, `[url "${url}"]\n\tinsteadOf = https://example.invalid/o/r\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_DIR', join(root, 'elsewhere'));
    vi.stubEnv('GIT_WORK_TREE', root);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${root}/missing.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://example.invalid/o/r');
    const src = createGitSkillSource('file');
    const head = (await src.resolve('https://example.invalid/o/r')) ?? '';
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const tree = await src.fetch('https://example.invalid/o/r', head, 'skills/b');
    expect(await readFile(join(tree, 'skills/b/SKILL.md'), 'utf-8')).toBe('b');
    await src.dispose?.();
    await expect(lstat(join(root, 'elsewhere'))).rejects.toThrow();
    expect((await readdir(up)).sort()).toEqual(['.git', 'README.md', 'skills']);
  });
  it('takes a ref literally, matches it exactly, and reports why git failed', async () => {
    const { url, g } = await upstream();
    // A branch whose name ends in another ref's full name: ls-remote would match it by tail.
    await g('branch', 'refs/heads/zz');
    const src = createGitSkillSource('file');
    expect(await src.resolve(url, 'zz')).toBeUndefined();
    await expect(src.resolve(url, '*')).rejects.toThrow(/Invalid ref/);
    await expect(src.resolve(url, 'ma[i]n')).rejects.toThrow(/Invalid ref/);
    const failure = await src.resolve(`file://${root}/missing`).catch((e: Error) => e.message);
    expect(failure).toMatch(/fatal:/);
    expect(failure).not.toMatch(/Command failed/);
  });
});

describe('parseCli skills options', () => {
  it('accepts --pr before the command, resolves a relative --dir against the repo, and takes --force', () => {
    expect(parseCli(['--pr', 'skills', 'update'], '/w')).toMatchObject({ kind: 'skills', action: 'update', pr: true });
    expect(parseCli(['skills', 'update', '--repo', '/x', '--dir', 'sk', '--pr'], '/w')).toMatchObject({ dir: '/x/sk', repo: '/x' });
    expect(parseCli(['skills', 'add', 'https://h/o/r', '--dir', 'sk'], '/w')).toMatchObject({ dir: '/w/sk' });
    expect(parseCli(['skills', 'list', '--repo', '/x', '--dir', 'sk'], '/w')).toMatchObject({ dir: 'sk' });
    expect(parseCli(['skills', 'update', '--force'], '/w')).toMatchObject({ force: true });
    expect(parseCli(['skills', 'update', '--dry-run', '--pr'], '/w')).toMatchObject({ dryRun: true, pr: true });
  });
  it('refuses --base without --pr and --force outside update', () => {
    expect(parseCli(['skills', 'update', '--base', 'dev'], '/w')).toEqual({ kind: 'error', message: '--base only applies to skills update --pr.' });
    expect(parseCli(['skills', 'list', '--base', 'dev'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['skills', 'check', '--force'], '/w')).toEqual({ kind: 'error', message: '--force only applies to skills update.' });
    expect(parseCli(['doctor', '--force'], '/w')).toMatchObject({ kind: 'error' });
  });
});
