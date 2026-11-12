import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/metrics-branch.js', () => ({ readBranchFile: vi.fn(), readBranchMetrics: vi.fn(), METRICS_BRANCH_DEFAULT: 'taskcell-metrics' }));
vi.mock('../approver/outcome.js', () => ({ collectApproverScorecard: vi.fn() }));

import { readBranchFile } from '../core/metrics-branch.js';
import { collectApproverScorecard } from '../approver/outcome.js';
import { parseCli } from './args.js';
import { statsCommand } from './stats.js';
import type { Command } from './args.js';
import type { ApproverScorecardReport } from '../approver/scorecard.js';

async function runCli(argv: string[]): Promise<void> {
  const command: Command = parseCli(argv, '/work');
  if (command.kind !== 'stats') throw new Error(`expected a stats command, got ${command.kind}`);
  await statsCommand(command);
}

function fakeReport(): ApproverScorecardReport {
  return {
    rows: [
      { repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], riskClasses: ['general'], humanOutcome: 'merged-as-is', decisionHeadSha: 'h1', timestamp: '2026-01-01T00:00:00.000Z' },
    ],
    byRiskClass: [
      { riskClass: 'general', approveTotal: 1, approveCorrect: 1, escalateTotal: 0, escalateMergedUnchanged: 0, streak: 1 },
    ],
    autoMergeStreakThreshold: 30,
  };
}

let logs: string[];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readBranchFile).mockReset();
  vi.mocked(collectApproverScorecard).mockReset();
});

describe('stats --approver', () => {
  it('reports when the branch has no decisions yet, without calling the scorecard collector', async () => {
    vi.mocked(readBranchFile).mockResolvedValue('');
    await runCli(['stats', '--approver']);
    expect(logs.join('\n')).toContain('No approver decisions');
    expect(collectApproverScorecard).not.toHaveBeenCalled();
  });

  it('parses decisions.jsonl off the metrics branch, builds the scorecard, and prints the text report', async () => {
    const line = JSON.stringify({ repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], headSha: 'h1', timestamp: '2026-01-01T00:00:00.000Z' });
    vi.mocked(readBranchFile).mockResolvedValue(`${line}\n`);
    vi.mocked(collectApproverScorecard).mockResolvedValue(fakeReport());

    await runCli(['stats', '--approver']);

    expect(collectApproverScorecard).toHaveBeenCalledWith([
      { repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], headSha: 'h1', timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    const output = logs.join('\n');
    expect(output).toContain('o/r#1');
    expect(output).toContain('general');
  });

  it('prints the raw report as JSON with --json', async () => {
    const line = JSON.stringify({ repo: 'o/r', prNumber: 1, verdict: 'APPROVE', rulesFired: [], headSha: 'h1', timestamp: '2026-01-01T00:00:00.000Z' });
    vi.mocked(readBranchFile).mockResolvedValue(`${line}\n`);
    vi.mocked(collectApproverScorecard).mockResolvedValue(fakeReport());

    await runCli(['stats', '--approver', '--json']);

    expect(JSON.parse(logs.join(''))).toEqual(fakeReport());
  });

  it('reads decisions.jsonl from the --branch override', async () => {
    vi.mocked(readBranchFile).mockResolvedValue('');
    await runCli(['stats', '--approver', '--branch', 'custom-metrics']);
    expect(readBranchFile).toHaveBeenCalledWith('/work', expect.objectContaining({ branch: 'custom-metrics' }));
  });
});
