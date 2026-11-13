import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { assertSafeBaseBranch, redactGitError } from '../core/base-branch.js';
import { isCiConfigPath } from '../sandbox/copy-back.js';

/** Outcome of checking a PR branch against a fresh fetch of its base. */
export type BaseMerge =
  /** Git merges the base without conflicts. `merged`: a merge commit was made (only with `mergeClean`). */
  | { status: 'clean'; merged?: true }
  /** The check could not run (no remote, unrelated histories, fetch failed): nothing was changed. */
  | { status: 'skipped'; reason: string }
  /**
   * The base conflicts with the branch. With `unresolvable` empty, the base was merged into the branch
   * as a local commit that keeps the branch's side of each conflicted file, and the worktree holds the
   * conflict-marked versions of `files` as uncommitted edits for the agent to resolve. Otherwise (modify/
   * delete, rename or binary conflicts, which have no markers an agent could resolve, or a base that
   * changed CI config, which the push token may not carry into the branch) nothing was merged. The
   * exception is a factory-owned branch whose own commits leave CI config alone: it is rebased onto the
   * base instead (`rebased`), or rebuilt as one commit on the base with the merge tree when a rebase would
   * drift from it (earlier merge commits). Same marker handling, so the caller force-pushes with a lease and
   * no pushed commit carries a workflow change relative to the base. A hold lists the code conflicts and
   * says why in `reason`.
   */
  | { status: 'conflicted'; files: string[]; unresolvable: string[]; rebased?: true; reason?: string };

const FETCH_TIMEOUT_MS = 60_000;
const git = (cwd: string, args: string[]): ReturnType<typeof execa> => execa('git', hostGitArgs(args), { cwd });
/** The paths a NUL-separated (`-z`) git listing prints. */
const gitPaths = async (cwd: string, args: string[]): Promise<string[]> => String((await git(cwd, args)).stdout).split('\0').filter((p) => p !== '');
const MARKER_RE = /^<{7}( |$)/m;
const CLOSING_MARKER_RE = /^>{7}( |$)/m;

