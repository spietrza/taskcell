import type { Stats } from 'node:fs';
import { lstatSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execa } from 'execa';
import { StatePathError } from './errors.js';

/** The per-repo directory name. */
export const STATE_DIR_NAME = '.taskcell';
/** The pre-rename name, still honoured during the compatibility window. */
export const LEGACY_STATE_DIR_NAME = '.vanguard';
/** Both names, for structural path checks that must recognise either. */
export const STATE_DIR_NAMES: readonly string[] = [STATE_DIR_NAME, LEGACY_STATE_DIR_NAME];

let legacyWarned = false;

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
 * assertStatePath then refuses it.
 */
export function stateDir(repoPath: string): string {
  const current = join(repoPath, STATE_DIR_NAME);
  if (exists(current)) return current;
  const legacy = join(repoPath, LEGACY_STATE_DIR_NAME);
  if (!exists(legacy)) return current;
  if (!legacyWarned) {
    legacyWarned = true;
    console.warn(`taskcell: ${legacy} is deprecated — rename it to ${STATE_DIR_NAME}/ (it is still read and written for now)`);
  }
  return legacy;
}

/**
 * `git show <ref>:<dir>/<file>` for a committed config file, trying `.taskcell/` then the legacy
 * `.vanguard/`. Resolves to the file's text; rejects when neither path exists at `ref`.
 */
export async function showStateFile(repoPath: string, ref: string, file: string): Promise<string> {
  try {
    return (await execa('git', ['show', `${ref}:${STATE_DIR_NAME}/${file}`], { cwd: repoPath, stripFinalNewline: false })).stdout;
  } catch {
    return (await execa('git', ['show', `${ref}:${LEGACY_STATE_DIR_NAME}/${file}`], { cwd: repoPath, stripFinalNewline: false })).stdout;
  }
}

/** Test seam: re-arm the one-time legacy warning. */
export function resetLegacyStateDirWarning(): void {
  legacyWarned = false;
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
  const base = stateDir(repoPath);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StatePathError(`${target} is outside ${base} — refusing to operate on it`);
  }
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
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Guard against path traversal: a task id must name a single direct child of a state subdirectory. */
export function isSafeTaskId(taskId: string): boolean {
  return taskId !== '' && !taskId.includes('/') && !taskId.includes('\\') && !taskId.includes('..') && !isAbsolute(taskId);
}
