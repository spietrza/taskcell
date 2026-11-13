import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { appendBranchLines, readBranchMetrics } from '../core/metrics-branch.js';
import { aggregateMetrics, parseMetrics } from '../core/stats.js';
import { clearCiMetricsCache, costBreakdown, withCiRuns, NO_BRANCH_HINT } from './ci-metrics.js';
import * as projects from './projects.js';
import type { RunSummary } from '../wire.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const line = (o: Record<string, unknown>): string => JSON.stringify({ evt: 'run_complete', exitReason: 'completed', ...o });
const FIXTURE = [
  line({ ts: '2026-11-12T10:00:00.000Z', taskId: 'T-1', stage: 'planner', model: 'claude-opus-5-5', costUsd: 0.5, prUrl: 'https://github.com/o/r/pull/1' }),
  line({ ts: '2026-11-12T10:05:00.000Z', taskId: 'T-1', stage: 'implementer', model: 'claude-sonnet-5-5', costUsd: 1.25, prUrl: 'https://github.com/o/r/pull/1' }),
  line({ ts: '2026-11-01T10:00:00.000Z', taskId: 'T-2', stage: 'implementer', model: 'claude-sonnet-5-5', costUsd: 2, exitReason: 'error' }),
  line({ ts: '2026-09-01T10:00:00.000Z', taskId: 'T-3', stage: 'implementer', model: 'claude-sonnet-5-5', costUsd: 4 }),
  line({ ts: '2026-11-12T11:00:00.000Z', taskId: 'T-4', stage: 'implementer', model: 'claude-haiku-5-5' }),
];

let root: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa('git', ['-C', cwd, ...args]);
}

