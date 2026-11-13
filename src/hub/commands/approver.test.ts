import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as approverCard from '../approver-card.js';
import * as outcome from '../../approver/outcome.js';
import * as policy from '../../approver/policy.js';
import * as metricsBranch from '../../core/metrics-branch.js';
import { collectApproverScorecard } from '../../approver/outcome.js';
import { parseDecisions } from '../../approver/scorecard.js';
import { BadRequestError } from '../../sidecar/sidecar.js';
import type { ApproverPolicy } from '../../approver/types.js';
import type { ApproverScorecard } from '../../wire.js';
import { dispatchRpc, makeCtx, tmpGitRepo } from '../test-kit.js';

const ORIGIN = 'https://github.com/acme/widgets.git';
const NOW = Date.parse('2026-11-13T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
const line = (o: Record<string, unknown>): string => JSON.stringify({ repo: 'acme/widgets', rulesFired: [], headSha: 'a'.repeat(40), ...o });

// 3 APPROVE (2 merged as is, 1 changed), 2 ESCALATE (size), 1 old ESCALATE outside 90 days.
const DECISIONS = [
  line({ prNumber: 1, verdict: 'APPROVE', timestamp: daysAgo(10) }),
  line({ prNumber: 2, verdict: 'APPROVE', timestamp: daysAgo(9) }),
  line({ prNumber: 3, verdict: 'APPROVE', timestamp: daysAgo(8), headSha: 'c'.repeat(40) }),
  line({ prNumber: 4, verdict: 'ESCALATE', rulesFired: ['size-lines', 'path:src'], timestamp: daysAgo(7) }),
  line({ prNumber: 5, verdict: 'ESCALATE', rulesFired: ['size-lines'], timestamp: daysAgo(6) }),
  line({ prNumber: 6, verdict: 'ESCALATE', rulesFired: ['size-files'], timestamp: daysAgo(200) }),
  line({ prNumber: 7, verdict: 'ESCALATE', rulesFired: ['size-lines'], timestamp: daysAgo(5) }),
  line({ prNumber: 7, verdict: 'APPROVE', action: 'merge', timestamp: daysAgo(4) }),
].join('\n');

const prs = [1, 2, 3, 4, 5, 6].map((n) => ({
  number: n,
  headRefName: `chore/vanguard-${n}`,
  state: 'MERGED',
  mergedAt: daysAgo(3),
  headRefOid: n === 3 ? 'd'.repeat(40) : 'a'.repeat(40),
  mergeCommit: { oid: `${n}`.repeat(40) },
}));
const ghCalls: string[][] = [];
const gh = async (args: string[]): Promise<string> => (ghCalls.push(args), args[0] === 'pr' ? JSON.stringify(prs) : JSON.stringify([[]]));

function mockWorld(decisions: string, pol?: Partial<ApproverPolicy>): void {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(metricsBranch, 'readBranchFile').mockResolvedValue(decisions);
  vi.spyOn(policy, 'loadPolicy').mockResolvedValue(
    pol === undefined ? undefined : ({ policy: { enabled: true, ...pol } as ApproverPolicy, policyHash: 'h', raw: '{}' }),
  );
  const real = collectApproverScorecard;
  vi.spyOn(outcome, 'collectApproverScorecard').mockImplementation((d, o) => real(d, { ...o, gh }));
}

afterEach(() => vi.restoreAllMocks());

describe('approver commands', () => {
  test('the scorecard numbers match the CLI scorecard for the same period', async () => {
    mockWorld(DECISIONS, { act: false });
    const repo = await tmpGitRepo(ORIGIN);
    const { ctx } = await makeCtx(repo);
    const card = (await dispatchRpc(ctx, 'read_approver_scorecard', { repoPath: repo, period: '90d' })) as ApproverScorecard;

    const decisions = parseDecisions(DECISIONS).filter((d) => Date.parse(d.timestamp) >= NOW - 90 * 86_400_000);
    const cli = await collectApproverScorecard(decisions, { gh });
    expect(card.status).toBe('ok');
    expect(card.judged).toBe(cli.rows.filter((r) => r.verdict !== null).length);
    expect(card.byRiskClass).toEqual(cli.byRiskClass.map(({ riskClass, approveTotal, approveCorrect, streak }) => ({ riskClass, approveTotal, approveCorrect, streak })));
    expect(card).toMatchObject({ judged: 5, approves: 3, escalates: 2, approvesRight: 2, approvesWrong: 1, approvesPending: 0, barMet: false, threshold: 30, mode: 'shadow' });
    expect(card.topReasons).toEqual([{ reason: 'size-lines', count: 2 }, { reason: 'path:src', count: 1 }]);
    // 'all' also counts the 200-day-old decision.
    const all = (await dispatchRpc(ctx, 'read_approver_scorecard', { repoPath: repo, period: 'all' })) as ApproverScorecard;
    expect(all.judged).toBe(6);
  });

  test('no decisions (or none in the period) is an explanation, not zeros', async () => {
    mockWorld('', undefined);
    const repo = await tmpGitRepo(ORIGIN);
    const { ctx } = await makeCtx(repo);
    const none = (await dispatchRpc(ctx, 'read_approver_scorecard', { repoPath: repo })) as ApproverScorecard;
    expect(none).toMatchObject({ status: 'no-data', mode: 'off', policyFound: false });
    expect(none.hint).toMatch(/No approver decisions/);
    vi.restoreAllMocks();
    mockWorld(line({ prNumber: 9, verdict: 'ESCALATE', timestamp: daysAgo(100) }), { enabled: false });
    const old = (await dispatchRpc(ctx, 'read_approver_scorecard', { repoPath: repo, period: '30d' })) as ApproverScorecard;
    expect(old).toMatchObject({ status: 'no-data', mode: 'off' });
    expect(old.hint).toMatch(/last 30 days/);
  });

  test('the policy read and the metrics-branch read never overlap (both fetch, and the metrics read uses FETCH_HEAD)', async () => {
    mockWorld(DECISIONS, { act: false });
    let policyDone = false;
    let overlapped = false;
    vi.spyOn(policy, 'loadPolicy').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      policyDone = true;
      return { policy: { enabled: true, act: false } as ApproverPolicy, policyHash: 'h', raw: '{}' };
    });
    vi.spyOn(metricsBranch, 'readBranchFile').mockImplementation(async () => {
      if (!policyDone) overlapped = true;
      return DECISIONS;
    });
    const card = await approverCard.approverScorecard(await tmpGitRepo(ORIGIN), '90d', NOW);
    expect(overlapped).toBe(false);
    expect(card.status).toBe('ok');
  });

  test('mode comes from the policy: enabled+act is act', async () => {
    mockWorld(DECISIONS, { act: true });
    expect((await approverCard.readApproverMode(await tmpGitRepo(ORIGIN))).mode).toBe('act');
  });

  test('per-PR decisions: merged automatically, left with reasons', async () => {
    mockWorld(DECISIONS, { act: false });
    const repo = await tmpGitRepo(ORIGIN);
    const { ctx } = await makeCtx(repo);
    const { decisions } = (await dispatchRpc(ctx, 'read_approver_decisions', { repoPath: repo })) as { decisions: { prNumber: number; outcome: string; reasons: string[] }[] };
    expect(decisions.find((d) => d.prNumber === 7)).toEqual({ prNumber: 7, outcome: 'merged', reasons: [] });
    expect(decisions.find((d) => d.prNumber === 4)).toEqual({ prNumber: 4, outcome: 'left', reasons: ['size-lines', 'path:src'] });
    expect(decisions.find((d) => d.prNumber === 1)?.outcome).toBe('would-merge');
  });

  describe('set_approver_mode', () => {
    test('opens a PR through the helper and states the scorecard numbers', async () => {
      mockWorld(DECISIONS, { act: false });
      const open = vi.spyOn(approverCard, 'openApproverModePr').mockResolvedValue({ branch: 'b', prUrl: 'https://github.com/acme/widgets/pull/9', mode: 'off' });
      const repo = await tmpGitRepo(ORIGIN);
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'shadow' })).resolves.toMatchObject({ prUrl: 'https://github.com/acme/widgets/pull/9' });
      expect(open.mock.calls[0]![0].card).toMatchObject({ judged: 5, approves: 3 });
    });

    test('refuses a non-loopback bind without allow-add and a bad mode', async () => {
      mockWorld(DECISIONS, { act: false });
      const repo = await tmpGitRepo(ORIGIN);
      const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'off' })).rejects.toThrow(BadRequestError);
      const { ctx: local } = await makeCtx(repo);
      await expect(dispatchRpc(local, 'set_approver_mode', { repoPath: repo, mode: 'yolo' })).rejects.toThrow(/mode must be/);
    });

    test('act is refused while #939 is open', async () => {
      mockWorld(DECISIONS, { act: false });
      const open = vi.spyOn(approverCard, 'openApproverModePr');
      const repo = await tmpGitRepo(ORIGIN);
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'act', confirmBelowBar: true })).rejects.toThrow(/#939/);
      expect(open).not.toHaveBeenCalled();
    });

    test('below the bar act needs the explicit confirmation; at the bar it does not', async () => {
      mockWorld(DECISIONS, { act: false });
      vi.spyOn(approverCard, 'ACT_BLOCKING_ISSUES', 'get').mockReturnValue([]);
      const open = vi.spyOn(approverCard, 'openApproverModePr').mockResolvedValue({ branch: 'b', prUrl: 'https://github.com/acme/widgets/pull/9', mode: 'act' });
      const repo = await tmpGitRepo(ORIGIN);
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'act' })).rejects.toThrow(/has not met the bar/);
      expect(open).not.toHaveBeenCalled();
      await dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'act', confirmBelowBar: true });
      expect(open).toHaveBeenCalledOnce();
    });
  });

  test('policyForMode flips enabled/act and keeps every other key; the PR body carries the numbers', () => {
    const raw = JSON.stringify({ schemaVersion: 1, enabled: true, shape: { maxLines: 5 } });
    expect(JSON.parse(approverCard.policyForMode(raw, 'act'))).toEqual({ schemaVersion: 1, enabled: true, act: true, shape: { maxLines: 5 } });
    expect(JSON.parse(approverCard.policyForMode(raw, 'off'))).toMatchObject({ enabled: false, act: false });
  });
});

