// The hub's folder browser behind the Add-project picker (`browse_dirs`) and its confinement guard.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';

/** Hard cap on entries returned by a single `browseDirs` call — guards against a directory with an
 * enormous number of children (e.g. a flat cache dir) blowing up the response. */
export const MAX_BROWSE_ENTRIES = 2000;

export interface DirEntry {
  name: string;
  path: string; // absolute path
  /** true if this directory directly contains a `.git` entry (file or dir — a worktree's .git is a file). */
  isGitRepo: boolean;
  /** true if this directory directly contains a `.taskcell` entry. */
  hasTaskcell: boolean;
}

export interface DirListing {
  /** The directory that was listed (absolute, realpath'd). */
  path: string;
  /** Absolute path of the parent directory, or undefined if `path` IS the confinement root (no further up). */
  parent?: string;
  /** true if the listed directory itself directly contains a `.git` entry. */
  isGitRepo?: boolean;
  entries: DirEntry[];
}

/** True if `child` is `root` itself or a real descendant of it (both already realpath'd, so absolute).
 * Pure containment: a root that already ends in a separator (`/`, `D:\`, a UNC share root) holds
 * what is below it and nothing else, so `D:\` never admits `C:\`. `pathSep` is a parameter so
 * Windows semantics can be tested on any host. */
export function isWithinRoot(root: string, child: string, pathSep: string = sep): boolean {
  return child === root || child.startsWith(root.endsWith(pathSep) ? root : root + pathSep);
}

/** A typed path with a leading `~` means the hub user's home, as in a shell (the confinement below still applies). */
function expandHome(path: string): string {
  return path === '~' || /^~[\\/]/.test(path) ? join(homedir(), path.slice(1)) : path;
}

/**
 * The real path a typed path names. A relative one is taken from the hub's working directory, else from the
 * browse root (where the picker opens). `~user` is not expanded: it is a folder of that name or it does not exist.
 */
async function realTypedPath(root: string, path: string): Promise<string> {
  const typed = expandHome(path);
  for (const candidate of isAbsolute(typed) ? [typed] : [resolve(typed), resolve(root, typed)]) {
    try {
      return await realpath(candidate);
    } catch {
      // try the next reading of it
    }
  }
  throw new BadRequestError('path does not exist');
}

/** Names the root, so the refusal says where a repository has to be. */
const escapesRoot = (realRoot: string): BadRequestError =>
  new BadRequestError(`path escapes the browse root: this hub only opens folders in ${realRoot} or below it, so the repository must be there`);

/** `add_project`'s confinement: the same realpath-both-sides guard `browseDirs` applies, so a
 * project can only come from somewhere the browse picker could have reached. Returns the realpath,
 * which is what the caller should store. `anywhere` (the desktop app's own hub) lifts the confinement. */
export async function assertWithinBrowseRoot(root: string, path: string, anywhere = false): Promise<string> {
  const target = await realTypedPath(root, path);
  if (anywhere) return target;
  const realRoot = await realpath(root);
  if (!isWithinRoot(realRoot, target)) throw escapesRoot(realRoot);
  return target;
}

/** True if an entry (file or dir, any type) exists directly inside `dir` under `name`. */
async function hasMarker(dir: string, name: string): Promise<boolean> {
  try {
    await lstat(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * List the subdirectories of `requestedPath` (default: `root` itself), confined to `root`.
 * Both `root` and the requested path are realpath'd before comparison — this is the traversal
 * guard: joining a `..`-laden path and realpath-ing it catches both literal `..` segments and
 * symlink escapes. Requests that resolve outside `root` throw `BadRequestError`. With `anywhere`
 * (the desktop app's own hub) `root` is only where the picker opens: any directory may be listed,
 * and `parent` goes up to the filesystem root.
 */
export async function browseDirs(root: string, requestedPath?: string, anywhere = false): Promise<DirListing> {
  const realRoot = await realpath(root);
  const target = requestedPath ? await realTypedPath(realRoot, requestedPath) : realRoot;

  if (!anywhere && !isWithinRoot(realRoot, target)) {
    throw escapesRoot(realRoot);
  }

  const dirents = await readdir(target, { withFileTypes: true });
  // Non-directories (including symlinks, which are skipped rather than resolved to classify
  // their target — simpler and avoids any chance of following a symlink cycle) are excluded.
  const names = dirents
    .filter((d) => !d.name.startsWith('.') && d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const capped = names.slice(0, MAX_BROWSE_ENTRIES);

  const entries: DirEntry[] = await Promise.all(
    capped.map(async (name) => {
      const childPath = join(target, name);
      const [isGitRepo, hasTaskcell] = await Promise.all([hasMarker(childPath, '.git'), hasMarker(childPath, '.taskcell').then(async (has) => has || (await hasMarker(childPath, '.vanguard')))]);
      return { name, path: childPath, isGitRepo, hasTaskcell };
    }),
  );

  const listing: DirListing = { path: target, entries, isGitRepo: await hasMarker(target, '.git') };

  if (anywhere || target !== realRoot) {
    const parentDir = dirname(target);
    const realParent = await realpath(parentDir);
    if (realParent !== target) {
      listing.parent = realParent;
    }
  }

  return listing;
}