beforeEach(async () => {
  clearCiMetricsCache();
  root = await mkdtemp(join(tmpdir(), 'vg-ci-metrics-'));
  const origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  repo = join(root, 'repo');
  await execa('git', ['init', '--quiet', '-b', 'main', repo]);
  await git(repo, 'remote', 'add', 'origin', origin);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const push = (lines: string[]): Promise<unknown> => appendBranchLines(repo, lines, { file: 'metrics.jsonl' });

describe('costBreakdown', () => {
  it('a repo without a metrics branch is a plain state with the setup hint, not an error', async () => {
    const b = await costBreakdown(repo, 'all', NOW);
    expect(b).toMatchObject({ status: 'no-branch', hint: NO_BRANCH_HINT, runs: 0, byModel: [] });
    expect(b.hint).toContain('taskcell metrics push');
  });

  it('by model and by stage match `taskcell stats --branch` for the same data', async () => {
    await push(FIXTURE);
    const b = await costBreakdown(repo, 'all', NOW);
    const stats = aggregateMetrics(parseMetrics(await readBranchMetrics(repo)));
    expect(b.byModel.map(({ key, entries, costUsd }) => ({ key, entries, costUsd }))).toEqual(stats.byModel.map(({ key, entries, costUsd }) => ({ key, entries, costUsd })));
    expect(b.byStage.map(({ key, costUsd }) => ({ key, costUsd }))).toEqual(stats.byStage.map(({ key, costUsd }) => ({ key, costUsd })));
    expect(b.totalCostUsd).toBe(stats.total.costUsd);
    expect(b.totalCostUsd).toBe(7.75);
    expect(b.runs).toBe(4);
  });

  it('limits to the last 7 / 30 days', async () => {
    await push(FIXTURE);
    expect((await costBreakdown(repo, '7d', NOW)).totalCostUsd).toBe(1.75);
    expect((await costBreakdown(repo, '30d', NOW)).totalCostUsd).toBe(3.75);
    expect((await costBreakdown(repo, '30d', NOW)).byModel.map((r) => r.key).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('a record without cost data is unknown, not $0', async () => {
    await push(FIXTURE);
    const b = await costBreakdown(repo, 'all', NOW);
    expect(b.unknownEntries).toBe(1);
    expect(b.byModel.find((r) => r.key === 'claude-haiku-5-5')).toMatchObject({ entries: 1, unknownEntries: 1 });
    expect(b.byModel.find((r) => r.key === 'claude-sonnet-5-5')?.unknownEntries).toBe(0);
    const only = await costBreakdown(repo, '7d', NOW);
    expect(only.costKind).toBe('estimated');
  });

  it('says whether the number is estimated, billed, mixed or unknown', async () => {
    const kind = async (lines: string[]): Promise<string> => {
      clearCiMetricsCache();
      await push(lines);
      return (await costBreakdown(repo, 'all', NOW)).costKind;
    };
    expect(await kind([line({ ts: '2026-11-12T10:00:00.000Z', taskId: 'A', costUsd: 1 })])).toBe('estimated');
    expect(await kind([line({ ts: '2026-11-12T10:01:00.000Z', taskId: 'B', costUsd: 1, costKind: 'billed' })])).toBe('mixed');
  });

  it('reads the stamps Taskcell writes: costUnknown (costUsd 0) is unknown, costKind estimated; an unstamped $0 line is unknown', async () => {
    await push([
      line({ ts: '2026-11-12T10:00:00.000Z', taskId: 'A', model: 'gpt-5', costUsd: 0, costUnknown: true }),
      line({ ts: '2026-11-12T10:01:00.000Z', taskId: 'B', model: 'claude-sonnet-5-5', costUsd: 0.4, costKind: 'estimated' }),
      line({ ts: '2026-11-12T10:02:00.000Z', taskId: 'C', model: 'gpt-5', costUsd: 0 }),
    ]);
    const b = await costBreakdown(repo, 'all', NOW);
    expect(b).toMatchObject({ costKind: 'estimated', unknownEntries: 2 });
    expect(b.byModel.find((r) => r.key === 'gpt-5')).toMatchObject({ entries: 2, unknownEntries: 2 });
    const runs = await withCiRuns(repo, []);
    expect(runs.find((r) => r.taskId === 'A')?.costUnknown).toBe(true);
    expect(runs.find((r) => r.taskId === 'C')?.costUnknown).toBe(true);
    expect(runs.find((r) => r.taskId === 'B')?.costUnknown).toBeUndefined();
  });

  it('only unpriced records: costKind is unknown', async () => {
    await push([line({ ts: '2026-11-12T10:00:00.000Z', taskId: 'A' })]);
    expect((await costBreakdown(repo, 'all', NOW)).costKind).toBe('unknown');
  });
});

describe('withCiRuns / projects.aggregate', () => {
  const local = (taskId: string, cost: number): RunSummary => ({ taskId, timestamp: '2026-11-12T09:00:00.000Z', stages: ['implementer'], totalCostUsd: cost, anyFailed: false });

  it('lists CI runs marked as CI, linked to the PR, newest first; unpriced ones flagged unknown', async () => {
    await push(FIXTURE);
    const runs = await withCiRuns(repo, []);
    expect(runs.map((r) => r.taskId)).toEqual(['T-4', 'T-1', 'T-2', 'T-3']);
    expect(runs.every((r) => r.source === 'ci')).toBe(true);
    expect(runs.find((r) => r.taskId === 'T-1')).toMatchObject({ prUrl: 'https://github.com/o/r/pull/1', totalCostUsd: 1.75, stages: ['planner', 'implementer'], anyFailed: false });
    expect(runs.find((r) => r.taskId === 'T-2')?.anyFailed).toBe(true);
    expect(runs.find((r) => r.taskId === 'T-4')?.costUnknown).toBe(true);
    expect(runs.find((r) => r.taskId === 'T-1')?.costUnknown).toBeUndefined();
  });

  it('drops a prUrl that is not https (the same link gate as local records)', async () => {
    await push([
      line({ ts: '2026-11-12T10:00:00.000Z', taskId: 'X', costUsd: 1, prUrl: 'javascript:alert(1)' }),
      line({ ts: '2026-11-12T10:00:00.000Z', taskId: 'Y', costUsd: 1, prUrl: 'http://github.com/o/r/pull/2' }),
    ]);
    const runs = await withCiRuns(repo, []);
    expect(runs.every((r) => r.prUrl === undefined)).toBe(true);
  });

  it('a run present both locally and on the branch is counted once (the local record wins)', async () => {
    await push(FIXTURE);
    const runs = await withCiRuns(repo, [local('T-1', 1.75)]);
    expect(runs.filter((r) => r.taskId === 'T-1')).toEqual([local('T-1', 1.75)]);
    expect(runs).toHaveLength(4);
  });

  it('without a branch the local runs are returned untouched', async () => {
    const l = [local('T-9', 1)];
    expect(await withCiRuns(repo, l)).toBe(l);
  });

  it('a project whose runs exist only on the branch shows a non-zero spend', async () => {
    await push(FIXTURE);
    await mkdir(join(root, 'cfg'), { recursive: true });
    await writeFile(join(root, 'cfg', 'projects.json'), JSON.stringify([repo]));
    const [p] = await projects.list(join(root, 'cfg'));
    expect(p).toMatchObject({ runCount: 4, ciRunCount: 4, taskCount: 4, totalCostUsd: 7.75, failedCount: 1 });
  });
});
