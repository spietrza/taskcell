import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHubTask, listHubTasks, type HubTaskOwner } from './hub-tasks.js';
import { INCOMPLETE_REASON, ended, schedulerState, scheduleTick } from './task-scheduler.js';

let dir: string;
const repo = '/srv/repo';
const owner: HubTaskOwner = { actor: { login: 'token', admin: true }, caller: { user: { id: 'u', email: 'u@x', name: 'u' }, owner: true } };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hub-sched-')); });
afterEach(async () => {
  await chmod(join(dir, 'hub-tasks'), 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

test('a run whose end could not be stored keeps its real result: the next tick writes it, not "ended with the hub process"', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  const state = schedulerState();
  let end!: (r: { branch: string }) => void;
  const start = (_t: unknown, admitted: (id: string) => void): Promise<{ branch: string }> => new Promise((r) => { admitted('run-1'); end = r; });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await scheduleTick(state, dir, repo, start as never, { limit: 1 });
  // Neither the store nor its journal can be written now.
  for (const name of await readdir(join(dir, 'hub-tasks'))) await chmod(join(dir, 'hub-tasks', name), 0o400);
  await chmod(join(dir, 'hub-tasks'), 0o500);
  end({ branch: 'chore/a' });
  await vi.waitFor(() => expect(state.pending.size).toBe(1));
  await chmod(join(dir, 'hub-tasks'), 0o700);
  for (const name of await readdir(join(dir, 'hub-tasks'))) await chmod(join(dir, 'hub-tasks', name), 0o600);
  await scheduleTick(state, dir, repo, start as never, { limit: 1 });
  expect(await listHubTasks(dir, repo)).toMatchObject([{ status: 'done', result: 'branch chore/a' }]);
  expect(state.pending.size).toBe(0);
  expect(state.live.size).toBe(0);
});

test('a run whose agent stopped before finishing fails its task, even when it delivered a branch', async () => {
  expect(ended({ branch: 'chore/a', implementerIncomplete: true })).toEqual({ status: 'failed', reason: INCOMPLETE_REASON, result: 'branch chore/a' });
  expect(ended({ implementerIncomplete: true })).toEqual({ status: 'failed', reason: INCOMPLETE_REASON });
  expect(ended({ branch: 'chore/a' })).toEqual({ status: 'done', result: 'branch chore/a' });
});

test('a finished run clears the reason an earlier end left on the task', async () => {
  const { editHubTask } = await import('./hub-tasks.js');
  const t = await createHubTask(dir, repo, { title: 'A', owner });
  await editHubTask(dir, repo, t.id, (x) => { x.status = 'failed'; x.reason = 'its run ended with the hub process'; });
  await editHubTask(dir, repo, t.id, (x) => { x.status = 'todo'; });
  const state = schedulerState();
  let end!: (r: { branch: string }) => void;
  const start = (_t: unknown, admitted: (id: string) => void): Promise<{ branch: string }> => new Promise((r) => { admitted('run-1'); end = r; });
  await scheduleTick(state, dir, repo, start as never, { limit: 1 });
  end({ branch: 'chore/a' });
  await vi.waitFor(() => expect(state.live.size).toBe(0));
  const [task] = await listHubTasks(dir, repo);
  expect(task).toMatchObject({ status: 'done', result: 'branch chore/a' });
  expect(task!.reason).toBeUndefined();
});
