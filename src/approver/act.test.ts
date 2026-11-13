import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runApprover } from './approve.js';
import { assertActSafeGhArgs, isReleasePr } from './act.js';
import { readBranchFile } from '../core/metrics-branch.js';
import type { GhRunner } from '../tasks/github.js';

let root: string;
let origin: string;
let repo: string;
let headSha: string;
let baseSha: string;

const POLICY = {
  schemaVersion: 1,
  enabled: true,
  act: true,
  factoryBranchPrefix: 'chore/vanguard-',
  requiredChecks: [{ name: 'build', appId: 15368 }],
  reviewAuthors: ['bot'],
  testGlobs: ['**/*.test.ts'],
  pathRules: { 'ci-config': ['.github/**'], secrets: ['secrets/**'] },
  shape: { maxLines: 150, maxFiles: 5 },
  ledger: { windowDays: 7, maxLines: 300 },
  auditSample: { p: 0 },
};

const git = async (cwd: string, args: string[]): Promise<string> => (await execa('git', args, { cwd })).stdout.trim();

async function setup(policy: object, files: Record<string, string>): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'vg-act-'));
  origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  const seed = join(root, 'seed');
  await execa('git', ['init', '--quiet', '-b', 'main', seed]);
  await git(seed, ['config', 'user.email', 't@t']);
  await git(seed, ['config', 'user.name', 't']);
  await mkdir(join(seed, '.taskcell'), { recursive: true });
  await writeFile(join(seed, '.taskcell', 'approver.json'), JSON.stringify(policy));
  await writeFile(join(seed, 'README.md'), 'hello\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '--quiet', '-m', 'seed']);
  await git(seed, ['push', '--quiet', origin, 'main']);
  baseSha = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['checkout', '--quiet', '-b', 'chore/vanguard-1']);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(seed, path, '..'), { recursive: true });
    await writeFile(join(seed, path), body);
  }
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '--quiet', '-m', 'feature']);
  headSha = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', '--quiet', origin, 'chore/vanguard-1:refs/pull/1/head']);
  repo = join(root, 'repo');
  await execa('git', ['clone', '--quiet', origin, repo]);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reviewBody = (sha: string): string => `## Taskcell Review\n\nVerdict: NO BLOCKING FINDINGS\n\nLooks good.\n\n<!-- taskcell-pr-review: ${sha} -->`;

interface PrState {
  head: string;
  isDraft: boolean;
  merge: string;
  headRefName: string;
  title: string;
  build: string | null;
}

function fakeGh(calls: string[][], pr: PrState, onUpdate?: () => Promise<void>): GhRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return JSON.stringify({ comments: [] });
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({
        number: 1, title: pr.title, state: 'OPEN', isDraft: pr.isDraft, mergeStateStatus: pr.merge,
        headRefName: pr.headRefName, headRefOid: pr.head, baseRefName: 'main', baseRefOid: baseSha,
        headRepository: { name: 'r' }, headRepositoryOwner: { login: 'o' },
        reviews: [{ author: { login: 'bot' }, body: reviewBody(headSha), submittedAt: '2026-10-20T00:00:00Z', state: 'COMMENTED' }],
      });
    }
    if (args[0] === 'pr' && args[1] === 'ready') pr.isDraft = false;
    if (args[0] === 'pr' && args[1] === 'update-branch') {
      await onUpdate?.();
      return '';
    }
    if (args[0] === 'api' && args[1]?.includes('check-runs?per_page')) {
      return JSON.stringify({ check_runs: pr.build === null ? [] : [{ name: 'build', conclusion: pr.build, app: { id: 15368 } }] });
    }
    if (args[0] === 'api' && args[1]?.includes('check-runs?check_name')) return JSON.stringify({ check_runs: [] });
    if (args[0] === 'api') return '{}';
    return '';
  };
}

const pr = (over: Partial<PrState> = {}): PrState => ({ head: headSha, isDraft: false, merge: 'CLEAN', headRefName: 'chore/vanguard-1', title: 'feat: x', build: 'success', ...over });
const run = (gh: GhRunner, mode: 'shadow' | 'act' = 'act'): ReturnType<typeof runApprover> =>
  runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode, gh, sleep: async () => {} });
