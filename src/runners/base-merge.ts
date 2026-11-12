import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { assertSafeBaseBranch, redactGitError } from '../core/base-branch.js';

/** Outcome of checking a PR branch against a fresh fetch of its base. */
export type BaseMerge =
  | { status: 'clean' }
  /** The check could not run (no remote, unrelated histories, fetch failed): nothing was changed. */
  | { status: 'skipped'; reason: string }
  /**
   * The base conflicts with the branch. With `unresolvable` empty, the base was merged into the branch
   * as a local commit that keeps the branch's side of each conflicted file, and the worktree holds the
   * conflict-marked versions of `files` as uncommitted edits for the agent to resolve. Otherwise (modify/
   * delete, rename or binary conflicts, which have no markers an agent could resolve) nothing was merged.
   */
  | { status: 'conflicted'; files: string[]; unresolvable: string[] };

const FETCH_TIMEOUT_MS = 60_000;
const git = (cwd: string, args: string[]): ReturnType<typeof execa> => execa('git', hostGitArgs(args), { cwd });
const MARKER_RE = /^<{7}( |$)/m;
const CLOSING_MARKER_RE = /^>{7}( |$)/m;

/** Fetch `base` and dry-run the merge with `git merge-tree`, which never touches the worktree or index. */
async function probeBase(worktreePath: string, base: string, remote: string): Promise<BaseMerge> {
  const fetch = await execa('git', hostGitArgs(['fetch', '--end-of-options', remote, base]), {
    cwd: worktreePath, reject: false, timeout: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (fetch.exitCode !== 0) return { status: 'skipped', reason: `could not fetch ${remote}/${base}: ${redactGitError({ stderr: fetch.stderr })}` };
  const probe = await execa('git', hostGitArgs(['merge-tree', '--write-tree', '--name-only', '-z', 'FETCH_HEAD', 'HEAD']), { cwd: worktreePath, reject: false });
  if (probe.exitCode === 0) return { status: 'clean' };
  if (probe.exitCode !== 1) return { status: 'skipped', reason: `merge check of ${remote}/${base} failed: ${redactGitError({ stderr: probe.stderr })}` };
  const [, ...rest] = String(probe.stdout).split('\0'); // tree oid, conflicted names, '', messages
  const end = rest.indexOf('');
  return { status: 'conflicted', files: rest.slice(0, end === -1 ? undefined : end), unresolvable: [] };
}

export interface MergeBaseOptions {
  remote?: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Check the worktree's branch against a fresh fetch of `base`. A clean branch is left untouched. A
 * conflicting one gets a real merge commit (history is never rewritten, so the push stays a
 * fast-forward) taking the branch's side of each conflicted file; the conflict-marked versions are put
 * back as uncommitted edits, so everything the revision diff shows is the agent's resolution and not the
 * base's own changes. Best-effort: any failure besides a conflict is `skipped` with the worktree unchanged.
 */
export async function mergeBaseIntoWorktree(worktreePath: string, base: string, opts: MergeBaseOptions = {}): Promise<BaseMerge> {
  assertSafeBaseBranch(base);
  const identity = ['-c', `user.name=${opts.authorName ?? 'Vanguard'}`, '-c', `user.email=${opts.authorEmail ?? 'vanguard@local'}`];
  const probe = await probeBase(worktreePath, base, opts.remote ?? 'origin');
  if (probe.status !== 'conflicted') return probe;

  const merge = await execa('git', hostGitArgs([...identity, 'merge', '--no-commit', '--no-ff', 'FETCH_HEAD']), { cwd: worktreePath, reject: false });
  const { stdout } = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const files = String(stdout).split('\0').filter((p) => p !== '');
  if (files.length === 0) {
    await abortMerge(worktreePath);
    return { status: 'skipped', reason: `merge of ${base} failed: ${redactGitError({ stderr: merge.stderr })}` };
  }
  const marked = new Map<string, string>();
  for (const file of files) {
    const text = await readFile(join(worktreePath, file), 'utf8').catch(() => '');
    if (MARKER_RE.test(text)) marked.set(file, text);
  }
  const unresolvable = files.filter((f) => !marked.has(f));
  if (unresolvable.length > 0) {
    await abortMerge(worktreePath);
    return { status: 'conflicted', files, unresolvable };
  }
  await git(worktreePath, ['checkout', '--ours', '--', ...files]);
  await git(worktreePath, ['add', '--', ...files]);
  await git(worktreePath, [
    ...identity,
    'commit', '--no-verify', '-m', `Merge ${base} into the branch`,
  ]);
  for (const [file, text] of marked) await writeFile(join(worktreePath, file), text);
  return { status: 'conflicted', files, unresolvable: [] };
}

async function abortMerge(worktreePath: string): Promise<void> {
  await git(worktreePath, ['merge', '--abort']).catch(() => git(worktreePath, ['reset', '--hard', 'HEAD']));
}

/** Of the originally conflicted `files`, those that still carry conflict markers in the worktree. */
export async function filesWithConflictMarkers(worktreePath: string, files: readonly string[]): Promise<string[]> {
  const unresolved: string[] = [];
  for (const file of files) {
    const text = await readFile(join(worktreePath, file), 'utf8').catch(() => '');
    if (MARKER_RE.test(text) || CLOSING_MARKER_RE.test(text)) unresolved.push(file);
  }
  return unresolved;
}

/** Backtick-quoted, plain-charset file list for a PR comment or log line (paths come from the repo and the sandbox). */
export function formatConflictFiles(files: readonly string[]): string {
  return files.length === 0 ? '(files not determined)' : files.map((f) => `\`${f.replace(/[^\w./ -]/g, '?')}\``).join(', ');
}
