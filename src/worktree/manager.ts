import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeBaseBranch } from '../core/base-branch.js';
import { assertStatePath, isUnderStateDir, stateDir } from '../core/state-path.js';
import { WorktreeError } from '../core/errors.js';
import { hostGitArgs } from './host-git.js';

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Branch prefix for every Taskcell run. Conventional-Branch compliant (`<type>/<description>`, lowercase,
 * hyphens): the type is `chore` and `taskcell-` marks the namespace so `gc` reaps only Taskcell branches,
 * not humans' `chore/*`.
 */
export const TASKCELL_BRANCH_PREFIX = 'chore/taskcell-';

/** Prefix of runs minted before the rename (and still, see MINT_BRANCH_PREFIX); branches and open PRs under it are recognised. */
export const LEGACY_BRANCH_PREFIX = 'chore/vanguard-';

/**
 * Prefix new branches are minted under. Still the pre-rename one: the CI gates in .github/workflows (pr-review,
 * lessons, approver) and the shipped approver policy match `chore/vanguard-`; switch to TASKCELL_BRANCH_PREFIX once
 * those are updated.
 */
export const MINT_BRANCH_PREFIX = LEGACY_BRANCH_PREFIX;

/**
 * The prefixes the factory mints or has minted, current first: a branch under any other name is not factory-owned
 * (overlap holds, gc, the approver, revise's rebase, lessons). `chore/taskcell-` joins when MINT_BRANCH_PREFIX
 * switches to it, not before: until then only a human can have pushed a branch with that name.
 */
export const FACTORY_BRANCH_PREFIXES: readonly string[] = [...new Set([MINT_BRANCH_PREFIX, LEGACY_BRANCH_PREFIX])];

/** True for a branch minted by the factory, under the current or the pre-rename prefix. */
export function isFactoryBranch(branch: string | null | undefined): boolean {
  return typeof branch === 'string' && FACTORY_BRANCH_PREFIXES.some((p) => branch.startsWith(p));
}

export interface CreateOptions {
  /** Reuse an existing <prefix><id>-* branch instead of minting a new run id. */
  reuse?: boolean;
  /** Override the branch prefix (default MINT_BRANCH_PREFIX). White-label mode uses e.g. `feat/`. */
  branchPrefix?: string;
  /** Override the branch/path id (default taskId). White-label mode uses the bare issue number. */
  branchId?: string;
}

/** Short, unique-per-run id so re-running the same task never collides on an existing branch/path. */
const defaultRunId = (): string => randomUUID().slice(0, 8);

function parseWorktreeList(output: string): Array<{ path: string; branch: string }> {
  const result: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length);
    } else if (line === '' && cur.path && cur.branch) {
      result.push({ path: cur.path, branch: cur.branch });
      cur = {};
    }
  }
  if (cur.path && cur.branch) result.push({ path: cur.path, branch: cur.branch });
  return result;
}

export class WorktreeManager {
  constructor(
    private readonly repoPath: string,
    private readonly baseDir: string = join(stateDir(repoPath), 'worktrees'),
    private readonly newRunId: () => string = defaultRunId,
  ) {}