const writes = (calls: string[][], sub: string): string[][] => calls.filter((a) => a[0] === 'pr' && a[1] === sub);
const records = async (): Promise<Array<Record<string, unknown>>> =>
  (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const actions = async (): Promise<string[]> =>
  (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n').map((l) => JSON.parse(l) as { action?: string }).flatMap((r) => (r.action !== undefined ? [r.action] : []));

describe('approver act mode', () => {
  describe('clean PR', () => {
    beforeEach(() => setup(POLICY, { 'src.ts': 'export const x = 1;\n' }));

    it('squash-merges a reviewed, green, APPROVE PR pinned to the head, and logs it', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()));
      expect(writes(calls, 'merge')).toEqual([['pr', 'merge', '1', '--repo', 'o/r', '--squash', '--match-head-commit', headSha]]);
      expect(writes(calls, 'update-branch')).toEqual([]);
      expect(await actions()).toEqual(['merge']);
      const rec = (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.action === 'merge')!;
      expect(rec).toMatchObject({ prNumber: 1, headSha, reason: expect.stringContaining('APPROVE') });
    });

    it('act off in the policy: shadow behaviour, nothing written', async () => {
      await rm(root, { recursive: true, force: true });
      await setup({ ...POLICY, act: false }, { 'src.ts': 'export const x = 1;\n' });
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()));
      expect(calls.some((a) => a[0] === 'pr' && ['merge', 'ready', 'update-branch'].includes(a[1]!))).toBe(false);
      expect(await actions()).toEqual([]);
    });

    it('--mode shadow never acts even when the policy says act', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()), 'shadow');
      expect(writes(calls, 'merge')).toEqual([]);
    });

    it('a base that really moved: updated, re-checked, the review still covers the merged head, merged', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      let polls = 0;
      const base = fakeGh(calls, state, () => updateBranch(state, null));
      const gh: GhRunner = async (args) => {
        if (args[0] === 'api' && args[1]?.includes('check-runs?per_page') && state.head !== headSha) {
          polls += 1;
          if (polls >= 2) state.build = 'success'; // checks complete on the second poll
        }
        return base(args);
      };
      await run(gh);
      expect(writes(calls, 'update-branch')).toEqual([['pr', 'update-branch', '1', '--repo', 'o/r']]);
      expect(calls.some((a) => a.includes('--rebase') || a.includes('--force'))).toBe(false);
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(writes(calls, 'merge')).toEqual([['pr', 'merge', '1', '--repo', 'o/r', '--squash', '--match-head-commit', state.head]]);
      expect(await actions()).toEqual(['update-branch', 'merge']);
      const verdicts = (await records()).filter((r) => r.verdict !== undefined);
      expect(verdicts.map((r) => [r.verdict, r.mode, r.headSha])).toEqual([['APPROVE', 'act', headSha], ['APPROVE', 'act', state.head]]);
      expect(writes(calls, 'comment')).toEqual([]); // act mode posts no decision comment
    });

    it('checks failing on the updated head: no merge, a comment, logged', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, () => updateBranch(state, 'failure')));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('checks failed'))).toBe(true);
      expect(await actions()).toEqual(['update-branch', 'checks-failed']);
    });

    it('checks that never appear on the updated head time out: no merge, a comment', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, () => updateBranch(state, null)));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('timed out'))).toBe(true);
      expect(await actions()).toEqual(['update-branch', 'checks-failed']);
    });

    it('a base that moves again after the update is left for a human (one update per run)', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, async () => {
        await updateBranch(state, 'success');
        await moveBase('another.txt');
      }));
      expect(writes(calls, 'update-branch')).toHaveLength(1);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(await actions()).toEqual(['update-branch', 'base-moved']);
    });

    it('a head changed by more than the base merge needs a new review (review-stale), no merge', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, async () => {
        await updateBranch(state, 'success', 'extra.ts');
      }));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('review-stale'))).toBe(true);
      expect(await actions()).toEqual(['update-branch', 'left-for-human']);
    });

    it('a rejected merge is logged and commented, then fails loudly', async () => {
      const calls: string[][] = [];
      const base = fakeGh(calls, pr());
      const gh: GhRunner = async (args) => {
        if (args[1] === 'merge') throw new Error('HTTP 405: not mergeable');
        return base(args);
      };
      await expect(run(gh)).rejects.toThrow(/not mergeable/);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('merge was rejected'))).toBe(true);
      expect(await actions()).toEqual(['merge-failed']);
    });

    it('kill switch under --mode act: stopped, nothing acted on', async () => {
      process.env.VANGUARD_APPROVER_STOP = '1';
      try {
        const calls: string[][] = [];
        const { record } = await run(fakeGh(calls, pr()));
        expect(record.rulesFired).toEqual(['stopped']);
        expect(calls.some((a) => a[0] === 'pr' && ['merge', 'ready', 'update-branch'].includes(a[1]!))).toBe(false);
        expect(await actions()).toEqual([]);
      } finally {
        delete process.env.VANGUARD_APPROVER_STOP;
      }
    });

    it('--dry-run under --mode act decides only: no writes, no records, mode shadow', async () => {
      const calls: string[][] = [];
      const { record } = await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'act', gh: fakeGh(calls, pr()), dryRun: true });
      expect(record).toMatchObject({ verdict: 'APPROVE', mode: 'shadow' });
      expect(calls.some((a) => a[0] === 'pr' && ['merge', 'ready', 'update-branch', 'comment'].includes(a[1]!))).toBe(false);
      expect((await readBranchFile(repo, { file: 'decisions.jsonl' }))).toBe('');
    });

    it('a merged PR rerun posts nothing', async () => {
      const calls: string[][] = [];
      const base = fakeGh(calls, pr());
      const gh: GhRunner = async (args) => {
        const out = await base(args);
        return args[1] === 'view' && !args.includes('comments') ? out.replace('"state":"OPEN"', '"state":"MERGED"') : out;
      };
      await run(gh);
      expect(writes(calls, 'comment')).toEqual([]);
      expect(writes(calls, 'merge')).toEqual([]);
    });

    it('act policy off: records are shadow-mode, check run says shadow', async () => {
      await rm(root, { recursive: true, force: true });
      await setup({ ...POLICY, act: false }, { 'src.ts': 'export const x = 1;\n' });
      const calls: string[][] = [];
      const { record } = await run(fakeGh(calls, pr()));
      expect(record.mode).toBe('shadow');
      expect(calls.some((a) => a.includes('output[title]=APPROVE (shadow)'))).toBe(true);
    });

    it('act mode labels its check run', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()));
      expect(calls.some((a) => a.includes('output[title]=APPROVE (act)'))).toBe(true);
    });

    it('a release PR is left for a human with a comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ title: 'chore(main): release 1.2.0' })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('release PR'))).toBe(true);
      expect(await actions()).toEqual(['left-for-human']);
    });

    it('a PR not opened by the factory is left for a human with a comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ headRefName: 'feature/x' })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('not-factory-pr'))).toBe(true);
    });

    it('a non-APPROVE decision (failed check) is left for a human with a comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ build: 'failure' })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('ESCALATE'))).toBe(true);
    });

    it('a conflicting PR is left for a human with a comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ merge: 'DIRTY' })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('merge conflict'))).toBe(true);
    });

    it('a PR that really conflicts with the moved base is left for a human with a comment', async () => {
      const calls: string[][] = [];
      await moveBase('src.ts');
      await run(fakeGh(calls, pr()));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'update-branch')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('merge-conflict'))).toBe(true);
    });

    it('a draft whose verify passed is marked ready with no stale draft decision recorded; the next run merges on an APPROVE record', async () => {
      const state = pr({ isDraft: true });
      const calls: string[][] = [];
      const first = await run(fakeGh(calls, state));
      expect(writes(calls, 'ready')).toEqual([['pr', 'ready', '1', '--repo', 'o/r']]);
      expect(first.record.rulesFired).toContain('draft');
      expect(writes(calls, 'merge')).toEqual([]);
      expect((await records()).filter((r) => r.verdict !== undefined)).toEqual([]);
      await run(fakeGh(calls, state)); // now ready, same head
      expect(writes(calls, 'merge')).toHaveLength(1);
      expect(await actions()).toEqual(['mark-ready', 'merge']);
      expect((await records()).filter((r) => r.verdict !== undefined).map((r) => r.verdict)).toEqual(['APPROVE']);
    });

    it('a draft whose verify failed gets one human comment and nothing else', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ isDraft: true, build: 'failure' })));
      expect(writes(calls, 'ready')).toEqual([]);
      expect(writes(calls, 'comment')).toHaveLength(1);
      expect(writes(calls, 'comment')[0]!.join(' ')).toContain('a human must look');
      expect(await actions()).toEqual(['verify-failed']);
    });

    it('a draft release PR is not marked ready', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ isDraft: true, title: 'chore(main): release 1.2.0' })));
      expect(writes(calls, 'ready')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('release PR'))).toBe(true);
    });

    it('act-mode guard allows only the three writes and shadow calls', () => {
      expect(() => assertActSafeGhArgs(['pr', 'merge', '1', '--repo', 'o/r', '--squash', '--match-head-commit', 'a'.repeat(40)])).not.toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'merge', '1', '--repo', 'o/r', '--admin', '--squash', '--match-head-commit', 'a'.repeat(40)])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'merge', '1', '--repo', 'o/r', '--rebase'])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'update-branch', '1', '--repo', 'o/r', '--rebase'])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'close', '1', '--repo', 'o/r'])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'ready', '1', '--repo', 'o/r'])).not.toThrow();
    });

    it('release detection', () => {
      expect(isReleasePr({ headRefName: 'release/1.0', title: '' })).toBe(true);
      expect(isReleasePr({ headRefName: 'chore/vanguard-release-1', title: '' })).toBe(true);
      expect(isReleasePr({ headRefName: 'chore/vanguard-3', title: 'Release 1.2' })).toBe(true);
      expect(isReleasePr({ headRefName: 'chore/vanguard-3', title: 'chore(main): release 1.2.0' })).toBe(true);
      expect(isReleasePr({ headRefName: 'chore/vanguard-3', title: 'fix: releases page' })).toBe(false);
    });
  });

  it.each([
    ['CI config', { '.github/workflows/x.yml': 'name: x\n' }, 'CI config'],
    ['a protected path', { 'secrets/a.txt': 'x\n' }, 'path:secrets'],
  ])('a PR touching %s is left for a human with a comment', async (_n, files, expected) => {
    await setup(POLICY, files);
    const calls: string[][] = [];
    await run(fakeGh(calls, pr()));
    expect(writes(calls, 'merge')).toEqual([]);
    expect(writes(calls, 'comment').some((a) => a.join(' ').includes(expected))).toBe(true);
  });
});

/** A real commit on the base branch, so the base tip moves past the PR's merge-base. */
async function moveBase(file: string): Promise<void> {
  const seed = join(root, 'seed');
  await git(seed, ['checkout', '--quiet', 'main']);
  await writeFile(join(seed, file), 'x\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '--quiet', '-m', `base ${file}`]);
  await git(seed, ['push', '--quiet', origin, 'main']);
}

/** What update-branch does: a real `git merge main` into the PR branch (plus, optionally, an extra commit), pushed as the PR head. */
async function updateBranch(state: PrState, build: string | null, extraFile?: string): Promise<void> {
  const seed = join(root, 'seed');
  await git(seed, ['checkout', '--quiet', 'chore/vanguard-1']);
  await git(seed, ['merge', '--quiet', '--no-edit', 'main']);
  if (extraFile !== undefined) {
    await writeFile(join(seed, extraFile), 'export const y = 2;\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '--quiet', '-m', 'extra']);
  }
  const merged = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', '--quiet', '--force', origin, `${merged}:refs/pull/1/head`]);
  state.head = merged;
  state.merge = 'CLEAN';
  state.build = build;
}
