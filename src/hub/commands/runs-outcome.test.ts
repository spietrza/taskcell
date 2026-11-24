import { beforeEach, expect, test } from 'vitest';
import { beginRun } from '../../core/run-store.js';
import type { RunResult } from '../../core/types.js';
import type { RunDetail, RunSummary } from '../../wire.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

let repo: string;
beforeEach(async () => { repo = await tmpRepo(); });

test('a run page and its Runs row show the same outcome for a completed run with no changes', async () => {
  const timestamp = '2026-06-06T10:00:00.000Z';
  const result: RunResult = { taskId: 'hub-1', completed: true, noChanges: true, exitReason: 'completed', turns: 1, worktreePath: '/missing', worktreePreserved: false, finalText: 'Nothing to change.' } as RunResult;
  await beginRun(repo, 'hub-1', timestamp).writeStages([{ name: 'implementer', result }]);
  const { ctx } = await makeCtx(repo, {});
  const rows = (await dispatchRpc(ctx, 'list_runs', { repoPath: repo })) as RunSummary[];
  const detail = (await dispatchRpc(ctx, 'read_run', { repoPath: repo, taskId: 'hub-1', timestamp, source: { kind: 'local' } })) as RunDetail;
  expect(rows[0]!.outcome).toEqual({ state: 'Waiting for your answer', place: { at: 2, failed: false } });
  expect(detail.outcome).toEqual(rows[0]!.outcome);
});
