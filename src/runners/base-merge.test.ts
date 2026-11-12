import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
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
