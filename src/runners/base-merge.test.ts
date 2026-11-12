import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { mergeBaseIntoWorktree, filesWithConflictMarkers, formatConflictFiles } from './base-merge.js';

let dirs: string[] = [];
let repo: string;
let origin: string;

const g = (args: string[], cwd = repo): Promise<{ stdout: string }> =>
  execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
const commit = async (msg: string): Promise<void> => {
  await g(['add', '-A']);
  await g(['commit', '-m', msg]);
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-bm-'));
  origin = await mkdtemp(join(tmpdir(), 'vg-bm-origin-'));
  dirs = [repo, origin];
  await g(['init', '--bare', '-b', 'main'], origin);
  await g(['init', '-b', 'main']);
  await g(['remote', 'add', 'origin', origin]);
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await writeFile(join(repo, 'gone.txt'), 'x\n');
  await commit('init');
  await g(['checkout', '-b', 'feature']);
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Land a commit on origin/main (the repo is left on `feature`). */
async function landOnMain(edit: () => Promise<void>): Promise<void> {
  await g(['checkout', 'main']);
  await edit();
  await commit('main change');
  await g(['push', 'origin', 'main']);
  await g(['checkout', 'feature']);
}

describe('mergeBaseIntoWorktree', () => {
  it('clean branch: reports clean and leaves HEAD and the worktree untouched', async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n');
    await commit('feature');
    await landOnMain(() => writeFile(join(repo, 'b.txt'), 'b\n'));
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    expect(await mergeBaseIntoWorktree(repo, 'main')).toEqual({ status: 'clean' });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
    expect((await g(['status', '--porcelain'])).stdout).toBe('');
  });

  it('conflict: commits a merge taking the branch side, leaving only the marked file as an uncommitted edit', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await commit('feature');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await writeFile(join(repo, 'baseonly.txt'), 'b\n');
    });
    const result = await mergeBaseIntoWorktree(repo, 'main');
    expect(result).toEqual({ status: 'conflicted', files: ['shared.txt'], unresolvable: [] });
    expect((await g(['rev-list', '--parents', '-n1', 'HEAD'])).stdout.split(' ')).toHaveLength(3);
    expect((await g(['show', 'HEAD:shared.txt'])).stdout).toBe('feature');
    // The base's own changes are committed, so a diff against HEAD shows only the conflict-marked file.
    expect((await g(['diff', 'HEAD', '--name-only'])).stdout).toBe('shared.txt');
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toMatch(/^<{7} /m);
    expect(await filesWithConflictMarkers(repo, ['shared.txt'])).toEqual(['shared.txt']);
    await writeFile(join(repo, 'shared.txt'), 'both\n');
    expect(await filesWithConflictMarkers(repo, ['shared.txt'])).toEqual([]);
  });

  it('modify/delete conflict is unresolvable: nothing is merged', async () => {
    await writeFile(join(repo, 'gone.txt'), 'changed on feature\n');
    await commit('feature');
    await landOnMain(() => rm(join(repo, 'gone.txt')));
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    expect(await mergeBaseIntoWorktree(repo, 'main')).toEqual({ status: 'conflicted', files: ['gone.txt'], unresolvable: ['gone.txt'] });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
    expect((await g(['status', '--porcelain'])).stdout).toBe('');
  });

  it('a base that changed CI config is unresolvable: nothing is merged', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await commit('feature');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    expect(await mergeBaseIntoWorktree(repo, 'main')).toEqual({ status: 'conflicted', files: ['shared.txt'], unresolvable: ['.github/workflows/ci.yml'] });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
    expect((await g(['status', '--porcelain'])).stdout).toBe('');
  });

  it('factory-owned branch + base CI change + code conflict: rebases, leaving no workflow change vs the base', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await commit('feature');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const result = await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true, authorEmail: 't@t' });
    expect(result).toEqual({ status: 'conflicted', files: ['shared.txt'], unresolvable: [], rebased: true });
    expect((await g(['rev-list', '--merges', 'FETCH_HEAD..HEAD'])).stdout).toBe('');
    await g(['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']);
    expect((await g(['diff', '--name-only', 'FETCH_HEAD', 'HEAD'])).stdout).toBe('shared.txt');
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('rebase of a multi-commit branch: the agent sees the final text, later commits are not reverted', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
    await commit('initial');
    await writeFile(join(repo, 'shared.txt'), 'feature\nl2\nl3\nl4\nl5\nl6\nl7\nFIX\n');
    await commit('revision');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const result = await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true, authorEmail: 't@t' });
    expect(result).toMatchObject({ rebased: true, files: ['shared.txt'] });
    expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toContain('FIX');
    expect((await g(['show', 'HEAD:shared.txt'])).stdout).toContain('FIX');
  });

  it('a rebase whose result drops a base change the merge keeps is undone and held', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await writeFile(join(repo, 'gone.txt'), 'f\n');
    await commit('touch gone');
    await writeFile(join(repo, 'gone.txt'), 'x\n');
    await commit('revert gone');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await writeFile(join(repo, 'gone.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    expect(await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true, authorEmail: 't@t' })).toEqual({
      status: 'conflicted', files: ['shared.txt'], unresolvable: ['.github/workflows/ci.yml'],
    });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
    expect((await g(['status', '--porcelain'])).stdout).toBe('');
  });

  it('a merge commit by someone else on the branch is not rebased away', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await commit('feature');
    await g(['checkout', '-b', 'side', 'main']);
    await writeFile(join(repo, 'side.txt'), 's\n');
    await commit('side');
    await g(['checkout', 'feature']);
    await execa('git', ['-c', 'user.email=human@x', '-c', 'user.name=h', 'merge', '--no-ff', '-m', 'merge side', 'side'], { cwd: repo });
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    expect(await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true, authorEmail: 't@t' })).toMatchObject({ unresolvable: ['.github/workflows/ci.yml'] });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  it('a branch commit by someone else, or one that touched CI config (even reverted), is not rebased', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await commit('feature');
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repo, '.github', 'workflows', 'mine.yml'), 'on: push\n');
    await commit('add workflow');
    await g(['rm', '-q', '.github/workflows/mine.yml']);
    await commit('revert workflow');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    expect(await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true, authorEmail: 't@t' })).toMatchObject({ unresolvable: ['.github/workflows/ci.yml'] });
    expect(await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true })).toMatchObject({ unresolvable: ['.github/workflows/ci.yml'] }); // authored t@t, not the factory
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  it('human-owned branch (not factoryOwned): never rebased, base CI change stays unresolvable', async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await commit('feature');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    const result = await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: false });
    expect(result).toMatchObject({ status: 'conflicted', unresolvable: ['.github/workflows/ci.yml'] });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  it("the PR's own CI-config edit keeps the hold, even on a factory branch", async () => {
    await writeFile(join(repo, 'shared.txt'), 'feature\n');
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repo, '.github', 'workflows', 'mine.yml'), 'on: push\n');
    await commit('feature');
    await landOnMain(async () => {
      await writeFile(join(repo, 'shared.txt'), 'main\n');
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    const head = (await g(['rev-parse', 'HEAD'])).stdout;
    const result = await mergeBaseIntoWorktree(repo, 'main', { factoryOwned: true, authorEmail: 't@t' });
    expect(result).toMatchObject({ status: 'conflicted', unresolvable: expect.arrayContaining(['.github/workflows/ci.yml']) });
    expect((await g(['rev-parse', 'HEAD'])).stdout).toBe(head);
  });

  it('skips (worktree unchanged) when the base cannot be fetched', async () => {
    await g(['remote', 'set-url', 'origin', join(origin, 'does-not-exist')]);
    const result = await mergeBaseIntoWorktree(repo, 'main');
    expect(result.status).toBe('skipped');
  });
});

describe('formatConflictFiles', () => {
  it('quotes names, masks odd characters, and says so when there are none', () => {
    expect(formatConflictFiles(['a/b.ts', 'x\ny`z'])).toBe('`a/b.ts`, `x?y?z`');
    expect(formatConflictFiles([])).toBe('(files not determined)');
  });
});
