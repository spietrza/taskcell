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
const gh = async (args: string[]): Promise<string> => (args[0] === 'pr' ? JSON.stringify(prs) : JSON.stringify([[]]));

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
    const repo = await tmpGitRepo();
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
    const repo = await tmpGitRepo();
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
    const card = await approverCard.approverScorecard(await tmpGitRepo(), '90d', NOW);
    expect(overlapped).toBe(false);
    expect(card.status).toBe('ok');
  });

  test('mode comes from the policy: enabled+act is act', async () => {
    mockWorld(DECISIONS, { act: true });
    expect((await approverCard.readApproverMode(await tmpGitRepo())).mode).toBe('act');
  });

  test('per-PR decisions: merged automatically, left with reasons', async () => {
    mockWorld(DECISIONS, { act: false });
    const repo = await tmpGitRepo();
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
      const repo = await tmpGitRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'off' })).resolves.toMatchObject({ prUrl: 'https://github.com/acme/widgets/pull/9' });
      expect(open.mock.calls[0]![0].card).toMatchObject({ judged: 5, approves: 3 });
    });

    test('refuses a non-loopback bind without allow-add and a bad mode', async () => {
      mockWorld(DECISIONS, { act: false });
      const repo = await tmpGitRepo();
      const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'off' })).rejects.toThrow(BadRequestError);
      const { ctx: local } = await makeCtx(repo);
      await expect(dispatchRpc(local, 'set_approver_mode', { repoPath: repo, mode: 'yolo' })).rejects.toThrow(/mode must be/);
    });

    test('act is refused while #939 is open', async () => {
      mockWorld(DECISIONS, { act: false });
      const open = vi.spyOn(approverCard, 'openApproverModePr');
      const repo = await tmpGitRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'set_approver_mode', { repoPath: repo, mode: 'act', confirmBelowBar: true })).rejects.toThrow(/#939, #944/);
      expect(open).not.toHaveBeenCalled();
    });

    test('below the bar act needs the explicit confirmation; at the bar it does not', async () => {
      mockWorld(DECISIONS, { act: false });
      vi.spyOn(approverCard, 'ACT_BLOCKING_ISSUES', 'get').mockReturnValue([]);
      const open = vi.spyOn(approverCard, 'openApproverModePr').mockResolvedValue({ branch: 'b', prUrl: 'https://github.com/acme/widgets/pull/9', mode: 'act' });
      const repo = await tmpGitRepo();
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
  test('commits the policy change on its own branch and the PR body states the scorecard numbers', async () => {
    const repo = await tmpGitRepo();
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push([file, ...args]);
      const out = args[0] === 'show' ? JSON.stringify({ schemaVersion: 1, enabled: true, act: false }) : args[0] === 'rev-parse' ? 'main' : args[0] === 'pr' && args[1] === 'create' ? 'https://github.com/acme/widgets/pull/9' : '';
      return { stdout: out, stderr: '' };
    };
    const card = { status: 'ok', period: '90d', judged: 114, approves: 1, escalates: 113, approvesRight: 1, approvesWrong: 0, approvesPending: 0, barMet: false, threshold: 30, byRiskClass: [{ riskClass: 'general', approveTotal: 1, approveCorrect: 1, streak: 1 }] } as ApproverScorecard;
    const result = await approverCard.openApproverModePr({ repoPath: repo, mode: 'act', card, exec });
    expect(result).toEqual({ branch: 'vanguard/approver-mode', prUrl: 'https://github.com/acme/widgets/pull/9', mode: 'act' });
    const create = calls.find((c) => c[1] === 'pr' && c[2] === 'create')!;
    const body = create[create.indexOf('--body') + 1]!;
    expect(body).toContain('114 pull requests judged');
    expect(body).toContain('The bar is not met');
    expect(calls.some((c) => c[1] === 'push' && c.includes('main'))).toBe(false);
    expect(await import('node:fs/promises').then((fs) => fs.readFile(`${repo}/.taskcell/approver.json`, 'utf8'))).toContain('"act": true');
  });
});
