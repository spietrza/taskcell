import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHubTask, listHubTasks, type HubTaskOwner } from './hub-tasks.js';
import { schedulerState, scheduleTick } from './task-scheduler.js';

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
  await chmod(join(dir, 'hub-tasks'), 0o500); // the store cannot be replaced now
  end({ branch: 'chore/a' });
  await vi.waitFor(() => expect(state.pending.size).toBe(1));
  await chmod(join(dir, 'hub-tasks'), 0o700);
  await scheduleTick(state, dir, repo, start as never, { limit: 1 });
  expect(await listHubTasks(dir, repo)).toMatchObject([{ status: 'done', result: 'branch chore/a' }]);
  expect(state.pending.size).toBe(0);
  expect(state.live.size).toBe(0);
});
