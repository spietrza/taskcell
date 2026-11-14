import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runApprover } from './approve.js';
import { mergeTree, collectDiffFacts } from './diff-facts.js';
import { loadPolicy } from './policy.js';
import { resolveRemoteBaseRef } from '../core/base-branch.js';
import { assertActSafeGhArgs, isReleasePr, hardExclusions, escapeForComment } from './act.js';
import { readBranchFile } from '../core/metrics-branch.js';
import type { GhRunner } from '../tasks/github.js';
import type { ApproverPolicy } from './types.js';

const logFail = vi.hoisted(() => ({ on: false, mergeAction: false }));
vi.mock('./record.js', async (orig) => {
  const mod = await orig<typeof import('./record.js')>();
  return {
    ...mod,
    appendDecision: async (...a: Parameters<typeof mod.appendDecision>): Promise<void> => {
      if (logFail.on && (a[1] as { actMerge?: boolean }).actMerge === true) throw new Error('log down');
      return mod.appendDecision(...a);
    },
    appendAction: async (...a: Parameters<typeof mod.appendAction>): Promise<void> => {
      if (logFail.mergeAction && a[1].action === 'merge') throw new Error('log down');
      return mod.appendAction(...a);
    },
  };
});

let root: string;
let origin: string;
let repo: string;
let headSha: string;
let baseSha: string;

const POLICY = {
  schemaVersion: 1,
  enabled: true,
  act: true,
  factoryAuthors: ['app/taskcell'],
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

const reviewBody = (sha: string): string => `## Taskcell Review\n\nVerdict: NO BLOCKING FINDINGS\n\nLooks good.\n\n<!-- taskcell-pr-review: ${sha} -->\n\n<!-- taskcell-pr-review-run: ${sha}:42 -->`;

interface PrState {
  head: string;
  isDraft: boolean;
  merge: string;
  headRefName: string;
  title: string;
  build: string | null;
  author: string;
  labels: string[];
  humanReviews: Array<{ login: string; state: string; at?: string }>;
  /** The verdict review carries the host's run stamp (default true). */
  stamped?: boolean;
  /** GitHub's commit id for the verdict review: the head at submit time (default: the reviewed head). */
  reviewCommit?: string;
  /** false: no verdict review posted yet. */
  reviewed?: boolean;
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
        author: { login: pr.author }, labels: pr.labels.map((name) => ({ name })),
        reviews: [
          ...(pr.reviewed === false ? [] : [{ author: { login: 'bot' }, body: pr.stamped === false ? reviewBody(headSha).replace(/\n\n<!-- taskcell-pr-review-run.*$/, '') : reviewBody(headSha), submittedAt: '2026-10-20T00:00:00Z', state: 'COMMENTED', commit: { oid: pr.reviewCommit ?? headSha } }]),
          ...pr.humanReviews.map((r) => ({ author: { login: r.login }, body: 'please fix', submittedAt: r.at ?? '2026-10-21T00:00:00Z', state: r.state })),
        ],
      });
    }
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

const pr = (over: Partial<PrState> = {}): PrState => ({ head: headSha, isDraft: false, merge: 'CLEAN', headRefName: 'chore/vanguard-1', title: 'feat: x', build: 'success', author: 'app/taskcell', labels: [], humanReviews: [], ...over });
const run = (gh: GhRunner, mode: 'shadow' | 'act' = 'act'): ReturnType<typeof runApprover> =>
  runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode, gh, sleep: async () => {} });
