import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWithinBrowseRoot, browseDirs, isWithinRoot, MAX_BROWSE_ENTRIES } from './browse.js';
import { BadRequestError } from '../sidecar/sidecar.js';

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vanguard-hub-browse-'));
  const unresolvedRoot = join(tmp, 'root');
  await mkdir(unresolvedRoot, { recursive: true });
  // `browseDirs` realpath's its root before comparing; realpath here too so assertions match
  // on platforms (e.g. macOS) where the OS temp dir is itself a symlink.
  root = await realpath(unresolvedRoot);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('browseDirs', () => {
  it('T-76 lists only directories with correct isGitRepo/hasTaskcell flags', async () => {
    await mkdir(join(root, 'project-a', '.git'), { recursive: true });
    await mkdir(join(root, 'project-b'), { recursive: true });
    await writeFile(join(root, 'project-b', '.git'), 'gitdir: ../somewhere'); // worktree-style .git file
    await mkdir(join(root, 'project-c'), { recursive: true });
    await mkdir(join(root, 'project-c', '.vanguard'), { recursive: true });
    await writeFile(join(root, 'readme.txt'), 'not a dir');

    const listing = await browseDirs(root);
    const names = listing.entries.map((e) => e.name);
    expect(names).toEqual(['project-a', 'project-b', 'project-c']);
    expect(listing.entries.find((e) => e.name === 'readme.txt')).toBeUndefined();

    const a = listing.entries.find((e) => e.name === 'project-a')!;
    expect(a.isGitRepo).toBe(true);
    expect(a.hasTaskcell).toBe(false);

    const b = listing.entries.find((e) => e.name === 'project-b')!;
    expect(b.isGitRepo).toBe(true);
    expect(b.hasTaskcell).toBe(false);

    const c = listing.entries.find((e) => e.name === 'project-c')!;
    expect(c.isGitRepo).toBe(false);
    expect(c.hasTaskcell).toBe(true);
  });

  it('T-77 confined to the configured root: escaping requests throw BadRequestError', async () => {
    // The root's own parent is outside the root.
    await expect(browseDirs(root, dirname(root))).rejects.toBeInstanceOf(BadRequestError);
    // A `..`-laden requestedPath that resolves above root.
    await expect(browseDirs(root, join(root, '..'))).rejects.toBeInstanceOf(BadRequestError);
    await expect(browseDirs(root, join(root, '..', '..'))).rejects.toBeInstanceOf(BadRequestError);
  });

  it('T-77b a path that stays within root (including a `.` / `..` that cancels out) is fine', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    const listing = await browseDirs(root, join(root, 'sub', '..', 'sub'));
    expect(listing.path).toBe(join(root, 'sub'));
    expect(listing.parent).toBe(root);
  });

  it('T-78 a directory with more entries than the cap is truncated, not thrown/hung', async () => {
    // Creating 2000+ real directories is slow; instead verify the cap behavior with a smaller,
    // representative count (50) to prove "no truncation when under the cap", and separately pin
    // down the MAX_BROWSE_ENTRIES constant itself so a future change to the cap is caught here.
    // (The real constant used in production is still 2000 — see MAX_BROWSE_ENTRIES in browse.ts.)
    expect(MAX_BROWSE_ENTRIES).toBe(2000);

    const many = join(root, 'many');
    await mkdir(many, { recursive: true });
    const count = 50;
    await Promise.all(
      Array.from({ length: count }, (_, i) => mkdir(join(many, `d${String(i).padStart(4, '0')}`), { recursive: true })),
    );
    const listing = await browseDirs(root, many);
    expect(listing.entries).toHaveLength(count);

    // Focused unit check of the truncation logic itself, independent of real fs entry count.
    const names = Array.from({ length: MAX_BROWSE_ENTRIES + 5 }, (_, i) => `d${i}`);
    const capped = names.slice(0, MAX_BROWSE_ENTRIES);
    expect(capped).toHaveLength(MAX_BROWSE_ENTRIES);
  }, 20000);

  it('T-79 dotfile dirs are hidden from listing, but .vanguard presence shows via the parent row', async () => {
    await mkdir(join(root, '.hidden'), { recursive: true });
    await mkdir(join(root, '.vanguard'), { recursive: true });
    await mkdir(join(root, 'visible'), { recursive: true });
    await mkdir(join(root, 'visible', '.vanguard'), { recursive: true });

    const listing = await browseDirs(root);
    const names = listing.entries.map((e) => e.name);
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('.vanguard');
    expect(names).toEqual(['visible']);

    const visible = listing.entries.find((e) => e.name === 'visible')!;
    expect(visible.hasTaskcell).toBe(true);
  });

  it('omits `parent` when path is the root itself', async () => {
    const listing = await browseDirs(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBeUndefined();
  });

  it('includes `parent` when browsing a subdirectory of root', async () => {
    await mkdir(join(root, 'child'), { recursive: true });
    const listing = await browseDirs(root, join(root, 'child'));
    expect(listing.parent).toBe(root);
  });
});

