import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHubTask, editHubTask, listHubBoards, listHubTasks, readHubTasks, resetStaleRunning, updateHubTask, type HubTask, type HubTaskOwner } from './hub-tasks.js';
import { listHubBoard } from './hub-board.js';
import { scheduleTick as tick, schedulerState, type StartTask } from './task-scheduler.js';
import { OWNER } from './test-kit.js';
import type { CreateRunResult } from '../sidecar/sidecar.js';

const owner: HubTaskOwner = { actor: { login: 'token', admin: true }, caller: OWNER };
const repo = '/repos/app';
let cfg: string;
let scheduleTick: (configDir: string, repoPath: string, start: StartTask, opts: { limit: number; now?: Date }) => Promise<string[]>;
beforeEach(async () => {
  cfg = await mkdtemp(join(tmpdir(), 'hubtasks-'));
  const state = schedulerState();
  scheduleTick = (...args) => tick(state, ...args);
});
afterEach(async () => { await rm(cfg, { recursive: true, force: true }); });

const add = (title: string, body?: string): Promise<HubTask> => createHubTask(cfg, repo, { title, owner, ...(body !== undefined ? { body } : {}) });
const statuses = async (): Promise<string[]> => (await listHubTasks(cfg, repo)).map((t) => t.status);
const storeFile = async (): Promise<string> => join(cfg, 'hub-tasks', (await readdir(join(cfg, 'hub-tasks')))[0]!);
/** A start the test settles by hand; the session "takes" the run at once. */
function manualStart(): { start: StartTask; started: string[]; settle: Array<{ ok: (r?: CreateRunResult) => void; fail: (e: Error) => void }> } {
  const started: string[] = [];
  const settle: Array<{ ok: (r?: CreateRunResult) => void; fail: (e: Error) => void }> = [];
  const start: StartTask = (task, admitted) => {
    started.push(task.id);
    admitted(`run-${started.length}`);
    return new Promise((ok, fail) => settle.push({ ok: (r = { prUrl: 'https://pr/1' }) => ok(r), fail }));
  };
  return { start, started, settle };
}

test('dependencies and start date are stored and refused when malformed', async () => {
  const a = await add('A');
  const b = await add('B');
  expect([a.id, b.id]).toEqual(['hub-1', 'hub-2']);
  await updateHubTask(cfg, repo, b.id, { blockedBy: ['hub-1', 'hub-1'], startDate: '2099-01-01' });
  expect((await listHubTasks(cfg, repo))[1]).toMatchObject({ blockedBy: ['hub-1'], startDate: '2099-01-01', owner });
  await expect(updateHubTask(cfg, repo, b.id, { startDate: 'tomorrow' })).rejects.toThrow(/startDate/);
  await expect(updateHubTask(cfg, repo, b.id, { startDate: '2026-02-31T00:00:00Z' })).rejects.toThrow(/startDate/);
  await expect(updateHubTask(cfg, repo, 'nope', {})).rejects.toThrow(/no hub task/);
  await updateHubTask(cfg, repo, b.id, { startDate: null });
  expect((await listHubTasks(cfg, repo))[1]?.startDate).toBeUndefined();
});

test('the store is the hub\'s own file: private, and one per repository path', async () => {
  await add('A');
  await createHubTask(cfg, '/repos/other', { title: 'X', owner });
  expect((await listHubBoards(cfg)).sort()).toEqual([repo, '/repos/other']);
  expect((await readdir(join(cfg, 'hub-tasks'))).every((n) => n.endsWith('.json'))).toBe(true); // no temp file left
});

test('an unreadable store fails loudly and is never overwritten; invalid entries are kept and shown', async () => {
  await add('A');
  const file = await storeFile();
  await writeFile(file, '{ "tasks": [ oops');
  await expect(add('B')).rejects.toThrow(/unreadable/);
  await expect(listHubBoard(cfg, repo)).rejects.toThrow(/unreadable/);
  expect(await readFile(file, 'utf8')).toBe('{ "tasks": [ oops');

  const bad = { id: 'hub-2', title: 'B', body: '', status: 'Todo', blockedBy: [] };
  await writeFile(file, JSON.stringify({ repoPath: repo, tasks: [{ id: 'hub-1', title: 'A', body: '', status: 'todo', blockedBy: [] }, bad] }));
  expect(await readHubTasks(cfg, repo)).toMatchObject({ tasks: [{ id: 'hub-1' }], invalid: 1 });
  const badSkills = { id: 'hub-4', title: 'D', body: '', status: 'todo', blockedBy: [], skills: [1] };
  await writeFile(file, JSON.stringify({ repoPath: repo, tasks: [{ id: 'hub-1', title: 'A', body: '', status: 'todo', blockedBy: [] }, bad, badSkills] }));
  expect(await readHubTasks(cfg, repo)).toMatchObject({ invalid: 2 }); // a non-string skill id makes the entry invalid
  await writeFile(file, JSON.stringify({ repoPath: repo, tasks: [{ id: 'hub-1', title: 'A', body: '', status: 'todo', blockedBy: [] }, bad] }));
  expect((await add('C')).id).toBe('hub-3'); // the invalid entry's id is not reused
  expect((JSON.parse(await readFile(file, 'utf8')) as { tasks: unknown[] }).tasks).toContainEqual(bad);
  expect((await listHubBoard(cfg, repo)).tasks.at(-1)).toMatchObject({ schedule: { state: 'invalid', reason: expect.stringContaining('1 entry') } });
});

