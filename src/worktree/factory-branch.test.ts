import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { FACTORY_BRANCH_PREFIXES, isFactoryBranch, LEGACY_BRANCH_PREFIX, MINT_BRANCH_PREFIX, TASKCELL_BRANCH_PREFIX, WorktreeManager } from './manager.js';
import { githubBranchPrefixes } from '../tasks/overlap.js';
import { linkedIssueNumber } from '../runners/linked-issue.js';
import { isFactoryPr } from '../approver/facts.js';
import type { ApproverPolicy, PrFacts } from '../approver/types.js';

const NEW = 'chore/taskcell-gh-o-r-7-ab12';
const OLD = 'chore/vanguard-gh-o-r-7-ab12';

// The factory still mints `chore/vanguard-`; `chore/taskcell-` is not factory-owned until it mints that (a person can push one).
describe('factory branches: only the prefixes the factory mints', () => {
  it('isFactoryBranch accepts the minted prefix and nothing else', () => {
    expect(isFactoryBranch(NEW)).toBe(false);
    expect(isFactoryBranch(OLD)).toBe(true);
    expect(FACTORY_BRANCH_PREFIXES).toContain(MINT_BRANCH_PREFIX);
    expect(FACTORY_BRANCH_PREFIXES).toEqual([LEGACY_BRANCH_PREFIX]);
    expect(isFactoryBranch('chore/other-7')).toBe(false);
    expect(isFactoryBranch(undefined)).toBe(false);
  });

  it('githubBranchPrefixes lists the minted form for a task id', () => {
    expect(githubBranchPrefixes('o/r')).toEqual([`${LEGACY_BRANCH_PREFIX}gh-o-r-`]);
  });

  it('linkedIssueNumber reads the issue from a factory branch, not from a branch a person named like one', () => {
    const pr = { repoSlug: 'o/r', body: '' };
    expect(linkedIssueNumber({ ...pr, headRefName: OLD })).toBe(7);
    expect(linkedIssueNumber({ ...pr, headRefName: NEW })).toBeUndefined();
  });

  it('isFactoryPr accepts the minted prefix under the shipped policy, and a custom one only by itself', () => {
    const policy = { factoryBranchPrefix: 'chore/vanguard-' } as ApproverPolicy;
    const pr = (headRefName: string): PrFacts => ({ headRepo: 'o/r', headRefName }) as PrFacts;
    expect(isFactoryPr(pr(NEW), 'o/r', policy)).toBe(false);
    expect(isFactoryPr(pr(NEW), 'o/r', { factoryBranchPrefix: 'chore/taskcell-' } as ApproverPolicy)).toBe(true);
    expect(isFactoryPr(pr(OLD), 'o/r', policy)).toBe(true);
    expect(isFactoryPr(pr('feat/x'), 'o/r', policy)).toBe(false);
    expect(isFactoryPr(pr(NEW), 'o/r', { factoryBranchPrefix: 'feat/' } as ApproverPolicy)).toBe(false);
    expect(isFactoryPr({ ...pr(NEW), headRepo: 'x/y' }, 'o/r', policy)).toBe(false);
  });

  it('--reuse does not take over a branch under a prefix the factory does not mint', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'vg-prefix-'));
    try {
      await execa('git', ['init', '-b', 'main'], { cwd: repo });
      await writeFile(join(repo, 'a'), 'a');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
      await execa('git', ['branch', `${TASKCELL_BRANCH_PREFIX}task-9-r0`], { cwd: repo });
      const wt = await new WorktreeManager(repo).create('task-9', 'main', { reuse: true });
      expect(wt.branch.startsWith(`${MINT_BRANCH_PREFIX}task-9-`)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