  async create(taskId: string, baseBranch: string = 'main', opts: CreateOptions = {}): Promise<Worktree> {
    assertSafeBaseBranch(baseBranch);
    const prefix = opts.branchPrefix ?? MINT_BRANCH_PREFIX;
    const id = opts.branchId ?? taskId;
    if (opts.reuse) {
      const existing = await this.findExistingBranch(id, prefix);
      if (existing) return existing;
      // A branch minted under the factory's other prefix (before or after the rename) is reused too.
      for (const other of prefix === MINT_BRANCH_PREFIX ? FACTORY_BRANCH_PREFIXES.filter((p) => p !== prefix) : []) {
        const existing = await this.findExistingBranch(id, other);
        if (existing) return existing;
      }
    }
    // Append a unique run id: disposeContext removes the worktree but not the branch, and a prior
    // run also leaves a remote branch, so reusing `<prefix><id>` collides on re-run.
    const name = `${id}-${this.newRunId()}`;
    const branch = `${prefix}${name}`;
    const path = join(this.baseDir, name);
    await this.assertInsideCheckout(path);
    try {
      await execa('git', hostGitArgs(['worktree', 'add', '-b', branch, path, baseBranch]), { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Failed to create worktree for ${taskId}`, { cause });
    }
  }

  /** The default baseDir is under `.taskcell`: a repo-committed symlink there must not place the
   * worktree (and every later copy-back write into it) outside the checkout. */
  private async assertInsideCheckout(path: string): Promise<void> {
    if (!isUnderStateDir(this.repoPath, path)) return; // a caller-chosen baseDir elsewhere
    try {
      await assertStatePath(this.repoPath, path);
    } catch (cause) {
      throw new WorktreeError(`Refusing to create worktree at ${path}`, { cause });
    }
  }

  private async findExistingBranch(id: string, prefix: string = MINT_BRANCH_PREFIX): Promise<Worktree | null> {
    let branchOut: string;
    let wtOut: string;
    try {
      [{ stdout: branchOut }, { stdout: wtOut }] = await Promise.all([
        execa('git', ['branch', '--list', `${prefix}${id}-*`], { cwd: this.repoPath }),
        execa('git', ['worktree', 'list', '--porcelain'], { cwd: this.repoPath }),
      ]);
    } catch (cause) {
      throw new WorktreeError(`Failed to query git state for ${id}`, { cause });
    }
    const branch = branchOut
      .split('\n')
      .map(b => b.trim().replace(/^[*+] /, ''))
      .find(Boolean);
    if (!branch) return null;

    // Use create()'s own path form: git reports a symlink-resolved path (e.g. /private/var on macOS),
    // which would not string-equal the join(baseDir, name) that create() returns.
    const name = branch.slice(prefix.length);
    const path = join(this.baseDir, name);

    // If a live worktree already uses this branch, reuse it.
    const live = parseWorktreeList(wtOut).find((w) => w.branch === `refs/heads/${branch}`);
    if (live) return { path, branch };

    // Branch exists but its worktree was removed — recreate the worktree on the existing branch.
    await this.assertInsideCheckout(path);
    try {
      await execa('git', hostGitArgs(['worktree', 'add', path, branch]), { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Failed to reuse worktree for ${id}`, { cause });
    }
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execa('git', hostGitArgs(['status', '--porcelain']), { cwd: worktreePath });
      return stdout.trim() !== '';
    } catch (cause) {
      throw new WorktreeError(`Failed to check worktree status ${worktreePath}`, { cause });
    }
  }

  async diff(worktreePath: string): Promise<string> {
    try {
      // -N (intent-to-add) so brand-new untracked files appear in `git diff HEAD`.
      await execa('git', hostGitArgs(['add', '-A', '-N']), { cwd: worktreePath });
      const { stdout } = await execa('git', hostGitArgs(['diff', 'HEAD']), { cwd: worktreePath });
      return stdout;
    } catch (cause) {
      throw new WorktreeError(`Failed to get worktree diff ${worktreePath}`, { cause });
    }
  }

  /**
   * The diff the secret gate scans: every file rendered as text, so no `.gitattributes` entry
   * (`-diff`, `binary`), textconv filter or external diff driver can hide content that `git add -A`
   * would still commit. `--text` also overrides git's own NUL-byte binary detection. Kept apart from
   * diff() so prompts, previews and run records keep their usual rendering.
   */
  async outgoingDiff(worktreePath: string): Promise<string> {
    try {
      await execa('git', ['add', '-A', '-N'], { cwd: worktreePath });
      const { stdout } = await execa(
        'git',
        ['-c', 'core.attributesFile=/dev/null', 'diff', 'HEAD', '--text', '--no-textconv', '--no-ext-diff', '--no-color'],
        { cwd: worktreePath },
      );
      return stdout;
    } catch (cause) {
      throw new WorktreeError(`Failed to get outgoing diff ${worktreePath}`, { cause });
    }
  }

  /**
   * Paths the worktree changes against HEAD, new files included and both sides of a rename listed.
   * NUL-separated, so no quoting, and unaffected by diff prefix or rename settings in the user's config.
   */
  async changedPaths(worktreePath: string): Promise<string[]> {
    try {
      await execa('git', hostGitArgs(['add', '-A', '-N']), { cwd: worktreePath });
      const { stdout } = await execa('git', hostGitArgs(['diff', 'HEAD', '--name-only', '--no-renames', '-z']), { cwd: worktreePath });
      return stdout.split('\0').filter((path) => path !== '');
    } catch (cause) {
      throw new WorktreeError(`Failed to list worktree changes ${worktreePath}`, { cause });
    }
  }

  /**
   * Commit messages in `<baseRef>..HEAD`, for the commit-message closing-keyword scan (a rebase
   * merge closes an issue per commit message, regardless of the PR body). Best-effort: returns []
   * (never throws) when `baseRef` can't be resolved locally.
   */
  async commitMessages(worktreePath: string, baseRef: string): Promise<string[]> {
    try {
      const { stdout } = await execa('git', hostGitArgs(['log', `${baseRef}..HEAD`, '--format=%B%x00']), { cwd: worktreePath });
      return stdout
        .split('\0')
        .map((m) => m.trim())
        .filter((m) => m !== '');
    } catch {
      return [];
    }
  }

  async remove(worktreePath: string, force: boolean = false): Promise<void> {
    try {
      await execa('git', ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], { cwd: this.repoPath });
    } catch (cause) {
      throw new WorktreeError(`Failed to remove worktree ${worktreePath}`, { cause });
    }
  }
}
