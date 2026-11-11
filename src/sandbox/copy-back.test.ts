import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { assertWorkspaceWithinCeiling, copyBackBudget, exportWorkspace, prunedNames, PATH_POLICY } from './copy-back.js';
import { WorktreeManager } from '../worktree/manager.js';
import { SandboxError } from '../core/errors.js';
import type { CopyOutOptions, IsolatedSandboxProvider } from './provider.js';

describe('assertWorkspaceWithinCeiling', () => {
  const sandbox = (stdout: string, exitCode = 0): Pick<IsolatedSandboxProvider, 'exec'> & { commands: string[] } => {
    const commands: string[] = [];
    return { commands, exec: async (command: string) => { commands.push(command); return { exitCode, stdout, stderr: '' }; } };
  };

  it('measures inside the sandbox with node_modules and .git pruned, and passes under the ceiling', async () => {
    const sb = sandbox('3 30\n');
    await expect(assertWorkspaceWithinCeiling(sb, '/workspace', 100, 10)).resolves.toBeUndefined();
    expect(sb.commands[0]).toContain('-name .git -o -name node_modules -o -name .pnpm-store');
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

describe('PATH_POLICY', () => {
  const skips = (path: string): boolean => PATH_POLICY.some((rule) => rule.match.test(path));

  it('skips the pnpm content store a read-only sandbox puts at the workspace root, and node_modules/.git', () => {
    for (const p of ['/s/.pnpm-store/v11/files/00/abc', '/s/apps/desktop/node_modules/x', '/s/.git']) expect(skips(p)).toBe(true);
    for (const p of ['/s/src/pnpm-store.ts', '/s/docs/.pnpm-store.md', '/s/apps/desktop/src/App.tsx']) expect(skips(p)).toBe(false);
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

describe('exportWorkspace', () => {
  it('runs a real workspace through copy-back: .git, node_modules and .pnpm-store never reach the worktree, CI config is dropped and reported, everything else lands in the diff (#748 regression)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'vg-copyback-wt-'));
    const staging = await mkdtemp(join(tmpdir(), 'vg-copyback-staging-'));
    try {
      await execa('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
      await execa('git', ['config', 'user.email', 't@t'], { cwd: worktree });
      await execa('git', ['config', 'user.name', 't'], { cwd: worktree });
      await writeFile(join(worktree, 'README.md'), '# r\n');
      await execa('git', ['add', '-A'], { cwd: worktree });
      await execa('git', ['commit', '-q', '-m', 'baseline'], { cwd: worktree });
      const headBefore = await readFile(join(worktree, '.git', 'HEAD'), 'utf8');

      // The fake sandbox deliberately ignores `exclude` and stages everything, including a bogus
      // `.git` that would corrupt the worktree if it ever landed (the #748 bug): the host-side
      // filter, not the tar exclude, is what this test is proving holds the line.
      const excludeArgs: (readonly string[])[] = [];
      const write = async (hostPath: string, rel: string, content: string): Promise<void> => {
        const dest = join(hostPath, rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content);
      };
      const sandbox: Pick<IsolatedSandboxProvider, 'exec' | 'copyFileOut'> = {
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
        copyFileOut: async (_sandboxPath: string, hostPath: string, options?: CopyOutOptions) => {
          excludeArgs.push(options?.exclude ?? []);
          await write(hostPath, 'README.md', '# r\n');
          await write(hostPath, 'src/app.ts', 'export const x = 2;\n');
          await write(hostPath, '.git/HEAD', 'ref: refs/heads/sandbox-bogus\n');
          await write(hostPath, 'node_modules/left-pad/index.js', 'module.exports = () => {};\n');
          await write(hostPath, '.pnpm-store/v3/files/00/abc', 'blob\n');
          await write(hostPath, '.gitlab-ci.yml', 'stages: [test]\n');
        },
      };

      const report = await exportWorkspace(sandbox, '/workspace', staging, worktree);

      // copyFileOut was still asked to exclude the pruned names (the ceiling/source-exclude layer);
      // this fake proves the host filter catches them even when that layer is bypassed.
      expect(excludeArgs[0]).toEqual(prunedNames());

      expect(report.synced).toContain('README.md');
      expect(report.synced).toContain('src/app.ts');
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
});