describe('openApproverModePr', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });
  /** A real git repo whose origin is a bare repo with the policy on main; gh is faked. */
  async function world(): Promise<{ repo: string; origin: string; calls: string[][]; exec: (f: string, a: string[], o?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }> }> {
    const root = await mkdtemp(join(tmpdir(), 'vg-mode-'));
    roots.push(root);
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    const g = (cwd: string, ...a: string[]) => execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });
    await execa('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
    await execa('git', ['init', '--quiet', '-b', 'main', repo]);
    await g(repo, 'remote', 'add', 'origin', origin);
    await mkdir(join(repo, '.taskcell'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'approver.json'), '{\n    "schemaVersion": 1,\n    "enabled": true,\n    "shape": { "maxLines": 5, "paths": ["a", "b"] }\n}\n');
    await writeFile(join(repo, 'README.md'), 'x\n');
    await g(repo, 'add', '.');
    await g(repo, 'commit', '--quiet', '-m', 'seed');
    await g(repo, 'push', '--quiet', 'origin', 'main');
    const calls: string[][] = [];
    const exec = async (file: string, args: string[], o?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> => {
      calls.push([file, ...args]);
      if (file === 'gh') return { stdout: args[1] === 'create' ? 'https://github.com/acme/widgets/pull/9' : '', stderr: '' };
      const r = await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...(o?.cwd !== undefined ? { cwd: o.cwd } : {}) });
      return { stdout: r.stdout, stderr: r.stderr };
    };
    return { repo, origin, calls, exec };
  }
  const card = { status: 'ok', period: '90d', judged: 114, approves: 1, escalates: 113, approvesRight: 1, approvesWrong: 0, approvesPending: 0, barMet: false, threshold: 30, byRiskClass: [{ riskClass: 'general', approveTotal: 1, approveCorrect: 1, streak: 1 }] } as ApproverScorecard;

  test('pushes the branch from a worktree, leaves a dirty checkout untouched, keeps the file formatting', async () => {
    const w = await world();
    await writeFile(join(w.repo, 'README.md'), 'dirty\n');
    await writeFile(join(w.repo, 'scratch.txt'), 'untracked\n');
    const result = await approverCard.openApproverModePr({ repoPath: w.repo, mode: 'act', card, exec: w.exec });
    expect(result).toEqual({ branch: 'vanguard/approver-mode', prUrl: 'https://github.com/acme/widgets/pull/9', mode: 'act' });
    const create = w.calls.find((c) => c[1] === 'pr' && c[2] === 'create')!;
    const body = create[create.indexOf('--body') + 1]!;
    expect(body).toContain('114 pull requests judged');
    expect(body).toContain('The bar is not met');
    expect(w.calls.some((c) => c[1] === 'push' && c.some((a) => a.endsWith(':refs/heads/main') || a === 'main'))).toBe(false);
    // The user's checkout: same branch, dirty file and untracked file still there, no policy change.
    expect((await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: w.repo })).stdout).toBe('main');
    expect(await readFile(join(w.repo, 'README.md'), 'utf8')).toBe('dirty\n');
    expect(await readFile(join(w.repo, 'scratch.txt'), 'utf8')).toBe('untracked\n');
    expect(await readFile(join(w.repo, '.taskcell', 'approver.json'), 'utf8')).not.toContain('"act"');
    expect((await execa('git', ['worktree', 'list', '--porcelain'], { cwd: w.repo })).stdout.match(/^worktree /gm)).toHaveLength(1);
    // The pushed branch carries only a minimal policy edit.
    const pushed = (await execa('git', ['show', 'vanguard/approver-mode:.taskcell/approver.json'], { cwd: w.origin })).stdout;
    expect(JSON.parse(pushed)).toEqual({ schemaVersion: 1, enabled: true, act: true, shape: { maxLines: 5, paths: ['a', 'b'] } });
    expect(pushed).toContain('\n    "enabled": true');
  });

  test('two concurrent changes for one repo run one after the other', async () => {
    const w = await world();
    const events: string[] = [];
    const tagged = (tag: string): typeof w.exec => async (f, a, o) => {
      if (f === 'git' && a[0] === 'worktree' && a[1] === 'add') events.push(`start ${tag}`);
      const r = await w.exec(f, a, o);
      if (f === 'gh' && (a[1] === 'create' || a[1] === 'edit')) {
        await new Promise((res) => setTimeout(res, 30));
        events.push(`end ${tag}`);
      }
      return r;
    };
    await Promise.all([
      approverCard.openApproverModePr({ repoPath: w.repo, mode: 'off', card, exec: tagged('off') }),
      approverCard.openApproverModePr({ repoPath: w.repo, mode: 'act', card, exec: tagged('act') }),
    ]);
    expect(events).toEqual(['start off', 'end off', 'start act', 'end act']);
  });

  test('a reused PR gets the new title', async () => {
    const w = await world();
    const exec: typeof w.exec = async (f, a, o) => (f === 'gh' && a[1] === 'list' ? { stdout: 'https://github.com/acme/widgets/pull/9', stderr: '' } : w.exec(f, a, o));
    const r = await approverCard.openApproverModePr({ repoPath: w.repo, mode: 'off', card, exec });
    expect(r.prUrl).toBe('https://github.com/acme/widgets/pull/9');
    const edit = w.calls.find((c) => c[1] === 'pr' && c[2] === 'edit')!;
    expect(edit[edit.indexOf('--title') + 1]).toBe('chore: set the approver to off mode');
  });
});