/** Fetch `base` and dry-run the merge with `git merge-tree`, which never touches the worktree or index. A conflict carries the merge tree (conflict-marked blobs). */
async function probeBase(worktreePath: string, base: string, remote: string): Promise<BaseMerge & { tree?: string | undefined }> {
  const fetch = await execa('git', hostGitArgs(['fetch', '--end-of-options', remote, base]), {
    cwd: worktreePath, reject: false, timeout: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (fetch.exitCode !== 0) return { status: 'skipped', reason: `could not fetch ${remote}/${base}: ${redactGitError({ stderr: fetch.stderr })}` };
  const probe = await execa('git', hostGitArgs(['merge-tree', '--write-tree', '--name-only', '-z', 'FETCH_HEAD', 'HEAD']), { cwd: worktreePath, reject: false });
  if (probe.exitCode === 0) return { status: 'clean' };
  if (probe.exitCode !== 1) return { status: 'skipped', reason: `merge check of ${remote}/${base} failed: ${redactGitError({ stderr: probe.stderr })}` };
  const [tree, ...rest] = String(probe.stdout).split('\0'); // tree oid, conflicted names, '', messages
  const end = rest.indexOf('');
  return { status: 'conflicted', files: rest.slice(0, end === -1 ? undefined : end), unresolvable: [], tree };
}

export interface MergeBaseOptions {
  remote?: string;
  authorName?: string;
  authorEmail?: string;
  /** The branch is the factory's (the caller checked its name); a rebase also requires every commit on it to be authored as the factory. */
  factoryOwned?: boolean;
  /** A branch that merges cleanly is still merged (a merge commit), instead of being left untouched. */
  mergeClean?: boolean;
}

/**
 * Check the worktree's branch against a fresh fetch of `base`. A clean branch is left untouched. A
 * conflicting one gets a real merge commit (so the push stays a fast-forward) taking the branch's side of each conflicted file; the conflict-marked versions are put
 * back as uncommitted edits, so everything the revision diff shows is the agent's resolution and not the
 * base's own changes. Best-effort: any failure besides a conflict is `skipped` with the worktree unchanged.
 */
export async function mergeBaseIntoWorktree(worktreePath: string, base: string, opts: MergeBaseOptions = {}): Promise<BaseMerge> {
  assertSafeBaseBranch(base);
  const identity = ['-c', `user.name=${opts.authorName ?? 'Taskcell'}`, '-c', `user.email=${opts.authorEmail ?? 'vanguard@local'}`];
  const probe = await probeBase(worktreePath, base, opts.remote ?? 'origin');
  if (probe.status === 'clean' && opts.mergeClean === true) return await mergeCleanBase(worktreePath, identity);
  if (probe.status !== 'conflicted') return probe;
  const { tree, files: probed } = probe;
  // A merge commit carrying the base's CI-config changes into the branch is a workflow update the push
  // token may not make (GitHub rejects the push and the run's work is lost): leave it to a human.
  const ciPathsIn = async (range: string): Promise<string[]> => (await gitPaths(worktreePath, ['diff', '--name-only', '-z', range])).filter((p) => isCiConfigPath(p));
  const ciPaths = await ciPathsIn('HEAD...FETCH_HEAD');
  if (ciPaths.length > 0) {
    // The hold names the code conflicts and why the branch stays put, never the base's CI files (the branch did not change them).
    const hold = (reason: string): BaseMerge => ({ status: 'conflicted', files: probed, unresolvable: probed, reason });
    if (opts.factoryOwned !== true) return hold('the base changed CI config and this branch was not created by the factory');
    if (tree === undefined) return hold('the base changed CI config and the merge could not be computed');
    // Rewriting the branch leaves no workflow change relative to the base, but it must not drop a human's
    // signature, and a commit of the branch that touched CI config (even one later reverted) would be replayed: both stay with a human.
    const range = ['log', 'FETCH_HEAD..HEAD'];
    const authors = String((await git(worktreePath, [...range, '--format=%ae'])).stdout).split('\n').filter((l) => l !== '');
    if (authors.some((e) => e !== (opts.authorEmail ?? 'vanguard@local'))) return hold('the base changed CI config and the branch has commits by a human');
    const ownCi = (await gitPaths(worktreePath, [...range, '--no-merges', '--no-renames', '--name-only', '--format=', '-z'])).filter((p) => isCiConfigPath(p));
    if (ownCi.length > 0) return hold('the base changed CI config and the branch changes CI config itself');
    const marked = new Map<string, string>();
    for (const file of probed) {
      const text = String((await git(worktreePath, ['show', `${tree}:${file}`]).catch(() => ({ stdout: '' }))).stdout);
      if (!MARKER_RE.test(text)) return hold('the base changed CI config and some conflicts (modify/delete, rename or binary) have no markers to resolve');
      marked.set(file, text);
    }
    const rewritten = (await rebaseOntoBase(worktreePath, identity, marked, tree)) || (await squashOntoBase(worktreePath, identity, marked, tree, base));
    if (!rewritten) return hold('the base changed CI config and the branch could not be rewritten onto it');
    for (const [file, text] of marked) await writeFile(join(worktreePath, file), text);
    return { status: 'conflicted', files: probed, unresolvable: [], rebased: true };
  }

  const merge = await execa('git', hostGitArgs([...identity, 'merge', '--no-commit', '--no-ff', 'FETCH_HEAD']), { cwd: worktreePath, reject: false });
  const files = await gitPaths(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']);
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

/** Merge FETCH_HEAD (already probed as conflict-free) into the branch; a failed merge is aborted and reported as a plain clean check. */
async function mergeCleanBase(worktreePath: string, identity: string[]): Promise<BaseMerge> {
  const before = String((await git(worktreePath, ['rev-parse', 'HEAD'])).stdout).trim();
  const merge = await execa('git', hostGitArgs([...identity, 'merge', '--no-edit', '--no-verify', 'FETCH_HEAD']), { cwd: worktreePath, reject: false });
  if (merge.exitCode !== 0) {
    await abortMerge(worktreePath);
    return { status: 'clean' };
  }
  const after = String((await git(worktreePath, ['rev-parse', 'HEAD'])).stdout).trim();
  return after === before ? { status: 'clean' } : { status: 'clean', merged: true };
}

/**
 * Replay the branch onto FETCH_HEAD, keeping the branch's side at every conflicted stop. A rebase drops merge
 * commits and taking a commit's side at a per-commit stop can drop base changes the final merge keeps: unless
 * the result matches the merge tree outside the conflicted files (`marked`), the branch is reset to where it
 * was and `false` is returned.
 */
async function rebaseOntoBase(worktreePath: string, identity: string[], marked: Map<string, string>, tree: string): Promise<boolean> {
  const origHead = String((await git(worktreePath, ['rev-parse', 'HEAD'])).stdout).trim();
  const run = async (args: string[]): Promise<{ exitCode?: number | undefined }> =>
    execa('git', hostGitArgs([...identity, ...args]), { cwd: worktreePath, reject: false, env: { GIT_EDITOR: 'true' } });
  const restore = async (): Promise<false> => {
    await git(worktreePath, ['rebase', '--abort']).catch(() => undefined);
    await git(worktreePath, ['reset', '--hard', origHead]).catch(() => undefined);
    return false;
  };
  try {
    let result = await run(['rebase', '--empty=drop', 'FETCH_HEAD']);
    while (result.exitCode !== 0) {
      const stopped = await gitPaths(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']);
      const markerless = (await Promise.all(stopped.map((f) => readFile(join(worktreePath, f), 'utf8').catch(() => '')))).some((t) => !MARKER_RE.test(t));
      if (stopped.length === 0 || markerless) return await restore();
      await git(worktreePath, ['checkout', '--theirs', '--', ...stopped]);
      await git(worktreePath, ['add', '--', ...stopped]);
      result = await run(['rebase', '--continue']);
    }
    // The pushed tree must be the merge of the final states (bar the conflicted files the agent resolves).
    return (await driftsFromTree(worktreePath, tree, marked)) ? await restore() : true;
  } catch {
    return await restore();
  }
}

/**
 * Rebuild the branch as one commit on FETCH_HEAD with the probe's merge tree, taking the branch's side of each
 * conflicted file (the caller puts the markers back). Keeps what merge commits carried and leaves no workflow
 * change relative to the base. On failure the branch is reset to where it was and `false` is returned.
 */
async function squashOntoBase(worktreePath: string, identity: string[], marked: Map<string, string>, tree: string, base: string): Promise<boolean> {
  const origHead = String((await git(worktreePath, ['rev-parse', 'HEAD'])).stdout).trim();
  try {
    await git(worktreePath, ['reset', '--hard', 'FETCH_HEAD']);
    await git(worktreePath, ['read-tree', '-u', '--reset', tree]);
    await git(worktreePath, ['checkout', origHead, '--', ...marked.keys()]);
    await git(worktreePath, [...identity, 'commit', '--no-verify', '--allow-empty', '-m', `Update the branch onto ${base}`]);
    if (!(await driftsFromTree(worktreePath, tree, marked))) return true;
  } catch { /* fall through to the reset */ }
  await git(worktreePath, ['reset', '--hard', origHead]).catch(() => undefined);
  return false;
}

/** Whether HEAD differs from the merge tree anywhere outside the conflicted files the agent resolves. */
async function driftsFromTree(worktreePath: string, tree: string, marked: Map<string, string>): Promise<boolean> {
  return (await gitPaths(worktreePath, ['diff', '--no-renames', '--name-only', '-z', tree, 'HEAD'])).some((p) => !marked.has(p));
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
