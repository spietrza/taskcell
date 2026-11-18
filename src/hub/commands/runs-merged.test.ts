import { expect, test, vi } from 'vitest';
import type { RunSummary } from '../../wire.js';
import { markMerged } from './runs.js';

const run = (taskId: string, prUrl?: string): RunSummary => ({ taskId, timestamp: 't', stages: [], totalCostUsd: 0, anyFailed: false, ...(prUrl ? { prUrl } : {}) });
const depsWith = (tasks: { id: string; column: string }[] | Error): Parameters<typeof markMerged>[0] =>
  ({ listTasks: vi.fn(async () => { if (tasks instanceof Error) throw tasks; return { tasks, capped: false }; }) }) as never;

test('a run whose card is done is marked merged; others and failures are left alone', async () => {
  const runs = [run('gh-1', 'u'), run('gh-2', 'u'), run('gh-3')];
  const out = await markMerged(depsWith([{ id: 'gh-1', column: 'done' }, { id: 'gh-2', column: 'review' }, { id: 'gh-3', column: 'done' }]), '/r1', runs);
  expect(out.map((r) => r.prState)).toEqual(['merged', undefined, undefined]);
  expect(out[2]!.cardDone).toBe(true);
  expect(await markMerged(depsWith(new Error('down')), '/r2', runs)).toEqual(runs);
});

test('a passed run whose card is done without a PR is marked cardDone; a hub board is read by its own reader', async () => {
  const runs = [run('hub-1'), { ...run('hub-2'), anyFailed: true }];
  const out = await markMerged(depsWith(new Error('core not used')), '/r3', runs, async () => [{ id: 'hub-1', column: 'done' }, { id: 'hub-2', column: 'done' }]);
  expect(out.map((r) => [r.prState, r.cardDone])).toEqual([[undefined, true], [undefined, undefined]]);
});

test('an asked run whose card is done no longer waits for an answer', async () => {
  const runs = [{ ...run('hub-4'), anyFailed: true, asked: 'Which file?' }, { ...run('hub-5'), anyFailed: true, asked: 'Which file?' }];
  const out = await markMerged(depsWith(new Error('core not used')), '/r4', runs, async () => [{ id: 'hub-4', column: 'done' }, { id: 'hub-5', column: 'verify-failed' }]);
  expect(out.map((r) => [r.asked, r.cardDone])).toEqual([['Which file?', true], ['Which file?', undefined]]);
});