describe('policyForMode formatting', () => {
  test('keeps the file indent and line ending; nested keys are untouched', () => {
    const raw = '{\r\n\t"enabled": false,\r\n\t"shape": { "act": true }\r\n}\r\n';
    const out = approverCard.policyForMode(raw, 'act');
    expect(out).toBe('{\r\n\t"enabled": true,\r\n\t"shape": {\r\n\t\t"act": true\r\n\t},\r\n\t"act": true\r\n}\r\n');
  });
  test('a compact file falls back to two spaces and LF', () => {
    expect(approverCard.policyForMode('{"enabled":true}', 'off')).toBe('{\n  "enabled": false,\n  "act": false\n}\n');
  });
  test('invalid JSON throws', () => {
    expect(() => approverCard.policyForMode('{nope', 'off')).toThrow();
  });
});

describe('approverBaseBranch', () => {
  test('without an origin/HEAD it is main; with one it is that branch; an unsafe name is ignored', async () => {
    const repo = await tmpGitRepo();
    expect(await approverCard.approverBaseBranch(repo)).toBe('main');
    const head = (name: string) => async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: name, stderr: '' });
    expect(await approverCard.approverBaseBranch(repo, head('origin/develop'))).toBe('develop');
    expect(await approverCard.approverBaseBranch(repo, head('origin/--upload-pack=x'))).toBe('main');
    expect(await approverCard.approverBaseBranch(repo, head('origin/'))).toBe('main');
  });
});

