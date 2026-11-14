import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHubTask, listHubTasks, setHubTaskStatus, updateHubTask } from './hub-tasks.js';
import { listHubBoard } from './hub-board.js';
import { scheduleTick } from './task-scheduler.js';

let repo: string;
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'hubtasks-')); });
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50)); // let a finished run's status write land before the directory goes
  await rm(repo, { recursive: true, force: true });
});

test('dependencies and start date are stored and refused when malformed', async () => {
  const a = await createHubTask(repo, 'A');
  const b = await createHubTask(repo, 'B');
  expect([a.id, b.id]).toEqual(['hub-1', 'hub-2']);
  await updateHubTask(repo, b.id, { blockedBy: ['hub-1', 'hub-1'], startDate: '2099-01-01' });
  expect((await listHubTasks(repo))[1]).toMatchObject({ blockedBy: ['hub-1'], startDate: '2099-01-01' });
  await expect(updateHubTask(repo, b.id, { startDate: 'tomorrow' })).rejects.toThrow(/startDate/);
  await expect(updateHubTask(repo, 'nope', {})).rejects.toThrow(/no hub task/);
  await updateHubTask(repo, b.id, { startDate: null });
  expect((await listHubTasks(repo))[1]?.startDate).toBeUndefined();
});

test('the board renders blocked, waiting and invalid cards with reasons', async () => {
  const a = await createHubTask(repo, 'A');
  const b = await createHubTask(repo, 'B');
  const c = await createHubTask(repo, 'C');
  const d = await createHubTask(repo, 'D');
  await updateHubTask(repo, b.id, { blockedBy: [a.id] });
  await updateHubTask(repo, c.id, { startDate: '2099-01-01T00:00:00Z' });
  await updateHubTask(repo, d.id, { blockedBy: ['hub-99'] });
  const { tasks } = await listHubBoard(repo);
  const by = Object.fromEntries(tasks.map((x) => [x.id, x]));
  expect(by['hub-1']).toMatchObject({ column: 'queued', waiting: true, schedule: { state: 'ready' } });
  expect(by['hub-2']).toMatchObject({ blockedBy: ['hub-1'], schedule: { state: 'blocked', label: 'blocked by hub-1' } });
  expect(by['hub-3']?.schedule).toMatchObject({ state: 'waits-date' });
  expect(by['hub-3']?.schedule?.label).toMatch(/^waits until \w{3} \d\d\.\d\d \(.+\)$/);
  expect(by['hub-4']?.schedule).toMatchObject({ state: 'invalid', reason: expect.stringContaining('hub-99') });
  await setHubTaskStatus(repo, a.id, 'running');
  expect((await listHubBoard(repo)).tasks[0]).toMatchObject({ column: 'running' });
});

test('the scheduler starts independent tasks up to the limit, then a dependent after its dependency is done', async () => {
  for (const n of ['A', 'B', 'C', 'D']) await createHubTask(repo, n);
  await updateHubTask(repo, 'hub-4', { blockedBy: ['hub-1'] });
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const start = (task: { id: string }): Promise<void> => { started.push(task.id); return new Promise((r) => releases.push(r)); };
  expect(await scheduleTick(repo, start)).toEqual(['hub-1', 'hub-2', 'hub-3']); // default limit 3, all running at once
  expect(await scheduleTick(repo, start)).toEqual([]); // no slot, and hub-4 is blocked
  releases[0]!(); // hub-1 done
  await new Promise((r) => setTimeout(r, 20));
  expect(await scheduleTick(repo, start)).toEqual(['hub-4']);
  expect(started).toEqual(['hub-1', 'hub-2', 'hub-3', 'hub-4']);
});

test('a failed run marks the task failed and never unblocks its dependents', async () => {
  await createHubTask(repo, 'A');
  await createHubTask(repo, 'B');
  await updateHubTask(repo, 'hub-2', { blockedBy: ['hub-1'] });
  await scheduleTick(repo, () => Promise.reject(new Error('boom')));
  await new Promise((r) => setTimeout(r, 20));
  expect((await listHubTasks(repo)).map((x) => x.status)).toEqual(['failed', 'todo']);
  expect(await scheduleTick(repo, () => Promise.resolve())).toEqual([]);
});

test('a future start date is not started even with a free slot', async () => {
  await createHubTask(repo, 'A');
  await updateHubTask(repo, 'hub-1', { startDate: '2099-01-01' });
  expect(await scheduleTick(repo, () => Promise.resolve())).toEqual([]);
  expect(await scheduleTick(repo, () => Promise.resolve(), new Date('2099-01-02T00:00:00Z'))).toEqual(['hub-1']);
});
