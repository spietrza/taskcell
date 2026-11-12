import type { Stats } from 'node:fs';
import { lstatSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execa } from 'execa';
import { StatePathError } from './errors.js';

/** The per-repo directory name. */
export const STATE_DIR_NAME = '.taskcell';
/** The pre-rename name, still honoured during the compatibility window. */
export const LEGACY_STATE_DIR_NAME = '.vanguard';
/** Both names, for structural path checks that must recognise either. */
export const STATE_DIR_NAMES: readonly string[] = [STATE_DIR_NAME, LEGACY_STATE_DIR_NAME];

let legacyWarned = false;
const resolved = new Map<string, string>();
const shadowWarned = new Set<string>();
let ignoreHinted = false;

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The per-repo state directory every host-side run artifact and repo config (flows, app.json,
 * approver/gate policy) lives under: `.taskcell/` when it exists or when neither exists, else the
 * legacy `.vanguard/` with a one-time deprecation warning. One directory per repo for reads AND
 * writes, so a repo that still has `.vanguard/` keeps its run history in one place until it is
 * renamed (`mv .vanguard .taskcell`). lstat, not stat: a symlinked dir still counts as present and
 * assertStatePath then refuses it. Resolved once per process per repo root, so a `.taskcell/` that
 * appears mid-run (a pull, a rename) cannot move a long-running watch to a second directory.
 */
export function stateDir(repoPath: string): string {
  const key = resolve(repoPath);
  const cached = resolved.get(key);
  if (cached !== undefined) return join(repoPath, cached);
  const name = resolveStateDirName(repoPath);
  resolved.set(key, name);
  return join(repoPath, name);
}

function resolveStateDirName(repoPath: string): string {
  const current = join(repoPath, STATE_DIR_NAME);
  if (exists(current)) return STATE_DIR_NAME;
  const legacy = join(repoPath, LEGACY_STATE_DIR_NAME);
  if (!exists(legacy)) return STATE_DIR_NAME;
  if (!legacyWarned) {
    legacyWarned = true;
    console.warn(`taskcell: ${legacy} is deprecated — rename it to ${STATE_DIR_NAME}/ (it is still read and written for now)`);
  }
  return LEGACY_STATE_DIR_NAME;
}

/**
 * `git show <ref>:<dir>/<file>` for a committed config file, trying `.taskcell/` then the legacy
 * `.vanguard/`. Resolves to the file's text; rejects when neither path exists at `ref`. When both
 * exist, says once which one wins, so a legacy policy is never shadowed silently.
 */
export async function showStateFile(repoPath: string, ref: string, file: string): Promise<string> {
  let text: string;
  try {
    text = (await execa('git', ['show', `${ref}:${STATE_DIR_NAME}/${file}`], { cwd: repoPath, stripFinalNewline: false })).stdout;
  } catch {
    return (await execa('git', ['show', `${ref}:${LEGACY_STATE_DIR_NAME}/${file}`], { cwd: repoPath, stripFinalNewline: false })).stdout;
  }
  const legacyPath = `${LEGACY_STATE_DIR_NAME}/${file}`;
  if (!shadowWarned.has(legacyPath)) {
    const legacy = await execa('git', ['cat-file', '-e', `${ref}:${legacyPath}`], { cwd: repoPath, reject: false });
    if (legacy.exitCode === 0) {
      shadowWarned.add(legacyPath);
      console.warn(`taskcell: using ${STATE_DIR_NAME}/${file} at ${ref}; ${legacyPath} there is ignored`);
    }
  }
  return text;
}

/** Test seam: forget resolved state dirs and re-arm the one-time warnings. */
export function resetStateDirCache(): void {
  legacyWarned = false;
  ignoreHinted = false;
  resolved.clear();
  shadowWarned.clear();
}

/** Both state dir bases under `repoPath`: a target under either is checked against its own base. */
function baseFor(repoPath: string, target: string): string | null {
  for (const name of STATE_DIR_NAMES) {
    const base = join(repoPath, name);
    const rel = relative(base, target);
    if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return base;
  }
  return null;
}

/** True when `target` sits under `.taskcell/` or `.vanguard/` of `repoPath`. */
export function isUnderStateDir(repoPath: string, target: string): boolean {
  return baseFor(repoPath, target) !== null;
}

/**
 * Refuse a host write or delete at `target` (a path under the repo's state dir) that would follow a
 * symlink out of the checkout. The checkout is target-repo content, so a repo can commit the state dir,
 * any directory below it or the leaf file itself as a symlink. Walks every component from the state dir
 * down to `target` with lstat: a symlink anywhere refuses, and so does an intermediate component that
 * exists but is not a directory. Absent components are fine — the caller creates them as real ones.
 * The repo path itself is operator-chosen and may legitimately sit behind a symlink (e.g. macOS /tmp).
 */
export async function assertStatePath(repoPath: string, target: string): Promise<void> {
  const base = baseFor(repoPath, target);
  if (base === null) {
    throw new StatePathError(`${target} is outside ${stateDir(repoPath)} — refusing to operate on it`);
  }
  const rel = relative(base, target);
  const components = rel === '' ? [] : rel.split(sep);
  let current = base;
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = join(current, components[i] as string);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing below exists yet
      throw e;
    }
    if (info.isSymbolicLink()) throw new StatePathError(`${current} is a symlink — refusing to operate on it`);
    if (i < components.length - 1 && !info.isDirectory()) {
      throw new StatePathError(`${current} is not a directory — refusing to operate on it`);
    }
  }
}

/** {@link assertStatePath}, then create `dir` (and any missing parents) as real directories. */
export async function ensureStateDir(repoPath: string, dir: string): Promise<string> {
  await assertStatePath(repoPath, dir);
  const fresh = !exists(join(repoPath, STATE_DIR_NAME));
  await mkdir(dir, { recursive: true });
  if (fresh && !ignoreHinted && exists(join(repoPath, STATE_DIR_NAME))) await hintIfNotIgnored(repoPath);
  return dir;
}

/** One-time stderr hint: a repo that gitignored only `.vanguard/` would otherwise show `.taskcell/` as untracked. */
async function hintIfNotIgnored(repoPath: string): Promise<void> {
  ignoreHinted = true;
  // exit 1 = not ignored; 128 = not a git repo (no hint there).
  const r = await execa('git', ['check-ignore', '-q', STATE_DIR_NAME], { cwd: repoPath, reject: false });
  if (r.exitCode === 1) console.warn(`taskcell: created ${STATE_DIR_NAME}/ in ${repoPath} — add \`${STATE_DIR_NAME}/\` to .gitignore so run records are not committed`);
}

/** Guard against path traversal: a task id must name a single direct child of a state subdirectory. */
export function isSafeTaskId(taskId: string): boolean {
  return taskId !== '' && !taskId.includes('/') && !taskId.includes('\\') && !taskId.includes('..') && !isAbsolute(taskId);
}