describe('own-repo reads and switching off', () => {
  test('the scorecard asks gh about the project’s own repo only', async () => {
    const decisions = [line({ prNumber: 1, verdict: 'APPROVE', timestamp: daysAgo(3) }), line({ repo: 'evil/other', prNumber: 2, verdict: 'APPROVE', timestamp: daysAgo(3) })].join('\n');
    mockWorld(decisions, { act: false });
    ghCalls.length = 0;
    const card = await approverCard.approverScorecard(await tmpGitRepo(ORIGIN), '90d', NOW);
    expect(card.judged).toBe(1);
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls.flat().join(' ')).not.toContain('evil/other');
    // PR numbers from another repo do not stand in for this one's.
    const decs = await approverCard.approverPrDecisions(await tmpGitRepo(ORIGIN));
    expect(decs.map((d) => d.prNumber)).toEqual([1]);
  });

  test('the repo match ignores case; decisions for another repo only get a distinct hint', async () => {
    mockWorld(DECISIONS, { act: false });
    const upper = await approverCard.approverScorecard(await tmpGitRepo('https://github.com/ACME/Widgets.git'), '90d', NOW);
    expect(upper.status).toBe('ok');
    const other = await approverCard.approverScorecard(await tmpGitRepo('https://github.com/acme/renamed.git'), '90d', NOW);
    expect(other.status).toBe('no-data');
    expect(other.hint).toMatch(/none for this project/);
  });

  test('turning the approver off works when the scorecard read fails, and the act hold stays', async () => {
    mockWorld(DECISIONS, { act: false });
    vi.spyOn(outcome, 'collectApproverScorecard').mockRejectedValue(new Error('gh: not logged in'));
    const open = vi.spyOn(approverCard, 'openApproverModePr').mockResolvedValue({ branch: 'b', prUrl: 'https://github.com/acme/widgets/pull/9', mode: 'off' });
    const repo = await tmpGitRepo(ORIGIN);
    const { ctx } = await makeCtx(repo);
    await expect(dispatchRpc(ctx, 'read_approver_scorecard', { repoPath: repo })).rejects.toThrow(/not logged in/);
    await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'off' })).resolves.toMatchObject({ mode: 'off' });
    expect(open.mock.calls[0]![0].card.status).toBe('no-data');
    expect(approverCard.ACT_BLOCKING_ISSUES.length).toBeGreaterThan(0);
  });
});
