import { beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ listTasksAll: vi.fn(), listRunsAll: vi.fn() }));
vi.mock('./ipc', () => ipc);

import { clearPalette, loadPalette, paletteItems, publishCards } from './paletteIndex';

const run = { taskId: 'hub-1', timestamp: '2026-11-17T10:00:00Z', stages: [], totalCostUsd: 0, anyFailed: false, repoPath: '/r/a', repoName: 'a' };
beforeEach(() => {
  clearPalette();
  ipc.listTasksAll.mockResolvedValue({ tasks: [{ id: 'hub-1', title: 'A', column: 'queued', state: '', repoPath: '/r/a', repoName: 'a' }], capped: false, failures: [] });
  ipc.listRunsAll.mockResolvedValue({ runs: [run], failures: [] });
});

test('one load reads every card and run of the team', async () => {
  await loadPalette('t1');
  expect(ipc.listTasksAll).toHaveBeenCalledWith('t1');
  expect(paletteItems()).toEqual({ cards: [{ id: 'hub-1', title: 'A', repoPath: '/r/a' }], runs: [run] });
});

test('a team switch or sign-out clears the lists, and a read started before it never publishes', async () => {
  publishCards([{ id: 'hub-9', title: 'Old team', repoPath: '/r/old' }]);
  const pending = loadPalette('old');
  clearPalette();
  await pending;
  expect(paletteItems()).toEqual({ cards: [], runs: [] });
});

test('a failed read keeps what is there', async () => {
  publishCards([{ id: 'hub-2', title: 'B', repoPath: '/r/a' }]);
  ipc.listTasksAll.mockRejectedValue(new Error('down'));
  await loadPalette();
  expect(paletteItems().cards).toEqual([{ id: 'hub-2', title: 'B', repoPath: '/r/a' }]);
  expect(paletteItems().runs).toEqual([run]);
});