test('a malformed long id in an invalid entry does not break numbering; running out of ids is refused', async () => {
  await add('A');
  const file = await storeFile();
  const a = { id: 'hub-1', title: 'A', body: '', status: 'todo', blockedBy: [] };
  await writeFile(file, JSON.stringify({ repoPath: repo, tasks: [a, { id: 'hub-12345678901', title: 'X', status: 'todo' }] }));
  expect((await add('B')).id).toBe('hub-2');
  expect((await readHubTasks(cfg, repo)).tasks.map((t) => t.id)).toEqual(['hub-1', 'hub-2']);
  await writeFile(file, JSON.stringify({ repoPath: repo, tasks: [{ ...a, id: 'hub-999999999' }] }));
  await expect(add('C')).rejects.toThrow(/out of task ids/);
});

test('a symlink in place of the store is refused, and a write never goes through it', async () => {
  const target = join(cfg, 'outside.json');
  await writeFile(target, 'untouched');
  await mkdir(join(cfg, 'hub-tasks'));
  await add('A').then(async () => {
    const file = await storeFile();
    await rm(file);
    await symlink(target, file);
  });
  await expect(add('B')).rejects.toThrow(/symlink/);
  expect(await readFile(target, 'utf8')).toBe('untouched');
});

test('the board renders blocked, waiting, queued, failed and invalid cards with reasons', async () => {
  const [a, b, c, d] = [await add('A'), await add('B'), await add('C'), await add('D')];
  await updateHubTask(cfg, repo, b.id, { blockedBy: [a.id] });
  await updateHubTask(cfg, repo, c.id, { startDate: '2099-01-01T00:00:00Z' });
  await updateHubTask(cfg, repo, d.id, { blockedBy: ['hub-99'] });
  const board = await listHubBoard(cfg, repo);
  expect(board.hubBoard).toBe(true);
  const by = Object.fromEntries(board.tasks.map((x) => [x.id, x]));
  expect(by['hub-1']).toMatchObject({ column: 'queued', waiting: true, schedule: { state: 'ready' } });
  expect(by['hub-2']).toMatchObject({ blockedBy: ['hub-1'], schedule: { state: 'blocked', label: 'blocked by hub-1' } });
  expect(by['hub-3']?.schedule).toMatchObject({ state: 'waits-date' });
  expect(by['hub-3']?.schedule?.label).toMatch(/^waits until \w{3} \d\d\.\d\d \(.+\)$/);
  expect(by['hub-4']?.schedule).toMatchObject({ state: 'invalid', reason: expect.stringContaining('hub-99') });

  await editHubTask(cfg, repo, a.id, (t) => { t.status = 'running'; t.runId = 'run-7'; });
  expect((await listHubBoard(cfg, repo)).tasks[0]).toMatchObject({ column: 'running', schedule: { state: 'running' } });
  // The run session still holds that run in its queue: the card is queued, not running.
  expect((await listHubBoard(cfg, repo, new Map([['run-7', 1]]))).tasks[0]).toMatchObject({ column: 'queued', waiting: true, schedule: { state: 'queued', label: 'queued behind another run (position 1)' } });
  await editHubTask(cfg, repo, a.id, (t) => { t.status = 'failed'; t.reason = 'no credential'; });
  expect((await listHubBoard(cfg, repo)).tasks[0]).toMatchObject({ column: 'verify-failed', schedule: { state: 'failed', reason: 'no credential', label: 'failed: no credential' } });
});

