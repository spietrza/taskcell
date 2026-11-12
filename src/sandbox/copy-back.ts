import { cp, lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SandboxError } from '../core/errors.js';
import type { IsolatedSandboxProvider } from './provider.js';

/**
 * One path policy drives everything that leaves the sandbox: the copy-back ceiling (what `find`
 * prunes before anything is copied), the `copyFileOut` tar excludes (what the sandbox never streams
 * out at all), and the host-side filter that decides what lands in the worktree. Each rule is a
 * single line; a skip that needs adding goes here and nowhere else.
 *
 * `name`: a bare directory/file name, matched at any depth by GNU/busybox `find -prune` and `tar
 * --exclude` alike, so the entry is pruned at the *source* — it never reaches staging. Omit it for a
 * skip that can only be recognised by path shape (e.g. nested CI YAML under `.gitlab/`), which can
 * only be filtered host-side, after it has already been staged.
 *
 * Every rule drops silently except CI_CONFIG_RULE, whose matches are tracked and diffed against the
 * worktree — see `exportWorkspace`'s `dropped` result.
 */
export interface PathSkipRule {
  readonly name?: string;
  readonly match: RegExp;
}

/**
 * Hard security boundary (see CLAUDE.md): an agent must never be able to write CI config that gets
 * committed and pushed. Case-insensitive and `s` lets `.*` cross a newline in a file name, so nothing
 * slips past on a case-insensitive filesystem or via a crafted name. The one rule whose drops are
 * reported rather than silent, and the one `isCiConfigPath` answers for the final-diff backstop.
 */
export const CI_CONFIG_RULE: PathSkipRule = {
  match: /(^|[\\/])\.github[\\/]workflows([\\/]|$)|(^|[\\/])\.github[\\/]actions([\\/]|$)|(^|[\\/])\.gitlab-ci\.yml$|(^|[\\/])\.gitlab[\\/].*\.ya?ml$/is,
};

export const PATH_POLICY: readonly PathSkipRule[] = [
  // A linked worktree's .git is a file pointer; copying it corrupts the worktree.
  { name: '.git', match: /(^|[\\/])\.git([\\/]|$)/ },
  // Gitignored, huge, and its .bin symlinks make fs.cp throw EINVAL.
  { name: 'node_modules', match: /(^|[\\/])node_modules([\\/]|$)/ },
  // Under a read-only rootfs /workspace is its own tmpfs, so pnpm puts its content store at the
  // mount root, /workspace/.pnpm-store — the whole store would otherwise land in the PR.
  { name: '.pnpm-store', match: /(^|[\\/])\.pnpm-store([\\/]|$)/ },
  // Plugin-installed symlinks pointing at absolute paths inside the sandbox — copying them yields
  // dangling symlinks that make fs.cp throw ENOENT via stat.
  { match: /(^|[\\/])\.claude[\\/]skills([\\/]|$)/ },
  // Injected .mdc skill rules — load-bearing exclusion, these must not land in PRs.
  { match: /(^|[\\/])\.cursor[\\/]rules([\\/]|$)/ },
  // Skill bodies copied in as pointer targets for codex/cursor providers.
  { match: /(^|[\\/])\.(?:taskcell|vanguard)[\\/]skills([\\/]|$)/ },
  CI_CONFIG_RULE,
];

/** A `.github` or `.gitlab` entry that is not a real directory (symlink or file) could stand in for the
 * directory and point at CI files kept elsewhere. A symlink inside one of those directories could do
 * the same for a subdirectory. Checked only for CI_CONFIG_RULE: this is specifically about
 * impersonating a CI config directory, not a generic skip. */
const CI_DIR_NAME = /(^|[\\/])\.git(hub|lab)$/i;
const IN_CI_DIR = /(^|[\\/])\.git(hub|lab)[\\/]/i;

async function standsInForCiDir(stagingRoot: string, rel: string): Promise<boolean> {
  const isCiDirItself = CI_DIR_NAME.test(rel);
  if (!isCiDirItself && !IN_CI_DIR.test(rel)) return false;
  const info = await lstat(join(stagingRoot, rel));
  return isCiDirItself ? !info.isDirectory() : info.isSymbolicLink();
}

