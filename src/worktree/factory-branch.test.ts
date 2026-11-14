import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { isFactoryBranch, LEGACY_BRANCH_PREFIX, TASKCELL_BRANCH_PREFIX, WorktreeManager } from './manager.js';
import { githubBranchPrefixes } from '../tasks/overlap.js';
import { linkedIssueNumber } from '../runners/linked-issue.js';
import { isFactoryPr } from '../approver/facts.js';
import type { ApproverPolicy, PrFacts } from '../approver/types.js';

const NEW = 'chore/taskcell-gh-o-r-7-ab12';
const OLD = 'chore/vanguard-gh-o-r-7-ab12';

describe('factory branches under the old and the new prefix', () => {
  it('isFactoryBranch accepts both and nothing else', () => {
    expect(isFactoryBranch(NEW)).toBe(true);
    expect(isFactoryBranch(OLD)).toBe(true);
    expect(isFactoryBranch('chore/other-7')).toBe(false);
    expect(isFactoryBranch(undefined)).toBe(false);
  });

  it('githubBranchPrefixes lists both forms for a task id', () => {
    expect(githubBranchPrefixes('o/r')).toEqual([`${TASKCELL_BRANCH_PREFIX}gh-o-r-`, `${LEGACY_BRANCH_PREFIX}gh-o-r-`]);
  });

  it('linkedIssueNumber reads the issue from either prefix', () => {
    const pr = { repoSlug: 'o/r', body: '' };
    expect(linkedIssueNumber({ ...pr, headRefName: OLD })).toBe(7);
    expect(linkedIssueNumber({ ...pr, headRefName: NEW })).toBe(7);
  });

  it('isFactoryPr accepts both prefixes under the shipped policy, but not a custom one', () => {
    const policy = { factoryBranchPrefix: 'chore/vanguard-' } as ApproverPolicy;
    const pr = (headRefName: string): PrFacts => ({ headRepo: 'o/r', headRefName }) as PrFacts;
    expect(isFactoryPr(pr(NEW), 'o/r', policy)).toBe(true);
    expect(isFactoryPr(pr(OLD), 'o/r', policy)).toBe(true);
    expect(isFactoryPr(pr('feat/x'), 'o/r', policy)).toBe(false);
    expect(isFactoryPr(pr(NEW), 'o/r', { factoryBranchPrefix: 'feat/' } as ApproverPolicy)).toBe(false);
    expect(isFactoryPr({ ...pr(NEW), headRepo: 'x/y' }, 'o/r', policy)).toBe(false);
  });

  it('--reuse finds a branch minted under the other prefix', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'vg-prefix-'));
    try {
      await execa('git', ['init', '-b', 'main'], { cwd: repo });
      await writeFile(join(repo, 'a'), 'a');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
      await execa('git', ['branch', `${TASKCELL_BRANCH_PREFIX}task-9-r0`], { cwd: repo });
      const wt = await new WorktreeManager(repo).create('task-9', 'main', { reuse: true });
      expect(wt.branch).toBe(`${TASKCELL_BRANCH_PREFIX}task-9-r0`);
      // The other way round (what a run minting `chore/taskcell-` sees on a repo with pre-rename branches).
      await execa('git', ['branch', `${LEGACY_BRANCH_PREFIX}task-8-r0`], { cwd: repo });
      const old = await new WorktreeManager(repo).create('task-8', 'main', { reuse: true, branchPrefix: TASKCELL_BRANCH_PREFIX });
      expect(old.branch).toBe(`${LEGACY_BRANCH_PREFIX}task-8-r0`);
      // A white-label prefix never picks up a factory branch.
      const own = await new WorktreeManager(repo).create('task-8', 'main', { reuse: true, branchPrefix: 'feat/' });
      expect(own.branch.startsWith('feat/task-8-')).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