test('the scheduler starts independent tasks up to the limit, then a dependent after its dependency is done', async () => {
  for (const n of ['A', 'B', 'C', 'D']) await add(n);
  await updateHubTask(cfg, repo, 'hub-4', { blockedBy: ['hub-1'] });
  const { start, started, settle } = manualStart();
  expect(await scheduleTick(cfg, repo, start, { limit: 3 })).toEqual(['hub-1', 'hub-2', 'hub-3']);
  expect((await listHubTasks(cfg, repo))[0]).toMatchObject({ status: 'running', runId: 'run-1' });
  expect(await scheduleTick(cfg, repo, start, { limit: 3 })).toEqual([]); // no slot, and hub-4 is blocked
  settle[0]!.ok(); // hub-1 done
  await vi.waitFor(async () => expect((await listHubTasks(cfg, repo))[0]).toMatchObject({ status: 'done', result: 'https://pr/1' }));
  expect(await scheduleTick(cfg, repo, start, { limit: 3 })).toEqual(['hub-4']);
  expect(started).toEqual(['hub-1', 'hub-2', 'hub-3', 'hub-4']);
  settle.slice(1).forEach((s) => s.ok({ branch: 'chore/x' }));
  await vi.waitFor(async () => expect(await statuses()).toEqual(['done', 'done', 'done', 'done']));
  expect((await listHubTasks(cfg, repo))[1]?.result).toBe('branch chore/x');
});

test('a failed run marks the task failed with its reason and never unblocks its dependents', async () => {
  await add('A');
  await add('B');
  await updateHubTask(cfg, repo, 'hub-2', { blockedBy: ['hub-1'] });
  const { start, settle } = manualStart();
  await scheduleTick(cfg, repo, start, { limit: 2 });
  settle[0]!.fail(new Error('boom'));
  await vi.waitFor(async () => expect(await statuses()).toEqual(['failed', 'todo']));
  expect((await listHubTasks(cfg, repo))[0]).toMatchObject({ reason: 'boom' });
  expect(await scheduleTick(cfg, repo, start, { limit: 2 })).toEqual([]);
});

test('a run that changed nothing, or was held back, is failed with the reason', async () => {
  await add('A');
  const { start, settle } = manualStart();
  await scheduleTick(cfg, repo, start, { limit: 1 });
  settle[0]!.ok({});
  await vi.waitFor(async () => expect((await listHubTasks(cfg, repo))[0]).toMatchObject({ status: 'failed', reason: 'the run made no changes' }));
});

test('a refusal before the run session takes the run leaves the task todo with the reason, and it is tried again', async () => {
  await add('A');
  await add('B');
  const refuse: StartTask = () => Promise.reject(new Error('the run queue is full'));
  expect(await scheduleTick(cfg, repo, refuse, { limit: 2 })).toEqual([]);
  expect(await listHubTasks(cfg, repo)).toMatchObject([{ status: 'todo', reason: 'the run queue is full' }, { status: 'todo', reason: 'the run queue is full' }]);
  expect((await listHubBoard(cfg, repo)).tasks[0]).toMatchObject({ column: 'queued', schedule: { state: 'refused', label: 'not started: the run queue is full' } });
  const { start } = manualStart();
  expect(await scheduleTick(cfg, repo, start, { limit: 2 })).toEqual(['hub-1', 'hub-2']);
  expect((await listHubTasks(cfg, repo))[0]?.reason).toBeUndefined();
});

test('a running task with no live run is failed, not re-run', async () => {
  await add('A');
  await editHubTask(cfg, repo, 'hub-1', (t) => { t.status = 'running'; t.runId = 'run-3'; });
  expect(await resetStaleRunning(cfg, repo)).toEqual(['hub-1']);
  expect((await listHubTasks(cfg, repo))[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('hub process') });
  expect((await listHubTasks(cfg, repo))[0]?.runId).toBeUndefined();
  // The tick does the same for a task this process holds no run for, and does not start it.
  await editHubTask(cfg, repo, 'hub-1', (t) => { t.status = 'running'; });
  expect(await scheduleTick(cfg, repo, manualStart().start, { limit: 1 })).toEqual([]);
  expect((await listHubTasks(cfg, repo))[0]).toMatchObject({ status: 'failed' });
});

test('a future start date is not started even with a free slot', async () => {
  await add('A');
  await updateHubTask(cfg, repo, 'hub-1', { startDate: '2099-01-01' });
  const { start } = manualStart();
  expect(await scheduleTick(cfg, repo, start, { limit: 2 })).toEqual([]);
  expect(await scheduleTick(cfg, repo, start, { limit: 2, now: new Date('2099-01-02T00:00:00Z') })).toEqual(['hub-1']);
});