/** Which policy rule (if any) drops `rel`. `rel` is relative to `stagingRoot`, forward or back slash. */
export async function classifyPath(stagingRoot: string, rel: string): Promise<PathSkipRule | undefined> {
  if (CI_CONFIG_RULE.match.test(rel) || (await standsInForCiDir(stagingRoot, rel))) return CI_CONFIG_RULE;
  return PATH_POLICY.find((rule) => rule.match.test(rel));
}

/** Bare names pruned at the source (never archived out of the sandbox at all) — see PathSkipRule.name. */
export function prunedNames(): string[] {
  return PATH_POLICY.flatMap((rule) => (rule.name !== undefined ? [rule.name] : []));
}

/** The `find`+`awk` ceiling measurement, with every `name` rule pruned — same names copyFileOut excludes. */
export function ceilingFindCommand(workdir: string): string {
  const prune = prunedNames()
    .map((name) => `-name '${name}'`)
    .join(' -o ');
  return `find ${workdir} \\( ${prune} \\) -prune -o -type f -printf '%s\\n' | awk '{n++; s+=$1} END {printf "%d %d\\n", n, s}'`;
}

// ponytail: copy-back ceiling of 2 GiB / 200,000 files (pruned names not counted). Far above any real
// change; it exists so a sandbox cannot fill the host disk through staging and the worktree.
export const COPY_BACK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const COPY_BACK_MAX_FILES = 200_000;
// The stream cap counts tar bytes: up to ~1 KiB of header and padding per member on top of the file
// bytes the ceiling measured, so a workspace that passes the ceiling never trips the stream cap.
const STREAM_OVERHEAD_PER_FILE_BYTES = 1024;

function copyBackCeilingError(maxBytes: number, maxFiles: number): SandboxError {
  return new SandboxError(
    `copy-back: sandbox workspace exceeds the copy-back ceiling (${maxFiles} files / ${Math.round(maxBytes / 1024 / 1024)} MiB, ${prunedNames().join('/')} excluded); the run stops and nothing is committed — remove build output or large generated files from the workspace`,
  );
}

/**
 * First check, before anything leaves the sandbox: count files and bytes under the workspace (pruned
 * names skipped) and refuse when over the ceiling. Output that does not parse (an image without GNU
 * find) skips this check; the staging-to-worktree budget below still applies.
 */
export async function assertWorkspaceWithinCeiling(
  sandbox: Pick<IsolatedSandboxProvider, 'exec'>,
  workdir: string,
  maxBytes = COPY_BACK_MAX_BYTES,
  maxFiles = COPY_BACK_MAX_FILES,
): Promise<void> {
  const res = await sandbox.exec(ceilingFindCommand(workdir));
  const m = /^(\d+) (\d+)\s*$/.exec(res.stdout);
  if (res.exitCode !== 0 || m === null) return;
  if (Number(m[1]) > maxFiles || Number(m[2]) > maxBytes) throw copyBackCeilingError(maxBytes, maxFiles);
}

/**
 * Second check: a running total over the entries copy-back syncs into the worktree; throws a SandboxError
 * as soon as the total size or file count passes the ceiling. Directories count toward neither. A throw
 * mid-copy leaves the worktree partly written, but the error ends the run before anything is committed.
 */
export function copyBackBudget(maxBytes = COPY_BACK_MAX_BYTES, maxFiles = COPY_BACK_MAX_FILES): (entry: { isDirectory: () => boolean; size: number }) => void {
  let bytes = 0;
  let files = 0;
  return (entry) => {
    if (entry.isDirectory()) return;
    bytes += entry.size;
    files += 1;
    if (bytes > maxBytes || files > maxFiles) throw copyBackCeilingError(maxBytes, maxFiles);
  };
}

/** Larger dropped files are reported as changed unread: CI YAML is small, and the sandbox chose the size. */
const MAX_COMPARED_BYTES = 4 * 1024 * 1024;