const writes = (calls: string[][], sub: string): string[][] => calls.filter((a) => a[0] === 'pr' && a[1] === sub);
const records = async (): Promise<Array<Record<string, unknown>>> =>
  (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const actions = async (): Promise<string[]> =>
  (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n').map((l) => JSON.parse(l) as { action?: string }).flatMap((r) => (r.action !== undefined ? [r.action] : []));

const loaded = POLICY as unknown as ApproverPolicy;

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
      expect(verdicts.map((r) => [r.verdict, r.mode, r.headSha, r.actMerge ?? false])).toEqual([['APPROVE', 'act', headSha, false], ['APPROVE', 'act', state.head, false], ['APPROVE', 'act', state.head, true]]);
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

    it('a failed pre-merge decision log does not merge, and says why', async () => {
      const calls: string[][] = [];
      logFail.on = true;
      try {
        await expect(run(fakeGh(calls, pr()))).rejects.toThrow(/log down/);
      } finally {
        logFail.on = false;
      }
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('could not be logged'))).toBe(true);
      expect((await records()).at(-1)).toMatchObject({ action: 'error', reasonCode: 'decision-log-failed', headSha });
    });

    it('a merge whose action log fails is reported as merged, not as a failed merge', async () => {
      const calls: string[][] = [];
      logFail.mergeAction = true;
      try {
        await run(fakeGh(calls, pr()));
      } finally {
        logFail.mergeAction = false;
      }
      expect(writes(calls, 'merge')).toHaveLength(1);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('merged, but the action log failed'))).toBe(true);
      expect(await actions()).toEqual(['error']);
      expect((await records()).at(-1)).toMatchObject({ action: 'error', reasonCode: 'merge-log-failed', headSha });
    });

    it('leaves the PR when the base tip moved between the decision and the merge', async () => {
      const calls: string[][] = [];
      const inner = fakeGh(calls, pr());
      let views = 0;
      const gh: GhRunner = async (args) => {
        // A push to the base after the decision; the API's baseRefOid still names the old tip (it can lag).
        if (args[0] === 'pr' && args[1] === 'view' && !args.includes('comments') && (views += 1) === 2) {
          const stale = baseSha;
          await moveBase('other.txt');
          baseSha = stale;
        }
        return inner(args);
      };
      await run(gh);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('base tip moved'))).toBe(true);
    });

    it('a failing re-read before the merge is commented once, whatever the gh error text says', async () => {
      const calls: string[][] = [];
      for (const requestId of ['A1', 'B2']) {
        const inner = fakeGh(calls, pr());
        let views = 0;
        const gh: GhRunner = async (args) => {
          if (args[0] === 'pr' && args[1] === 'view' && !args.includes('comments') && (views += 1) > 1) throw new Error(`gh: HTTP 502 (request ${requestId})`);
          if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return JSON.stringify({ comments: writes(calls, 'comment').map((a) => ({ body: a.at(-1), author: { login: 'github-actions[bot]' } })) });
          return inner(args);
        };
        await run(gh);
      }
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment')).toHaveLength(1);
      expect(writes(calls, 'comment')[0]!.join(' ')).toContain('could not re-read the PR');
      expect((await records()).filter((r) => r.action !== undefined)).toMatchObject([{ action: 'left-for-human', reasonCode: 'pre-merge-read-failed' }]);
    });

    it('--mode act reads the policy strictly from the fetched base: an unreachable remote is policy-unreadable, never a stale local policy', async () => {
      await execa('git', ['remote', 'set-url', 'origin', join(root, 'nowhere.git')], { cwd: repo });
      const input = { repoPath: repo, repoSlug: 'o/r', prNumber: 1, gh: fakeGh([], pr()), dryRun: true };
      expect((await runApprover({ ...input, mode: 'shadow' })).record.rulesFired).not.toContain('policy-unreadable');
      const calls: string[][] = [];
      await runApprover({ ...input, gh: fakeGh(calls, pr({ merge: 'BEHIND' })), mode: 'act', dryRun: false }).catch(() => {});
      expect(calls.some((a) => a.join(' ').includes('policy-unreadable'))).toBe(true);
      expect(writes(calls, 'update-branch')).toEqual([]);
    });

    it('the seed and the record come from the settled PR read, not the first one', async () => {
      const calls: string[][] = [];
      const inner = fakeGh(calls, pr());
      let views = 0;
      const gh: GhRunner = async (args) => {
        const out = await inner(args);
        // The first read: mergeability still UNKNOWN, and an older head that is replaced during the retries.
        if (args[0] === 'pr' && args[1] === 'view' && !args.includes('comments') && (views += 1) === 1) {
          return JSON.stringify({ ...(JSON.parse(out) as object), mergeStateStatus: 'UNKNOWN', headRefOid: 'f'.repeat(40) });
        }
        return out;
      };
      const { record } = await run(gh);
      expect(record.auditSample.seed).toContain(`:${headSha}:`);
      expect(record.auditSample.seed).not.toContain('f'.repeat(40));
      expect(writes(calls, 'merge')).toHaveLength(1);
    });

    it('a run triggered before any review was posted comments nothing; the later review merges', async () => {
      const state = pr({ reviewed: false });
      const calls: string[][] = [];
      const { record } = await run(fakeGh(calls, state));
      expect(record.rulesFired).toContain('review-missing');
      expect(writes(calls, 'comment')).toEqual([]);
      expect(writes(calls, 'merge')).toEqual([]);
      expect((await records()).at(-1)).toMatchObject({ action: 'left-for-human', reason: expect.stringContaining('review-missing') });
      state.reviewed = true;
      await run(fakeGh(calls, state));
      expect(writes(calls, 'merge')).toHaveLength(1);
      expect(writes(calls, 'comment')).toEqual([]);
    });

    it('a review submitted after a push (its commit id is not the stamped SHA) is no verdict in act mode', async () => {
      const calls: string[][] = [];
      const { record } = await run(fakeGh(calls, pr({ reviewCommit: 'e'.repeat(40) })));
      expect(record.rulesFired).toContain('review-missing');
      expect(writes(calls, 'merge')).toEqual([]);
      expect((await run(fakeGh([], pr({ reviewCommit: 'e'.repeat(40) })), 'shadow')).record.verdict).toBe('APPROVE');
    });

    it('leaves the PR when a required check regressed before the merge', async () => {
      const calls: string[][] = [];
      const inner = fakeGh(calls, pr());
      let checkReads = 0;
      const gh: GhRunner = async (args) => {
        if (args[0] === 'api' && args[1]?.includes('check-runs?per_page') && (checkReads += 1) > 1) {
          return JSON.stringify({ check_runs: [{ name: 'build', conclusion: 'failure', app: { id: 15368 } }] });
        }
        return inner(args);
      };
      await run(gh);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('check-missing:build'))).toBe(true);
    });

    it('a token in the merge error is redacted in the comment and the log', async () => {
      const token = `ghp_${'a1B2'.repeat(9)}`;
      const calls: string[][] = [];
      const base = fakeGh(calls, pr());
      const gh: GhRunner = async (args) => {
        if (args[1] === 'merge') throw new Error(`HTTP 405 for https://x-access-token:${token}@github.com/o/r`);
        return base(args);
      };
      const thrown = await run(gh).then(() => undefined, (err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('HTTP 405');
      expect((thrown as Error).message).not.toContain(token); // the CLI prints this to the workflow log
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('merge was rejected'))).toBe(true);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes(token))).toBe(false);
      expect(await readBranchFile(repo, { file: 'decisions.jsonl' })).not.toContain(token);
    });

    it('kill switch under --mode act: stopped, nothing acted on', async () => {
      process.env.TASKCELL_APPROVER_STOP = '1';
      try {
        const calls: string[][] = [];
        const { record } = await run(fakeGh(calls, pr()));
        expect(record.rulesFired).toEqual(['stopped']);
        expect(calls.some((a) => a[0] === 'pr' && ['merge', 'ready', 'update-branch'].includes(a[1]!))).toBe(false);
        expect(await actions()).toEqual([]);
      } finally {
        delete process.env.TASKCELL_APPROVER_STOP;
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

    it('a draft is never marked ready, even with green checks: left for a human with one comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ isDraft: true })));
      expect(writes(calls, 'ready')).toEqual([]);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment')).toHaveLength(1);
      expect(writes(calls, 'comment')[0]!.join(' ')).toContain('draft PR');
      expect(await actions()).toEqual(['left-for-human']);
    });

    it('a draft whose checks failed also gets exactly one comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ isDraft: true, build: 'failure' })));
      expect(writes(calls, 'ready')).toEqual([]);
      expect(writes(calls, 'comment')).toHaveLength(1);
      expect(await actions()).toEqual(['left-for-human']);
    });

    it('a human review requesting changes is a hold: no update, no merge, a comment', async () => {
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, pr({ humanReviews: [{ login: 'spietrza', state: 'CHANGES_REQUESTED' }] })));
      expect(writes(calls, 'update-branch')).toEqual([]);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('a review requests changes'))).toBe(true);
      expect(await actions()).toEqual(['left-for-human']);
    });

    it('the hold label (default taskcell:hold) is a hold: no merge, a comment', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ labels: ['taskcell:hold'] })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('hold label taskcell:hold'))).toBe(true);
    });

    it('the legacy spelling vanguard:hold is a hold too', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ labels: ['vanguard:hold'] })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('hold label taskcell:hold'))).toBe(true);
    });

    it('the policy can rename the hold label', async () => {
      await rm(root, { recursive: true, force: true });
      await setup({ ...POLICY, holdLabel: 'wait' }, { 'src.ts': 'export const x = 1;\n' });
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ labels: ['wait'] })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('hold label wait'))).toBe(true);
    });

    it.each(['BLOCKED', 'UNSTABLE', 'UNKNOWN', 'DIRTY'])('mergeStateStatus %s is left for a human', async (merge) => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ merge })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'update-branch')).toEqual([]);
      expect(await actions()).toEqual(['left-for-human']);
    });

    it('a mergeStateStatus other than CLEAN after the update is left for a human', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, async () => {
        await updateBranch(state, 'success');
        state.merge = 'BLOCKED';
      }));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('mergeStateStatus BLOCKED'))).toBe(true);
      expect(await actions()).toEqual(['update-branch', 'left-for-human']);
    });

    it('equal patch-id is not enough: a head whose tree differs from base merged into the reviewed commit is not merged', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      // A whitespace-only edit after the base merge: patch-id (whitespace-blind) still equals the reviewed one, the tree does not.
      await run(fakeGh(calls, state, () => updateBranch(state, 'success', { 'src.ts': 'export const x  = 1;\n' })));
      const verdicts = (await records()).filter((r) => r.verdict !== undefined);
      expect(verdicts.at(-1)).toMatchObject({ verdict: 'APPROVE', headSha: state.head }); // the shadow (patch-id) rule still approves
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('review-stale'))).toBe(true);
      expect(await actions()).toEqual(['update-branch', 'left-for-human']);
    });

    it.each([['another login', 'someone'], ['no author', '']])('a factory-branch PR with %s as API author is left for a human', async (_n, author) => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ author })));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('not opened by the factory'))).toBe(true);
    });

    it('an empty requiredChecks acts on nothing', async () => {
      await rm(root, { recursive: true, force: true });
      await setup({ ...POLICY, requiredChecks: [] }, { 'src.ts': 'export const x = 1;\n' });
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()));
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('no required checks'))).toBe(true);
    });

    it('no dedicated reviewer login in reviewAuthors acts on nothing, with a stable reason code', async () => {
      await rm(root, { recursive: true, force: true });
      await setup({ ...POLICY, reviewAuthors: ['github-actions', 'github-actions[bot]'] }, { 'src.ts': 'export const x = 1;\n' });
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()));
      expect(calls.some((c) => c[0] === 'pr' && ['merge', 'ready', 'update-branch'].includes(c[1]!))).toBe(false);
      expect(writes(calls, 'comment').some((c) => c.join(' ').includes('no dedicated reviewer login'))).toBe(true);
      expect((await records()).at(-1)).toMatchObject({ action: 'left-for-human', reasonCode: 'no-dedicated-reviewer' });
    });

    it('state is re-read before the merge: a hold label added meanwhile stops it', async () => {
      const state = pr();
      const calls: string[][] = [];
      const base = fakeGh(calls, state);
      let views = 0;
      const gh: GhRunner = async (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && !args.includes('comments')) {
          views += 1;
          if (views >= 2) state.labels = ['taskcell:hold'];
        }
        return base(args);
      };
      await run(gh);
      expect(views).toBeGreaterThanOrEqual(2);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('changed before the merge'))).toBe(true);
    });

    it('the policy is re-read before the merge: enabled:false pushed meanwhile stops it', async () => {
      const calls: string[][] = [];
      const base = fakeGh(calls, pr());
      let views = 0;
      const gh: GhRunner = async (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && !args.includes('comments')) {
          views += 1;
          if (views === 2) {
            const seed = join(root, 'seed');
            await git(seed, ['checkout', '--quiet', 'main']);
            await writeFile(join(seed, '.taskcell', 'approver.json'), JSON.stringify({ ...POLICY, enabled: false }));
            await git(seed, ['commit', '--quiet', '-am', 'stop']);
            await git(seed, ['push', '--quiet', origin, 'main']);
          }
        }
        return base(args);
      };
      await run(gh);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('changed before the merge'))).toBe(true);
      // The stale check runs before the act-merge APPROVE record is written.
      expect((await records()).some((r) => r.actMerge === true)).toBe(false);
    });

    it('a comment that cannot be posted fails the run instead of passing silently', async () => {
      const calls: string[][] = [];
      const base = fakeGh(calls, pr({ labels: ['taskcell:hold'] }));
      const gh: GhRunner = async (args) => {
        if (args[0] === 'pr' && args[1] === 'comment') throw new Error('HTTP 403');
        return base(args);
      };
      await expect(run(gh)).rejects.toThrow(/could not be reported/);
      expect(await actions()).toEqual(['left-for-human']);
    });

    it('a failed fetch of the base is git-facts-failed in act mode, a stale local base otherwise', async () => {
      // Not `git branch main origin/main`: whether the clone already has a local main depends on the machine's init.defaultBranch.
      await git(repo, ['update-ref', 'refs/heads/main', 'refs/remotes/origin/main']);
      await execa('git', ['remote', 'set-url', 'origin', join(root, 'nowhere.git')], { cwd: repo });
      const input = { repoPath: repo, prNumber: 1, baseRefName: 'main', apiHeadSha: headSha, reviewedSha: null, policy: loaded };
      expect((await collectDiffFacts(input)).baseSha).not.toBe('');
      const strict = await collectDiffFacts({ ...input, requireRemoteBase: true });
      expect(strict).toMatchObject({ gitFactsFailed: true, baseSha: '' });
      await expect(resolveRemoteBaseRef(repo, 'main', { requireRemote: true, keepLocalIfAhead: false })).rejects.toThrow(/cannot use the remote main/);
      expect(await loadPolicy(repo, 'main')).toBeDefined();
      expect(await loadPolicy(repo, 'main', { requireRemote: true })).toBeUndefined();
    });

    it('UNKNOWN mergeStateStatus is retried before the PR is left for a human', async () => {
      const state = pr({ merge: 'UNKNOWN' });
      const calls: string[][] = [];
      const base = fakeGh(calls, state);
      let views = 0;
      const gh: GhRunner = async (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && !args.includes('comments')) {
          views += 1;
          if (views >= 3) state.merge = 'CLEAN';
        }
        return base(args);
      };
      await run(gh);
      expect(writes(calls, 'merge')).toHaveLength(1);
    });

    it('a different reason on the same head is reported again', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ merge: 'BLOCKED' })));
      await run(fakeGh(calls, pr({ labels: ['taskcell:hold'] })));
      expect(writes(calls, 'comment')).toHaveLength(2);
      const markers = writes(calls, 'comment').map((a) => /taskcell-approver-act: \S+/.exec(a.join(' '))?.[0]);
      expect(new Set(markers).size).toBe(2);
      expect(await actions()).toEqual(['left-for-human', 'left-for-human']);
    });

    it('an approval after a change request releases the hold', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ humanReviews: [
        { login: 'alice', state: 'CHANGES_REQUESTED', at: '2026-10-21T00:00:00Z' },
        { login: 'alice', state: 'APPROVED', at: '2026-10-22T00:00:00Z' },
      ] })));
      expect(writes(calls, 'merge')).toHaveLength(1);
      const held: string[][] = [];
      await run(fakeGh(held, pr({ humanReviews: [
        { login: 'alice', state: 'APPROVED', at: '2026-10-21T00:00:00Z' },
        { login: 'alice', state: 'CHANGES_REQUESTED', at: '2026-10-22T00:00:00Z' },
      ] })));
      expect(writes(held, 'merge')).toEqual([]);
    });

    it('a dismissed review and an unnamed reviewer do not release a change request', () => {
      const facts = { pr: { isDraft: false, labels: [], author: 'app/taskcell', headRefName: 'chore/vanguard-1', title: 'x', mergeStateStatus: 'CLEAN' }, diff: { paths: [] } } as never;
      const r = (author: string, state: string, at: string) => ({ author, body: '', submittedAt: at, state });
      expect(hardExclusions(facts, loaded, [r('alice', 'CHANGES_REQUESTED', '1'), r('alice', 'DISMISSED', '2')])).toContain('a review requests changes');
      expect(hardExclusions(facts, loaded, [r('', 'CHANGES_REQUESTED', '1'), r('', 'APPROVED', '2')])).toContain('a review requests changes');
      expect(hardExclusions(facts, loaded, [r('alice', 'DISMISSED', '1')])).not.toContain('a review requests changes');
    });

    it('hardExclusions: one reviewer approving does not release another reviewer\'s change request', () => {
      const facts = { pr: { isDraft: false, labels: [], author: 'app/taskcell', headRefName: 'chore/vanguard-1', title: 'x', mergeStateStatus: 'CLEAN' }, diff: { paths: [] } } as never;
      const reviews = [
        { author: 'alice', body: '', submittedAt: '1', state: 'CHANGES_REQUESTED' },
        { author: 'bob', body: '', submittedAt: '2', state: 'APPROVED' },
      ];
      expect(hardExclusions(facts, loaded, reviews)).toContain('a review requests changes');
    });

    it('only the verdict review the PR-review workflow stamped counts in act mode', async () => {
      const unstamped: string[][] = [];
      await run(fakeGh(unstamped, pr({ stamped: false })));
      expect(writes(unstamped, 'merge')).toEqual([]);
      const shadow: string[][] = [];
      expect((await run(fakeGh(shadow, pr({ stamped: false })), 'shadow')).record.verdict).toBe('APPROVE');
      const stamped: string[][] = [];
      await run(fakeGh(stamped, pr()));
      expect(writes(stamped, 'merge')).toHaveLength(1);
    });

    it('an initial BEHIND state is updated, then merged after the checks', async () => {
      const state = pr({ merge: 'BEHIND' });
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, () => updateBranch(state, 'success')));
      expect(writes(calls, 'update-branch')).toHaveLength(1);
      expect(writes(calls, 'merge')).toHaveLength(1);
    });

    it('a failed update-branch is commented and logged, not thrown', async () => {
      const state = pr({ merge: 'BEHIND' });
      const calls: string[][] = [];
      await moveBase('other.txt');
      await run(fakeGh(calls, state, async () => { throw new Error('HTTP 422: merge conflict @evil'); }));
      expect(writes(calls, 'merge')).toEqual([]);
      const comment = writes(calls, 'comment').map((a) => a.join(' ')).join('\n');
      expect(comment).toContain('the branch update failed');
      expect(comment).not.toContain('@evil');
      expect(await actions()).toEqual(['error']);
    });

    it('a gh error while polling the updated head is commented and logged, not thrown', async () => {
      const state = pr();
      const calls: string[][] = [];
      await moveBase('other.txt');
      const base = fakeGh(calls, state, () => updateBranch(state, null));
      let updated = false;
      const gh: GhRunner = async (args) => {
        if (args[1] === 'update-branch') updated = true;
        if (updated && args[0] === 'pr' && args[1] === 'view' && !args.includes('comments')) throw new Error('gh: HTTP 502');
        return base(args);
      };
      await run(gh);
      expect(writes(calls, 'merge')).toEqual([]);
      expect(await actions()).toEqual(['update-branch', 'error']);
    });

    it('the comment escapes mentions, markup and CI-config paths in the reason', () => {
      const out = escapeForComment('touches CI config (.github/workflows/x.yml) @evil <img src=x> #12');
      expect(out).not.toMatch(/@evil|<img|\.github\/workflows|#12/);
      expect(out).toContain('@\u200bevil');
      // A backslash in the input must not cancel the escape added after it and leave a live link.
      expect(escapeForComment('\\[x\\](y)')).toBe('\\\\\\[x\\\\\\]\\(y\\)');
    });

    it('a merge rejection with markup in the gh error is escaped in the comment', async () => {
      const calls: string[][] = [];
      const base = fakeGh(calls, pr());
      const gh: GhRunner = async (args) => {
        if (args[1] === 'merge') throw new Error('rejected @evil <script>');
        return base(args);
      };
      await expect(run(gh)).rejects.toThrow(/rejected/);
      const comment = writes(calls, 'comment').map((a) => a.join(' ')).join('\n');
      expect(comment).toContain('merge was rejected');
      expect(comment).not.toMatch(/@evil|<script>/);
    });

    it('a policy without factoryAuthors acts on nothing', async () => {
      await rm(root, { recursive: true, force: true });
      const { factoryAuthors: _f, ...noAuthors } = POLICY;
      await setup(noAuthors, { 'src.ts': 'export const x = 1;\n' });
      const calls: string[][] = [];
      await run(fakeGh(calls, pr()));
      expect(writes(calls, 'merge')).toEqual([]);
    });

    it('a merge after an earlier ESCALATE for the same head is preceded by an APPROVE record', async () => {
      const state = pr({ build: 'failure' });
      const calls: string[][] = [];
      await run(fakeGh(calls, state));
      state.build = 'success'; // checks re-run green on the same head
      await run(fakeGh(calls, state));
      expect(writes(calls, 'merge')).toHaveLength(1);
      const log = (await records()).map((r) => r.action ?? r.verdict);
      expect(log).toEqual(['ESCALATE', 'left-for-human', 'APPROVE', 'merge']);
      expect((await records())[2]).toMatchObject({ verdict: 'APPROVE', headSha, actMerge: true });
    });

    it('a draft release PR is not marked ready', async () => {
      const calls: string[][] = [];
      await run(fakeGh(calls, pr({ isDraft: true, title: 'chore(main): release 1.2.0' })));
      expect(writes(calls, 'ready')).toEqual([]);
      expect(writes(calls, 'comment').some((a) => a.join(' ').includes('release PR'))).toBe(true);
    });

    it('act-mode guard allows only the two writes and shadow calls', () => {
      expect(() => assertActSafeGhArgs(['pr', 'merge', '1', '--repo', 'o/r', '--squash', '--match-head-commit', 'a'.repeat(40)])).not.toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'merge', '1', '--repo', 'o/r', '--admin', '--squash', '--match-head-commit', 'a'.repeat(40)])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'merge', '1', '--repo', 'o/r', '--rebase'])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'update-branch', '1', '--repo', 'o/r', '--rebase'])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'close', '1', '--repo', 'o/r'])).toThrow();
      expect(() => assertActSafeGhArgs(['pr', 'ready', '1', '--repo', 'o/r'])).toThrow();
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
  baseSha = (await git(seed, ['rev-parse', 'HEAD'])).trim();
}

