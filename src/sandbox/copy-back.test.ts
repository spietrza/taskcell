import { describe, it, expect } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { execa } from 'execa';
import { assertWorkspaceWithinCeiling, classifyPath, copyBackBudget, exportWorkspace, prunedNames, CI_CONFIG_RULE } from './copy-back.js';
import { WorktreeManager } from '../worktree/manager.js';
import { SandboxError } from '../core/errors.js';
import type { CopyOutOptions, IsolatedSandboxProvider } from './provider.js';

type Tree = Record<string, string | { link: string }>;

/** Write `rel -> content` files (and `rel -> { link }` symlinks) under `root`, in insertion order. */
async function writeTree(root: string, entries: Tree): Promise<void> {
  for (const [rel, value] of Object.entries(entries)) {
    const dest = join(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    if (typeof value === 'string') await writeFile(dest, value);
    else await symlink(value.link, dest);
  }
}

/** A staging dir seeded with `writeTree`. */
async function stage(entries: Tree): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vg-copyback-'));
  await writeTree(root, entries);
  return root;
}

describe('assertWorkspaceWithinCeiling', () => {
  const sandbox = (stdout: string, exitCode = 0): Pick<IsolatedSandboxProvider, 'exec'> & { commands: string[] } => {
    const commands: string[] = [];
    return { commands, exec: async (command: string) => { commands.push(command); return { exitCode, stdout, stderr: '' }; } };
  };

  it('measures inside the sandbox with the pruned names quoted, and passes under the ceiling', async () => {
    const sb = sandbox('3 30\n');
    await expect(assertWorkspaceWithinCeiling(sb, '/workspace', 100, 10)).resolves.toBeUndefined();
    expect(sb.commands[0]).toContain(`-name '.git' -o -name 'node_modules' -o -name '.pnpm-store'`);
  });

  it('refuses before anything is copied when bytes or files pass the ceiling', async () => {
    await expect(assertWorkspaceWithinCeiling(sandbox('3 101\n'), '/workspace', 100, 10)).rejects.toThrow(SandboxError);
    await expect(assertWorkspaceWithinCeiling(sandbox('11 0\n'), '/workspace', 100, 10)).rejects.toThrow(/copy-back ceiling/);
  });

  it('skips (leaving the staging budget) when the measurement does not parse', async () => {
    await expect(assertWorkspaceWithinCeiling(sandbox('find: unknown predicate', 0), '/workspace', 1, 1)).resolves.toBeUndefined();
    await expect(assertWorkspaceWithinCeiling(sandbox('', 1), '/workspace', 1, 1)).resolves.toBeUndefined();
  });
});

describe('prunedNames', () => {
  it('is the list the ceiling prunes and copyFileOut excludes', () => {
    expect(prunedNames()).toEqual(['.git', 'node_modules', '.pnpm-store']);
  });
});