/**
 * Collect the files under a dropped CI config path whose sandbox copy is new or differs from the
 * worktree. Unchanged files are dropped on every copy-back; only these mean the agent's work is
 * missing from the diff. A file the agent deleted is not in staging, so it is not reported. The walk
 * is sequential: the sandbox chose how many files there are, and a parallel walk can run out of file
 * descriptors.
 */
async function collectChangedFiles(staging: string, worktree: string, rel: string, changed: string[]): Promise<void> {
  const src = join(staging, rel);
  const dest = join(worktree, rel);
  const info = await lstat(src);
  if (info.isDirectory()) {
    for (const name of await readdir(src)) await collectChangedFiles(staging, worktree, join(rel, name), changed);
    return;
  }
  // Compare a symlink by its target and never read through it: the sandbox chose where it points.
  if (info.isSymbolicLink()) {
    if ((await readlink(src)) !== (await readlink(dest).catch(() => undefined))) changed.push(rel);
    return;
  }
  const destInfo = info.isFile() ? await lstat(dest).catch(() => undefined) : undefined;
  if (destInfo?.isFile() !== true || destInfo.size !== info.size || info.size > MAX_COMPARED_BYTES) {
    changed.push(rel);
    return;
  }
  if (!(await readFile(src)).equals(await readFile(dest))) changed.push(rel);
}

export interface CopyBackReport {
  /** CI config paths (see CI_CONFIG_RULE) whose sandbox copy is new or differs from what was already
   * in the worktree — dropped, but worth a human's attention. What synced is the worktree itself. */
  dropped: string[];
}

export interface ExportWorkspaceOptions {
  maxBytes?: number;
  maxFiles?: number;
}

/**
 * The one interface for what leaves the sandbox: export the workspace at `workdir` into `worktreePath`
 * via `stagingDir`, then report the CI config that was dropped. The ceiling, copyFileOut's source
 * excludes and the host-side filter all come from the same PATH_POLICY, so they can never disagree.
 */
export async function exportWorkspace(
  sandbox: Pick<IsolatedSandboxProvider, 'exec' | 'copyFileOut'>,
  workdir: string,
  stagingDir: string,
  worktreePath: string,
  { maxBytes = COPY_BACK_MAX_BYTES, maxFiles = COPY_BACK_MAX_FILES }: ExportWorkspaceOptions = {},
): Promise<CopyBackReport> {
  await assertWorkspaceWithinCeiling(sandbox, workdir, maxBytes, maxFiles);
  // Skipped at the source too: pruned names never sync back and can dwarf the workspace.
  await sandbox.copyFileOut(workdir, stagingDir, {
    exclude: prunedNames(),
    maxBytes: maxBytes + maxFiles * STREAM_OVERHEAD_PER_FILE_BYTES,
  });

  const charge = copyBackBudget(maxBytes, maxFiles);
  const dropped: string[] = [];
  await cp(stagingDir, worktreePath, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: async (src) => {
      const rel = relative(stagingDir, src);
      if (rel === '') return true;
      const rule = await classifyPath(stagingDir, rel);
      if (rule !== undefined) {
        if (rule === CI_CONFIG_RULE) dropped.push(rel);
        return false;
      }
      charge(await lstat(src));
      return true;
    },
  });

  // A comparison that fails reports the whole dropped path, so an edit is never hidden.
  const changed: string[] = [];
  for (const rel of dropped) {
    await collectChangedFiles(stagingDir, worktreePath, rel, changed).catch(() => changed.push(rel));
  }
  return { dropped: changed };
}

/** True when `path` is CI config by CI_CONFIG_RULE (`.github/workflows`, `.github/actions`,
 * `.gitlab-ci.yml`, `.gitlab/` YAML) or a `.github`/`.gitlab` entry standing in for that directory —
 * the same question `classifyPath` asks while copying, asked here against a plain path string
 * (no lstat), for the final-diff backstop in core/taskcell.ts. */
export function isCiConfigPath(path: string): boolean {
  return CI_CONFIG_RULE.match.test(path) || CI_DIR_NAME.test(path);
}