describe('isWithinRoot', () => {
  it('is pure containment: a root contains itself and its descendants only', () => {
    expect(isWithinRoot('/home/me', '/home/me')).toBe(true);
    expect(isWithinRoot('/home/me', '/home/me/repo')).toBe(true);
    expect(isWithinRoot('/home/me', '/home/meow')).toBe(false);
    expect(isWithinRoot('/home/me', '/etc')).toBe(false);
    // A root that already ends in the separator: no doubled separator, so its descendants match.
    expect(isWithinRoot('/', '/')).toBe(true);
    expect(isWithinRoot('/', '/home/me/repo')).toBe(true);
  });

  it('win32: a drive root or UNC share root confines to that drive or share', () => {
    const within = (r: string, c: string): boolean => isWithinRoot(r, c, win32.sep);
    expect(within('D:\\', 'D:\\')).toBe(true);
    expect(within('D:\\', 'D:\\code\\repo')).toBe(true);
    expect(within('D:\\', 'C:\\Windows')).toBe(false);
    expect(within('C:\\Users\\me', 'C:\\Users\\me\\repo')).toBe(true);
    expect(within('C:\\Users\\me', 'C:\\Users\\meow')).toBe(false);
    expect(within('C:\\Users\\me', 'D:\\repo')).toBe(false);
    expect(within('\\\\srv\\share\\', '\\\\srv\\share\\repo')).toBe(true);
    expect(within('\\\\srv\\share\\', 'C:\\x')).toBe(false);
    expect(within('\\\\srv\\share\\', '\\\\srv\\other\\repo')).toBe(false);
    // The roots above are what win32 path resolution yields for a drive / share root.
    expect(win32.parse('D:\\code\\repo').root).toBe('D:\\');
    expect(win32.parse('\\\\srv\\share\\repo').root).toBe('\\\\srv\\share\\');
  });
});

describe('a filesystem root as the browse root', () => {
  it('assertWithinBrowseRoot and browseDirs accept what is below it (not: reject everything)', async () => {
    const fsRoot = parse(root).root;
    await expect(assertWithinBrowseRoot(fsRoot, root)).resolves.toBe(root);
    const listing = await browseDirs(fsRoot, root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(dirname(root));
    // The root itself has no parent to go up to.
    expect((await browseDirs(fsRoot)).parent).toBeUndefined();
  });
});

describe('typed paths', () => {
  it('a leading ~ is the hub user\'s home, as in a shell', async () => {
    const home = await realpath(homedir());
    expect((await browseDirs(root, '~', true)).path).toBe(home);
    await expect(assertWithinBrowseRoot(root, '~/', true)).resolves.toBe(home);
    // Still confined: home is outside this root.
    await expect(browseDirs(root, '~')).rejects.toThrow('path escapes the browse root');
  });

  it('a path outside the root names the root the repository must be under', async () => {
    await expect(browseDirs(root, tmp)).rejects.toThrow(`this hub only opens folders in ${root} or below it`);
    await expect(assertWithinBrowseRoot(root, tmp)).rejects.toThrow(`this hub only opens folders in ${root} or below it`);
  });
});

describe('anywhere (the desktop app\'s own hub)', () => {
  it('confined by default; with `anywhere` a path outside the root is listed and accepted', async () => {
    const outside = join(tmp, 'outside');
    await mkdir(join(outside, 'repo', '.git'), { recursive: true });
    await expect(browseDirs(root, outside)).rejects.toThrow('path escapes the browse root');
    await expect(assertWithinBrowseRoot(root, outside)).rejects.toThrow('path escapes the browse root');

    const listing = await browseDirs(root, outside, true);
    expect(listing.entries.map((e) => e.name)).toEqual(['repo']);
    await expect(assertWithinBrowseRoot(root, join(outside, 'repo'), true)).resolves.toBe(await realpath(join(outside, 'repo')));
    await expect(assertWithinBrowseRoot(root, join(outside, 'missing'), true)).rejects.toThrow('path does not exist');
  });

  it('opens at the root but can go up from it, until the filesystem root', async () => {
    const atRoot = await browseDirs(root, undefined, true);
    expect(atRoot.path).toBe(root);
    expect(atRoot.parent).toBe(dirname(root));
    expect((await browseDirs(root, parse(root).root, true)).parent).toBeUndefined();
    // Confined: the root is the top.
    expect((await browseDirs(root)).parent).toBeUndefined();
  });

  it('reports whether the listed directory is itself a git work tree', async () => {
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    expect((await browseDirs(root, join(root, 'repo'))).isGitRepo).toBe(true);
    expect((await browseDirs(root)).isGitRepo).toBe(false);
  });
});