describe('classifyPath', () => {
  it('skips the pnpm content store a read-only sandbox puts at the workspace root, and node_modules/.git', async () => {
    const root = await stage({});
    try {
      for (const p of ['.pnpm-store/v11/files/00/abc', 'apps/desktop/node_modules/x', '.git', '.claude/skills/s.md', '.cursor/rules/r.mdc', '.vanguard/skills/s.md', '.taskcell/skills/s.md']) {
        expect(await classifyPath(root, p)).toBeDefined();
      }
      for (const p of ['src/pnpm-store.ts', 'docs/.pnpm-store.md', 'apps/desktop/src/App.tsx']) {
        expect(await classifyPath(root, p)).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies CI config, including nested .gitlab YAML and a case-variant .GITHUB directory', async () => {
    // Only the non-executed files need to exist: a path the rule matches is classified without an lstat.
    const root = await stage({ '.github/CODEOWNERS': '* @me\n', '.gitlab/merge_request_templates/default.md': 'tpl\n' });
    try {
      for (const p of ['.github/workflows/ci.yml', '.github/actions/build/action.yml', '.gitlab-ci.yml', '.gitlab/ci/job.yaml', '.GITHUB/WORKFLOWS/x.yml']) {
        expect(await classifyPath(root, p)).toBe(CI_CONFIG_RULE);
      }
      // Non-executed files under those directories still sync back.
      for (const p of ['.github/CODEOWNERS', '.gitlab/merge_request_templates/default.md']) {
        expect(await classifyPath(root, p)).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats an entry standing in for a CI config directory as CI config', async () => {
    const asFile = await stage({ '.github': 'not a directory\n' });
    const asSymlink = await stage({ elsewhere: 'x\n', '.gitlab': { link: 'elsewhere' } });
    const inside = await stage({ '.github/CODEOWNERS': '* @me\n', '.github/sneaky': { link: '/etc' } });
    try {
      expect(await classifyPath(asFile, '.github')).toBe(CI_CONFIG_RULE);
      expect(await classifyPath(asSymlink, '.gitlab')).toBe(CI_CONFIG_RULE);
      expect(await classifyPath(inside, join('.github', 'sneaky'))).toBe(CI_CONFIG_RULE);
      // A real directory, and a real file inside one, are not standing in for anything.
      expect(await classifyPath(inside, '.github')).toBeUndefined();
      expect(await classifyPath(inside, join('.github', 'CODEOWNERS'))).toBeUndefined();
    } finally {
      for (const root of [asFile, asSymlink, inside]) await rm(root, { recursive: true, force: true });
    }
  });
});

describe('copyBackBudget', () => {
  const file = (size: number): { isDirectory: () => boolean; size: number } => ({ isDirectory: () => false, size });
  const dir = { isDirectory: () => true, size: 1_000_000 };

  it('passes up to the ceiling, ignoring directories', () => {
    const charge = copyBackBudget(10, 2);
    charge(dir);
    charge(file(4));
    expect(() => charge(file(6))).not.toThrow();
  });

  it('throws a clear SandboxError once total size passes the ceiling', () => {
    const charge = copyBackBudget(10, 100);
    charge(file(10));
    expect(() => charge(file(1))).toThrow(SandboxError);
    expect(() => copyBackBudget(10, 100)(file(11))).toThrow(/copy-back ceiling/);
  });

  it('throws once the file count passes the ceiling', () => {
    const charge = copyBackBudget(1_000, 2);
    charge(file(0));
    charge(file(0));
    expect(() => charge(file(0))).toThrow(/copy-back ceiling/);
  });
});

/** A git repo at `worktree` with one committed README. */
async function seedRepo(worktree: string): Promise<void> {
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: worktree });
  await execa('git', ['config', 'user.name', 't'], { cwd: worktree });
  await writeFile(join(worktree, 'README.md'), '# r\n');
  await execa('git', ['add', '-A'], { cwd: worktree });
  await execa('git', ['commit', '-q', '-m', 'baseline'], { cwd: worktree });
}

/**
 * A fake sandbox that deliberately ignores `exclude` and stages everything, including a bogus `.git`
 * that would corrupt the worktree if it ever landed (the #748 bug): the host-side filter, not the tar
 * exclude, is what these tests prove holds the line. Records into `excludeArgs` the excludes it was
 * asked for.
 */
function fakeSandbox(files: Tree, excludeArgs: (readonly string[])[] = []): Pick<IsolatedSandboxProvider, 'exec' | 'copyFileOut'> {
  return {
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    copyFileOut: async (_sandboxPath: string, hostPath: string, options?: CopyOutOptions) => {
      excludeArgs.push(options?.exclude ?? []);
      await writeTree(hostPath, files);
    },
  };
}

describe('exportWorkspace', () => {
  it('runs a real workspace through copy-back: .git, node_modules and .pnpm-store never reach the worktree, CI config is dropped and reported, everything else lands in the diff (#748 regression)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'vg-copyback-wt-'));
    const staging = await mkdtemp(join(tmpdir(), 'vg-copyback-staging-'));
    try {
      await seedRepo(worktree);
      const headBefore = await readFile(join(worktree, '.git', 'HEAD'), 'utf8');

      const excludeArgs: (readonly string[])[] = [];
      const sandbox = fakeSandbox(
        {
          'README.md': '# r\n',
          'src/app.ts': 'export const x = 2;\n',
          '.git/HEAD': 'ref: refs/heads/sandbox-bogus\n',
          'node_modules/left-pad/index.js': 'module.exports = () => {};\n',
          '.pnpm-store/v3/files/00/abc': 'blob\n',
          '.gitlab-ci.yml': 'stages: [test]\n',
        },
        excludeArgs,
      );

      const report = await exportWorkspace(sandbox, '/workspace', staging, worktree);

      // copyFileOut was still asked to exclude the pruned names (the ceiling/source-exclude layer);
      // this fake proves the host filter catches them even when that layer is bypassed.
      expect(excludeArgs[0]).toEqual(['.git', 'node_modules', '.pnpm-store']);
      expect(report.dropped).toEqual(['.gitlab-ci.yml']);

      await expect(stat(join(worktree, 'node_modules'))).rejects.toThrow();
      await expect(stat(join(worktree, '.pnpm-store'))).rejects.toThrow();
      await expect(stat(join(worktree, '.gitlab-ci.yml'))).rejects.toThrow();
      expect(await readFile(join(worktree, '.git', 'HEAD'), 'utf8')).toEqual(headBefore);

      const wm = new WorktreeManager(worktree);
      const diff = await wm.diff(worktree);
      expect(diff).toContain('src/app.ts');
      expect(diff).not.toContain('node_modules');
      expect(diff).not.toContain('.pnpm-store');
      expect(diff).not.toContain('.gitlab-ci.yml');
      expect(await wm.changedPaths(worktree)).toEqual(['src/app.ts']);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  it('syncs a host repo checked out under a path that contains node_modules: the skips are matched relative to staging, never against the host path', async () => {
    const base = await mkdtemp(join(tmpdir(), 'vg-copyback-host-'));
    const worktree = join(base, 'node_modules', '.pnpm-store', 'repo');
    const staging = join(base, 'node_modules', 'staging');
    try {
      await mkdir(worktree, { recursive: true });
      await mkdir(staging, { recursive: true });
      await seedRepo(worktree);

      const report = await exportWorkspace(fakeSandbox({ 'README.md': '# r\n', 'src/app.ts': 'export const x = 2;\n' }), '/workspace', staging, worktree);

      expect(report.dropped).toEqual([]);
      expect(await readFile(join(worktree, 'src', 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
      expect(await new WorktreeManager(worktree).changedPaths(worktree)).toEqual(['src/app.ts']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('exportWorkspace deletion sync', () => {
  /** A real sandbox repo (baseline commit "vanguard baseline") exported into a worktree holding the same files. */
  const run = async (
    files: Tree,
    act: (sandboxDir: string) => Promise<void>,
    { baseline = true, hostOnly = {} }: { baseline?: boolean; hostOnly?: Tree } = {},
  ): Promise<{ base: string; worktree: string; report: Awaited<ReturnType<typeof exportWorkspace>>; changed: string[] }> => {
    const base = await mkdtemp(join(tmpdir(), 'vg-copyback-del-'));
    const [sandboxDir, worktree, staging] = ['sb', 'wt', 'staging'].map((n) => join(base, n)) as [string, string, string];
    for (const d of [sandboxDir, worktree, staging]) await mkdir(d, { recursive: true });
    await writeTree(sandboxDir, files);
    const gitInit = 'git init -q && git config user.email a@b && git config user.name n && git add -A';
    await execa('sh', ['-c', `${gitInit} && git commit -q -m "${baseline ? 'vanguard baseline' : 'something else'}"`], { cwd: sandboxDir });
    await seedRepo(worktree);
    await writeTree(worktree, files);
    await execa('git', ['add', '-A'], { cwd: worktree });
    await execa('git', ['commit', '-q', '-m', 'files'], { cwd: worktree });
    await writeTree(worktree, hostOnly);
    await act(sandboxDir);
    const sandbox: Pick<IsolatedSandboxProvider, 'exec' | 'copyFileOut'> = {
      exec: async (command: string) => {
        const r = await execa('sh', ['-c', command], { reject: false });
        return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout), stderr: String(r.stderr) };
      },
      copyFileOut: async (src: string, host: string) => {
        await cp(src, host, { recursive: true, filter: (p) => !p.split(sep).includes('.git') });
      },
    };
    const report = await exportWorkspace(sandbox, sandboxDir, staging, worktree);
    return { base, worktree, report, changed: await new WorktreeManager(worktree).changedPaths(worktree) };
  };
  const cleanup = (base: string): Promise<void> => rm(base, { recursive: true, force: true });

  it('deletes a file and the files of a deleted directory, shown as deletions in the diff', async () => {
    const { base, worktree, changed } = await run({ 'a.txt': 'a', 'dir/x.ts': 'x', 'dir/sub/y.ts': 'y', 'keep.txt': 'k' }, async (sb) => {
      await rm(join(sb, 'a.txt'));
      await rm(join(sb, 'dir'), { recursive: true });
    });
    try {
      await expect(stat(join(worktree, 'a.txt'))).rejects.toThrow();
      await expect(stat(join(worktree, 'dir'))).rejects.toThrow();
      expect(changed).toEqual(['a.txt', 'dir/sub/y.ts', 'dir/x.ts']);
    } finally {
      await cleanup(base);
    }
  });

  it('deletes the old path of a renamed file, staged or committed in the sandbox', async () => {
    const { base, worktree, changed } = await run({ 'old.ts': 'export const v = 1;\n', 'old2.ts': 'export const w = 2;\n' }, async (sb) => {
      await execa('sh', ['-c', 'git mv old.ts new.ts && git mv old2.ts new2.ts && git commit -q -m move'], { cwd: sb });
    });
    try {
      await expect(stat(join(worktree, 'old.ts'))).rejects.toThrow();
      await expect(stat(join(worktree, 'old2.ts'))).rejects.toThrow();
      expect(changed).toEqual(['new.ts', 'new2.ts', 'old.ts', 'old2.ts']);
    } finally {
      await cleanup(base);
    }
  });

  it('copes with a file replaced by a directory and a directory replaced by a file', async () => {
    const { base, worktree } = await run({ f: 'file', 'd/x.ts': 'x' }, async (sb) => {
      await rm(join(sb, 'f'));
      await rm(join(sb, 'd'), { recursive: true });
      await writeTree(sb, { 'f/inner.ts': 'i', d: 'now a file' });
    });
    try {
      expect(await readFile(join(worktree, 'f/inner.ts'), 'utf8')).toBe('i');
      expect(await readFile(join(worktree, 'd'), 'utf8')).toBe('now a file');
    } finally {
      await cleanup(base);
    }
  });

  it('does not apply a CI config deletion and reports it', async () => {
    const { base, worktree, report, changed } = await run({ '.github/workflows/ci.yml': 'on: push\n', '.github/CODEOWNERS': '* @me\n' }, async (sb) => {
      await rm(join(sb, '.github'), { recursive: true });
    });
    try {
      expect(await readFile(join(worktree, '.github/workflows/ci.yml'), 'utf8')).toBe('on: push\n');
      expect(report.dropped).toEqual(['.github/workflows/ci.yml']);
      await expect(stat(join(worktree, '.github/CODEOWNERS'))).rejects.toThrow();
      expect(changed).toEqual(['.github/CODEOWNERS']);
    } finally {
      await cleanup(base);
    }
  });

  it('never deletes a file that was not in the baseline (pruned names stay on the host)', async () => {
    const { base, worktree } = await run({ 'keep.txt': 'k' }, async () => undefined, { hostOnly: { 'node_modules/p/i.js': 'n' } });
    try {
      await stat(join(worktree, 'node_modules/p/i.js'));
      await stat(join(worktree, 'keep.txt'));
    } finally {
      await cleanup(base);
    }
  });

  it('skips deletion sync and says why when there is no baseline commit', async () => {
    const { base, worktree, report } = await run({ 'a.txt': 'a' }, async (sb) => rm(join(sb, 'a.txt')), { baseline: false });
    try {
      await stat(join(worktree, 'a.txt'));
      expect(report.deletionsSkipped).toContain('baseline commit not found');
    } finally {
      await cleanup(base);
    }
  });

  /** Export with a sandbox that reports exactly `stdout` as its deleted-file list. */
  const exportListing = async (stdout: string, outside: boolean): Promise<{ base: string; worktree: string; report: Awaited<ReturnType<typeof exportWorkspace>> }> => {
    const base = await mkdtemp(join(tmpdir(), 'vg-copyback-list-'));
    const [worktree, staging] = [join(base, 'wt'), join(base, 'staging')] as [string, string];
    await mkdir(worktree);
    await seedRepo(worktree);
    await writeTree(worktree, { 'node_modules/p/i.js': 'n', link: { link: '../outside' } });
    if (outside) await writeTree(base, { 'outside/victim.txt': 'v' });
    const sandbox: Pick<IsolatedSandboxProvider, 'exec' | 'copyFileOut'> = {
      exec: async (command: string) => (command.includes('git rev-list') ? { exitCode: 0, stdout, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }),
      copyFileOut: async (_s: string, host: string) => writeTree(host, { 'README.md': '# r\n' }),
    };
    return { base, worktree, report: await exportWorkspace(sandbox, '/workspace', staging, worktree) };
  };

  it('ignores absolute, .. , symlink-escaping and .git paths (any case), removing nothing outside the worktree', async () => {
    const listed = ['/etc/hostname', '../outside/victim.txt', 'a/../../outside/victim.txt', 'link/victim.txt', '.git/HEAD', '.GIT/HEAD'];
    const { base, worktree, report } = await exportListing(listed.join('\0') + '\0node_modules/p/i.js\0', true);
    try {
      expect(await readFile(join(base, 'outside/victim.txt'), 'utf8')).toBe('v');
      await stat(join(worktree, '.git/HEAD'));
      await stat(join(worktree, 'node_modules/p/i.js'));
      expect(report.ignoredDeletions).toEqual(listed);
    } finally {
      await cleanup(base);
    }
  });

  it('is quiet about a listed file whose directory is already gone, and reports a failed listing with its stderr', async () => {
    const { base, report } = await exportListing('gone/dir/f.ts\0', false);
    try {
      expect(report.ignoredDeletions).toEqual([]);
    } finally {
      await cleanup(base);
    }
    const failing: Pick<IsolatedSandboxProvider, 'exec' | 'copyFileOut'> = {
      exec: async (command: string) => (command.includes('git rev-list') ? { exitCode: 128, stdout: '', stderr: 'fatal: boom\n' } : { exitCode: 1, stdout: '', stderr: '' }),
      copyFileOut: async (_s: string, host: string) => writeTree(host, { 'README.md': '# r\n' }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'vg-copyback-fail-'));
    try {
      const wt = join(dir, 'wt');
      await mkdir(wt);
      const r = await exportWorkspace(failing, '/workspace', join(dir, 'st'), wt);
      expect(r.deletionsSkipped).toContain('fatal: boom');
    } finally {
      await cleanup(dir);
    }
  });
});