/** What update-branch does: a real `git merge main` into the PR branch (plus, optionally, an extra commit), pushed as the PR head. */
async function updateBranch(state: PrState, build: string | null, extra?: string | Record<string, string>): Promise<void> {
  const seed = join(root, 'seed');
  await git(seed, ['checkout', '--quiet', 'chore/vanguard-1']);
  await git(seed, ['merge', '--quiet', '--no-edit', 'main']);
  if (extra !== undefined) {
    for (const [file, body] of Object.entries(typeof extra === 'string' ? { [extra]: 'export const y = 2;\n' } : extra)) await writeFile(join(seed, file), body);
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '--quiet', '-m', 'extra']);
  }
  const merged = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', '--quiet', '--force', origin, `${merged}:refs/pull/1/head`]);
  state.head = merged;
  state.merge = 'CLEAN';
  state.build = build;
}

describe('mergeTree', () => {
  beforeEach(() => setup(POLICY, { 'src.ts': 'export const x = 1;\n' }));

  it('parses a clean merge (the tree oid), a conflict, and a failure', async () => {
    await execa('git', ['fetch', '--quiet', 'origin', 'refs/pull/1/head'], { cwd: repo });
    const clean = await mergeTree(repo, baseSha, headSha);
    expect(clean.clean).toBe(true);
    expect(clean.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.tree).not.toContain('\n');
    const seed = join(root, 'seed');
    await git(seed, ['checkout', '--quiet', 'main']);
    await writeFile(join(seed, 'src.ts'), 'export const x = 2;\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '--quiet', '-m', 'conflicting']);
    const tip = await git(seed, ['rev-parse', 'HEAD']);
    await git(seed, ['push', '--quiet', origin, 'main']);
    await execa('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: repo });
    expect(await mergeTree(repo, tip, headSha)).toEqual({ clean: false, tree: undefined });
    expect((await mergeTree(repo, 'deadbeef'.repeat(5), headSha)).clean).not.toBe(true);
  });
});
