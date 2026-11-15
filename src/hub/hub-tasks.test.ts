import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MAX_TASKS, createHubTask, editHubTask, listHubBoards, listHubTasks, removeHubTask, updateHubTask, type HubTaskOwner } from './hub-tasks.js';

let dir: string;
const owner: HubTaskOwner = { actor: { login: 'token', admin: true }, caller: { user: { id: 'u', email: 'u@x', name: 'u' }, owner: true } };
const repo = '/srv/repo';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hub-tasks-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const storeFile = async (): Promise<string> => join(dir, 'hub-tasks', (await readdir(join(dir, 'hub-tasks'))).find((n) => n.endsWith('.json'))!);

test('listHubBoards names a board from the head of its store without parsing the tasks', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  const file = await storeFile();
  // A body that is not valid JSON after the head: a full parse would fail and skip the board.
  const head = (await readFile(file, 'utf8')).slice(0, 60);
  await writeFile(file, `${head}\n{ not json`);
  expect(await listHubBoards(dir)).toEqual([repo]);
});

test('listHubBoards still reads a store whose repoPath is not the first key', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  const file = await storeFile();
  await writeFile(file, JSON.stringify({ tasks: [], repoPath: repo }));
  expect(await listHubBoards(dir)).toEqual([repo]);
});

test('deleting a task frees the board at MAX_TASKS without rewriting the store', async () => {
  const big = 'x'.repeat(1000);
  for (let i = 0; i < MAX_TASKS; i++) await createHubTask(dir, repo, { title: `t${i}`, body: i < 3 ? big : '', owner });
  await expect(createHubTask(dir, repo, { title: 'one more', owner })).rejects.toThrow(/already holds/);
  const file = await storeFile();
  const before = (await stat(file)).size;
  // Not done yet: only done tasks are archived.
  await expect(removeHubTask(dir, repo, 'hub-1', 'archive')).rejects.toThrow(/only a done task/);
  await removeHubTask(dir, repo, 'hub-2', 'delete');
  expect((await stat(file)).size).toBe(before); // one edit appends to the journal
  expect(await listHubTasks(dir, repo)).toHaveLength(MAX_TASKS - 1);
  expect((await createHubTask(dir, repo, { title: 'fits now', owner })).id).toBe(`hub-${MAX_TASKS + 1}`); // the freed id is not reused
});

test('archive appends a done task to the archive file and drops it from its dependents', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  await createHubTask(dir, repo, { title: 'B', blockedBy: ['hub-1'], owner });
  await expect(removeHubTask(dir, repo, 'hub-1', 'delete')).rejects.toThrow(/blocked by hub-1/);
  await editHubTask(dir, repo, 'hub-1', (t) => { t.status = 'done'; });
  await removeHubTask(dir, repo, 'hub-1', 'archive');
  expect((await listHubTasks(dir, repo)).map((t) => [t.id, t.blockedBy])).toEqual([['hub-2', []]]);
  const archive = (await readdir(join(dir, 'hub-tasks'))).find((n) => n.endsWith('.archive.jsonl'))!;
  expect(JSON.parse((await readFile(join(dir, 'hub-tasks', archive), 'utf8')).trim())).toMatchObject({ id: 'hub-1', status: 'done' });
  expect(await listHubBoards(dir)).toEqual([repo]); // the archive file is not a board
});

test('a running task cannot be removed; createHubTask and updateHubTask reject instead of throwing', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  await editHubTask(dir, repo, 'hub-1', (t) => { t.status = 'running'; });
  await expect(removeHubTask(dir, repo, 'hub-1', 'delete')).rejects.toThrow(/running/);
  await expect(createHubTask(dir, repo, { title: 'B', startDate: 'soon', owner })).rejects.toThrow(/startDate/);
  await expect(updateHubTask(dir, repo, 'hub-1', { startDate: 'soon' })).rejects.toThrow(/startDate/);
});

test('an edit appends one journal line instead of rewriting a large store; the journal is folded in once it outgrows the store', async () => {
  const body = 'x'.repeat(60 * 1024);
  for (let i = 0; i < 4; i++) await createHubTask(dir, repo, { title: `t${i}`, body, owner });
  const file = await storeFile();
  const journal = file.replace(/\.json$/, '.journal.jsonl');
  const before = await readFile(file, 'utf8');
  const lines = (await readFile(journal, 'utf8')).split('\n').length;
  await updateHubTask(dir, repo, 'hub-1', { startDate: '2999-01-01' });
  expect(await readFile(file, 'utf8')).toBe(before);
  expect((await readFile(journal, 'utf8')).split('\n')).toHaveLength(lines + 1);
  expect((await listHubTasks(dir, repo))[0]).toMatchObject({ id: 'hub-1', startDate: '2999-01-01' });
  // Edits append until the journal would outgrow the store; that edit writes the store whole and drops the journal.
  let edits = 0;
  while ((await readFile(file, 'utf8')) === before) {
    await editHubTask(dir, repo, 'hub-3', (t) => { t.title = 'renamed'; t.body = `${body}${edits}`; });
    edits++;
  }
  expect(edits).toBeGreaterThan(1);
  await expect(stat(journal)).rejects.toThrow();
  expect((await listHubTasks(dir, repo)).map((t) => t.title)).toEqual(['t0', 't1', 'renamed', 't3']);
  expect(await listHubBoards(dir)).toEqual([repo]); // the journal is not a board
});

test('a journal line cut short by a crash is dropped, and the next edit rewrites the store', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  await createHubTask(dir, repo, { title: 'B', owner });
  const file = await storeFile();
  const journal = file.replace(/\.json$/, '.journal.jsonl');
  await writeFile(journal, (await readFile(journal, 'utf8')) + '{"set":{"id":"hub-1"');
  expect((await listHubTasks(dir, repo)).map((t) => t.id)).toEqual(['hub-1', 'hub-2']);
  await editHubTask(dir, repo, 'hub-1', (t) => { t.title = 'A2'; });
  await expect(stat(journal)).rejects.toThrow();
  expect((await listHubTasks(dir, repo)).map((t) => t.title)).toEqual(['A2', 'B']);
});

test('a journal line that is neither a task nor a removal makes the store unreadable, and nothing overwrites it', async () => {
  await createHubTask(dir, repo, { title: 'A', owner });
  const journal = (await storeFile()).replace(/\.json$/, '.journal.jsonl');
  await writeFile(journal, '{"set":{"id":"nope"}}\n');
  await expect(listHubTasks(dir, repo)).rejects.toThrow(/journal .* unreadable/);
  await expect(editHubTask(dir, repo, 'hub-1', (t) => { t.title = 'B'; })).rejects.toThrow(/unreadable/);
  expect(await readFile(journal, 'utf8')).toBe('{"set":{"id":"nope"}}\n');
});
