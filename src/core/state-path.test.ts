import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { assertStatePath, ensureStateDir, resetStateDirCache, showStateFile, stateDir } from './state-path.js';
import { StatePathError } from './errors.js';

let repo: string;
let outside: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-statepath-'));
  outside = await mkdtemp(join(tmpdir(), 'vg-statepath-outside-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('assertStatePath', () => {
  it('accepts a path whose components do not exist yet', async () => {
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'runs', 'T-1', 'a.json'))).resolves.toBeUndefined();
  });

  it('accepts real directories and a real leaf file', async () => {
    await mkdir(join(repo, '.taskcell', 'runs'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'runs', 'metrics.jsonl'), '');
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'runs', 'metrics.jsonl'))).resolves.toBeUndefined();
  });

  it('refuses a committed .vanguard symlink', async () => {
    await symlink(outside, join(repo, '.taskcell'));
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'runs', 'x.json'))).rejects.toBeInstanceOf(StatePathError);
  });

  it('refuses a nested component symlink', async () => {
    await mkdir(join(repo, '.taskcell'));
    await symlink(outside, join(repo, '.taskcell', 'runs'));
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'runs', 'T-1'))).rejects.toThrow(/symlink/);
  });

  it('refuses a leaf symlink, dangling or not', async () => {
    await mkdir(join(repo, '.taskcell', 'memory'), { recursive: true });
    await symlink(join(outside, 'missing.txt'), join(repo, '.taskcell', 'memory', 'retrospective.md'));
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'memory', 'retrospective.md'))).rejects.toThrow(/symlink/);
  });

  it('refuses a file where a directory is expected', async () => {
    await mkdir(join(repo, '.taskcell'));
    await writeFile(join(repo, '.taskcell', 'runs'), '');
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'runs', 'x.json'))).rejects.toThrow(/not a directory/);
  });

  it('refuses a target outside .vanguard', async () => {
    await expect(assertStatePath(repo, join(repo, 'src', 'x.ts'))).rejects.toThrow(/outside/);
    await expect(assertStatePath(repo, join(repo, '.taskcell', '..', '..', 'x'))).rejects.toThrow(/outside/);
  });
});

describe('ensureStateDir', () => {
  it('creates real directories on a clean checkout', async () => {
    const dir = await ensureStateDir(repo, join(repo, '.taskcell', 'sessions', 'T-1'));
    expect((await lstat(dir)).isDirectory()).toBe(true);
  });

  it('creates nothing through a committed symlink', async () => {
    await symlink(outside, join(repo, '.taskcell'));
    await expect(ensureStateDir(repo, join(repo, '.taskcell', 'staging', 'T-1'))).rejects.toBeInstanceOf(StatePathError);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('stateDir', () => {
  afterEach(() => {
    resetStateDirCache();
    vi.restoreAllMocks();
  });

  it('uses .taskcell in a fresh repo', () => {
    expect(stateDir(repo)).toBe(join(repo, '.taskcell'));
  });

  it('falls back to a legacy .vanguard with a one-time warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mkdir(join(repo, '.vanguard'));
    expect(stateDir(repo)).toBe(join(repo, '.vanguard'));
    expect(stateDir(repo)).toBe(join(repo, '.vanguard'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('deprecated');
  });

  it('prefers .taskcell when both exist, without warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mkdir(join(repo, '.vanguard'));
    await mkdir(join(repo, '.taskcell'));
    expect(stateDir(repo)).toBe(join(repo, '.taskcell'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('ensureStateDir writes a fresh repo\'s state under .taskcell', async () => {
    await ensureStateDir(repo, join(stateDir(repo), 'runs'));
    expect((await readdir(repo)).sort()).toEqual(['.taskcell']);
  });

  it('stays on .vanguard when .taskcell appears mid-run, and still guards both', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mkdir(join(repo, '.vanguard'));
    const inFlight = join(stateDir(repo), 'runs', 'task-1');
    await mkdir(join(repo, '.taskcell'));
    expect(stateDir(repo)).toBe(join(repo, '.vanguard'));
    await expect(assertStatePath(repo, inFlight)).resolves.toBeUndefined();
    await expect(assertStatePath(repo, join(repo, '.taskcell', 'runs'))).resolves.toBeUndefined();
    await expect(assertStatePath(repo, join(repo, 'src', 'x'))).rejects.toBeInstanceOf(StatePathError);
  });

  it('refuses a legacy .vanguard that is itself a symlink', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await symlink(outside, join(repo, '.vanguard'));
    expect(stateDir(repo)).toBe(join(repo, '.vanguard'));
    await expect(ensureStateDir(repo, join(stateDir(repo), 'runs'))).rejects.toBeInstanceOf(StatePathError);
    expect(await readdir(outside)).toEqual([]);
  });

  it('hints once when a fresh .taskcell is not gitignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await execa('git', ['init', '-q'], { cwd: repo });
    await ensureStateDir(repo, join(stateDir(repo), 'runs'));
    await ensureStateDir(repo, join(stateDir(repo), 'drafts'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('.gitignore');
  });

  it('does not hint when .taskcell is gitignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await execa('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, '.gitignore'), '.taskcell/\n');
    await ensureStateDir(repo, join(stateDir(repo), 'runs'));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('showStateFile', () => {
  const git = (...args: string[]): Promise<unknown> => execa('git', args, { cwd: repo });

  it('reads .taskcell/<file> at a ref, falling back to .vanguard/<file>', async () => {
    await git('init', '-q');
    await mkdir(join(repo, '.vanguard'));
    await writeFile(join(repo, '.vanguard', 'approver.json'), 'legacy\n');
    await git('add', '.');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'legacy');
    expect(await showStateFile(repo, 'HEAD', 'approver.json')).toBe('legacy\n');
    await mkdir(join(repo, '.taskcell'));
    await writeFile(join(repo, '.taskcell', 'approver.json'), 'current\n');
    await git('add', '.');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'current');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await showStateFile(repo, 'HEAD', 'approver.json')).toBe('current\n');
    expect(await showStateFile(repo, 'HEAD', 'approver.json')).toBe('current\n');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('.vanguard/approver.json there is ignored');
    warn.mockRestore();
    resetStateDirCache();
    await expect(showStateFile(repo, 'HEAD', 'missing.json')).rejects.toThrow();
  });
});
