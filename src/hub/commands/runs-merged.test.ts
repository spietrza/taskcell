import { expect, test, vi } from 'vitest';
import type { RunSummary } from '../../wire.js';
import { markMerged } from './runs.js';

const run = (taskId: string, prUrl?: string): RunSummary => ({ taskId, timestamp: 't', stages: [], totalCostUsd: 0, anyFailed: false, ...(prUrl ? { prUrl } : {}) });
const depsWith = (tasks: { id: string; column: string }[] | Error): Parameters<typeof markMerged>[0] =>
  ({ listTasks: vi.fn(async () => { if (tasks instanceof Error) throw tasks; return { tasks, capped: false }; }) }) as never;

test('a done card on the board mark the runs (the marking rules: card-view.test.ts); a board that cannot be read leaves them alone', async () => {
  const runs = [run('gh-1', 'u'), run('gh-2', 'u'), run('gh-3')];
  const out = await markMerged(depsWith([{ id: 'gh-1', column: 'done' }, { id: 'gh-2', column: 'review' }, { id: 'gh-3', column: 'done' }]), '/r1', runs);
  expect(out.map((r) => r.prState)).toEqual(['merged', undefined, undefined]);
  expect(out[2]!.cardDone).toBe(true);
  expect(await markMerged(depsWith(new Error('down')), '/r2', runs)).toEqual(runs);
});

test('a hub board is read by its own reader', async () => {
  const out = await markMerged(depsWith(new Error('core not used')), '/r3', [run('hub-1')], async () => [{ id: 'hub-1', column: 'done' }]);
  expect(out[0]!.cardDone).toBe(true);
});
