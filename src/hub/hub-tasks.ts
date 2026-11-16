// The hub board's own tasks (project `taskSource: hub`). The store is the hub's, not the repository's: one JSON file
// per project under `<configDir>/hub-tasks/`, plus a journal of the edits since that file was last written, so nothing
// a checkout commits can add a task, change one or redirect a write, and one edit appends a line instead of rewriting a
// large file. Dependencies and the start date are plain fields here; src/hub/schedule.ts decides what may start.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { keyedLock } from '../core/keyed-lock.js';
import type { Actor } from './audit.js';
import type { Caller } from './teams.js';

export type HubTaskStatus = 'todo' | 'running' | 'done' | 'failed';

/** Who a task runs as: the last person to create, schedule or retry it. Their credential funds the run. */
export interface HubTaskOwner {
  actor: Actor;
  caller: Caller;
}

export interface HubTask {
  /** `hub-<n>`. */
  id: string;
  title: string;
  body: string;
  status: HubTaskStatus;
  /** Ids of other tasks of the same project that must be done first. */
  blockedBy: string[];
  /** `2026-11-18` (midnight in the hub's time zone) or an ISO instant; the task does not start before it. */
  startDate?: string;
  owner?: HubTaskOwner;
  /** Hand-picked skill ids (installed ones; checked when set): the task's run loads exactly these. */
  skills?: string[];
  /** `running`: the run session's id for its run. */
  runId?: string;
  /** `failed`: why. `todo`: why its last start was refused. */
  reason?: string;
  /** `done`: the pull request URL, or `branch <name>`. `failed` after a verify failure: the delivered result (accept it, or retry). */
  result?: string;
}

export const HUB_TASK_ID = /^hub-[1-9]\d{0,8}$/;
export const MAX_TITLE_LENGTH = 300;
export const MAX_BODY_LENGTH = 64 * 1024;
export const MAX_BLOCKED_BY = 50;
/** Tasks one project's board holds (archive or delete done tasks to make room). */
export const MAX_TASKS = 1000;

const STATUSES: readonly string[] = ['todo', 'running', 'done', 'failed'];
const storeDir = (configDir: string): string => join(configDir, 'hub-tasks');
/** Archived tasks, one JSON line each, appended: never read by the scheduler and never rewritten (not `.json`, so not a board). */
const archiveFor = (file: string): string => `${file.slice(0, -'.json'.length)}.archive.jsonl`;
/** Edits since the store was last written whole, one JSON line each (not `.json`, so not a board); folded in on read. */
const journalFor = (file: string): string => `${file.slice(0, -'.json'.length)}.journal.jsonl`;
/** The journal is folded into the store once it outgrows the store (and this floor): writes stay small on average. */
const COMPACT_FLOOR = 64 * 1024;
/** One file, and one write lock, per repository path: callers pass the realpath the allowlist resolved. */
const fileFor = (configDir: string, repoPath: string): string => join(storeDir(configDir), `${createHash('sha256').update(repoPath).digest('hex').slice(0, 32)}.json`);

/** The hub's time zone, which a date-only start date is read in. */
export const hubTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `ts`'s offset from UTC in `timeZone`, in ms. */
function zoneOffset(ts: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ts)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ts / 1000) * 1000;
}

/** A start date is `YYYY-MM-DD` (00:00 in the hub's time zone) or a full ISO instant with `Z`/offset; anything else is undefined. */
export function parseStart(value: string, timeZone: string = hubTimeZone()): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) return undefined;
  const day = new Date(value.slice(0, 10));
  // 2026-02-31 rolls over to March: refused for a date and for an instant alike.
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  if (value.length > 10) {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? undefined : at;
  }
  // Midnight local: shift by the zone's offset, once more across a DST change.
  const first = day.getTime() - zoneOffset(day.getTime(), timeZone);
  return new Date(day.getTime() - zoneOffset(first, timeZone));
}

interface Store {
  tasks: HubTask[];
  /** Entries that are not valid tasks (a hand edit): never run, and written back untouched on every save. */
  invalid: unknown[];
  /** The highest task number ever issued, so an id removed from the board is never reused. */
  lastId: number;
  /** Bytes of the store file (undefined: none yet) and of its journal; a torn journal ends in a line cut short by a crash. */
  size: number | undefined;
  journal: number;
  torn: boolean;
  /**
   * A fresh id each time the store is written whole; journal lines carry it, and lines of another id are skipped, so a
   * journal a crash left behind after a full write (its lines already in the store) is never replayed over newer state.
   */
  generation: string | undefined;
}

/** One journal line: a task as it now is, or the id of a task taken off the board. */
type JournalEntry = { set: HubTask } | { remove: string };

function isTask(r: unknown, seen: Set<string>): r is HubTask {
  if (typeof r !== 'object' || r === null) return false;
  const t = r as Record<string, unknown>;
  return typeof t.id === 'string' && HUB_TASK_ID.test(t.id) && !seen.has(t.id)
    && typeof t.title === 'string' && t.title !== '' && typeof t.body === 'string'
    && typeof t.status === 'string' && STATUSES.includes(t.status)
    && Array.isArray(t.blockedBy) && t.blockedBy.every((x) => typeof x === 'string')
    && (t.startDate === undefined || typeof t.startDate === 'string')
    && (t.skills === undefined || (Array.isArray(t.skills) && t.skills.every((x) => typeof x === 'string')));
}

/**
 * Strict read: a missing file is an empty board; a file that exists but cannot be read or parsed throws, so no later
 * save replaces it (the `readAppConfigStrict` rule).
 */
async function readOptional(file: string): Promise<string | undefined> {
  try {
    // O_NOFOLLOW refuses a symlink (ELOOP) in the open itself, so no lstat-then-read race.
    const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // Windows has no O_NOFOLLOW: refuse a link after the open too (a check after the open is no read race).
      if ((await lstat(file)).isSymbolicLink()) throw Object.assign(new Error('symlink'), { code: 'ELOOP' });
      return await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new BadRequestError(`the hub task store ${file} is unreadable: ${code === 'ELOOP' ? 'it is a symlink' : String(e)}`);
  }
}

const idNumber = (id: string): number => Number(id.slice(4));

async function read(file: string): Promise<Store> {
  const raw = await readOptional(file);
  const store: Store = { tasks: [], invalid: [], lastId: 0, size: raw === undefined ? undefined : Buffer.byteLength(raw), journal: 0, torn: false, generation: undefined };
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new BadRequestError(`the hub task store ${file} is unreadable: ${String(e)}`);
    }
    const entries = (parsed as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(entries)) throw new BadRequestError(`the hub task store ${file} is unreadable: it holds no "tasks" list`);
    const lastId = (parsed as { lastId?: unknown }).lastId;
    if (typeof lastId === 'number' && Number.isInteger(lastId) && lastId > 0) store.lastId = lastId;
    const generation = (parsed as { generation?: unknown }).generation;
    if (typeof generation === 'string' && generation !== '') store.generation = generation;
    const seen = new Set<string>();
    for (const r of entries as unknown[]) {
      if (isTask(r, seen)) {
        seen.add(r.id);
        store.tasks.push(r);
      } else store.invalid.push(r);
    }
  }
  const journalFile = journalFor(file);
  const journal = await readOptional(journalFile);
  if (journal === undefined) return store;
  store.journal = Buffer.byteLength(journal);
  const lines = journal.split('\n');
  // The last piece is '' after a complete line; anything else is an append a crash cut short, and is dropped.
  store.torn = lines.pop() !== '';
  for (const line of lines) {
    let e: { of?: unknown; set?: unknown; remove?: unknown } | null;
    try {
      e = JSON.parse(line) as typeof e;
    } catch (err) {
      throw new BadRequestError(`the hub task journal ${journalFile} is unreadable: ${String(err)}`);
    }
    // A line of another generation is already in the store (a crash came between a full write and the journal's removal).
    if (store.generation === undefined || e?.of !== store.generation) continue;
    const set = e?.set;
    const remove = e?.remove;
    let id: string;
    if (isTask(set, new Set())) {
      id = set.id;
      const at = store.tasks.findIndex((t) => t.id === id);
      if (at >= 0) store.tasks[at] = set;
      else store.tasks.push(set);
    } else if (typeof remove === 'string' && HUB_TASK_ID.test(remove)) {
      id = remove;
      store.tasks = store.tasks.filter((t) => t.id !== id);
    } else throw new BadRequestError(`the hub task journal ${journalFile} is unreadable: a line is neither a task nor a removal`);
    store.lastId = Math.max(store.lastId, idNumber(id));
  }
  return store;
}

/** Append without following a link, created 0600 if missing. */
async function appendLines(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const fh = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

async function save(file: string, repoPath: string, store: Store): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // A fresh name created exclusively, then renamed over the file: never a write through an existing file or link.
  const tmp = `${file}.${randomUUID()}.tmp`;
  const generation = randomUUID();
  try {
    await writeFile(tmp, `${JSON.stringify({ repoPath, lastId: store.lastId, generation, tasks: [...store.tasks, ...store.invalid] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  // The store now holds every journal entry; were this removal lost, the new generation keeps them from being replayed.
  await rm(journalFor(file), { force: true });
}

/**
 * Record `entries` (the tasks they touch already changed in `store`): appended to the journal, so an edit writes one
 * line; the whole store is written instead when there is none yet (or it predates generations), the journal ends torn,
 * or it outgrows the store.
 */
async function commit(file: string, repoPath: string, store: Store, entries: readonly JournalEntry[]): Promise<void> {
  const text = entries.map((e) => `${JSON.stringify({ of: store.generation, ...e })}\n`).join('');
  if (store.size === undefined || store.generation === undefined || store.torn || store.journal + Buffer.byteLength(text) > Math.max(COMPACT_FLOOR, store.size)) return save(file, repoPath, store);
  await appendLines(journalFor(file), text);
}

// One write at a time per file: read-modify-write must not interleave (the scheduler and the UI both write).
const lock = keyedLock();

/** The project's tasks, and how many entries of its file are not valid tasks (kept, never run). */
export async function readHubTasks(configDir: string, repoPath: string): Promise<{ tasks: HubTask[]; invalid: number }> {
  const store = await read(fileFor(configDir, repoPath));
  return { tasks: store.tasks, invalid: store.invalid.length };
}

export async function listHubTasks(configDir: string, repoPath: string): Promise<HubTask[]> {
  return (await readHubTasks(configDir, repoPath)).tasks;
}

/** `repoPath` is the first key of a store (see `save`): the head of the file names the board without parsing its tasks. */
const HEAD_REPO_PATH = /^\s*\{\s*"repoPath"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\.)*")/;

async function repoPathOf(file: string): Promise<unknown> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = HEAD_REPO_PATH.exec(buf.toString('utf8', 0, bytesRead));
    if (m !== null) return JSON.parse(m[1]!);
    // A hand-edited store with another key order, or a very long path: the full parse, through the same
    // handle (the positional read above left its position at 0).
    return (JSON.parse(await fh.readFile('utf8')) as { repoPath?: unknown }).repoPath;
  } finally {
    await fh.close();
  }
}

/** The repositories that have a hub task store. An unreadable store is reported and skipped. */
export async function listHubBoards(configDir: string): Promise<string[]> {
  const names = await readdir(storeDir(configDir)).catch(() => []);
  const out: string[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const repoPath = await repoPathOf(join(storeDir(configDir), name));
      if (typeof repoPath === 'string' && fileFor(configDir, repoPath) === join(storeDir(configDir), name)) out.push(repoPath);
    } catch (e) {
      console.error(`vanguard-hub: hub task store ${name} is unreadable: ${String(e)}`);
    }
  }
  return out;
}

export async function createHubTask(configDir: string, repoPath: string, input: { title: string; body?: string; blockedBy?: string[]; startDate?: string; owner: HubTaskOwner }): Promise<HubTask> {
  if (input.startDate !== undefined && parseStart(input.startDate) === undefined) throw new BadRequestError('startDate must be YYYY-MM-DD or an ISO date-time with a zone');
  const file = fileFor(configDir, repoPath);
  return lock(file, async () => {
    const store = await read(file);
    if (store.tasks.length >= MAX_TASKS) throw new BadRequestError(`this board already holds ${MAX_TASKS} tasks`);
    // Numbered past invalid entries too: an id a hand edit left in the file is never reused.
    // Only well-formed ids count: a hand-edited `hub-12345678901` must not push every new id past HUB_TASK_ID.
    const used = [...store.tasks, ...store.invalid].map((t) => String((t as { id?: unknown } | null)?.id)).filter((id) => HUB_TASK_ID.test(id)).map(idNumber);
    const n = used.reduce((max, v) => Math.max(max, v), store.lastId) + 1;
    if (!HUB_TASK_ID.test(`hub-${n}`)) throw new BadRequestError('this board has run out of task ids');
    const task: HubTask = { id: `hub-${n}`, title: input.title, body: input.body ?? '', status: 'todo', blockedBy: input.blockedBy ?? [], owner: input.owner, ...(input.startDate !== undefined ? { startDate: input.startDate } : {}) };
    store.tasks.push(task);
    store.lastId = n;
    await commit(file, repoPath, store, [{ set: task }]);
    return task;
  });
}

/** Change one task under the file's lock. `edit` may throw to refuse; an unknown id resolves undefined. */
export function editHubTask(configDir: string, repoPath: string, id: string, edit: (task: HubTask) => void): Promise<HubTask | undefined> {
  const file = fileFor(configDir, repoPath);
  return lock(file, async () => {
    const store = await read(file);
    const task = store.tasks.find((t) => t.id === id);
    if (task === undefined) return undefined;
    edit(task);
    await commit(file, repoPath, store, [{ set: task }]);
    return task;
  });
}

/**
 * Edit a task's dependencies and start date (`startDate: null` clears it). A reference to a task that does not exist
 * is kept and shown on the card by the scheduler; only malformed values are refused. The editor becomes the task's owner.
 */
export async function updateHubTask(configDir: string, repoPath: string, id: string, patch: { blockedBy?: string[]; startDate?: string | null; owner?: HubTaskOwner }): Promise<HubTask> {
  if (patch.startDate != null && parseStart(patch.startDate) === undefined) throw new BadRequestError('startDate must be YYYY-MM-DD or an ISO date-time with a zone');
  const task = await editHubTask(configDir, repoPath, id, (t) => {
    if (patch.blockedBy !== undefined) t.blockedBy = [...new Set(patch.blockedBy)];
    if (patch.startDate === null) delete t.startDate;
    else if (patch.startDate !== undefined) t.startDate = patch.startDate;
    if (patch.owner !== undefined) t.owner = patch.owner;
  });
  if (task === undefined) throw new BadRequestError(`no hub task ${id}`);
  return task;
}

/**
 * A `running` task with no live run is marked `failed`: its run died with the hub process (the run session's active
 * run and queue are in memory only), and it may already have pushed a branch or opened a pull request, so it is not
 * started again on its own; a person presses Retry. `isLive` names the tasks this process still holds a run for.
 */
export async function resetStaleRunning(configDir: string, repoPath: string, isLive: (id: string) => boolean = () => false): Promise<string[]> {
  return (await resetAndListHubTasks(configDir, repoPath, isLive)).reset;
}

/** `resetStaleRunning` and the board's tasks from one read of the store (a tick needs both). */
export function resetAndListHubTasks(configDir: string, repoPath: string, isLive: (id: string) => boolean = () => false): Promise<{ reset: string[]; tasks: HubTask[] }> {
  const file = fileFor(configDir, repoPath);
  return lock(file, async () => {
    const store = await read(file);
    const stale = store.tasks.filter((t) => t.status === 'running' && !isLive(t.id));
    if (stale.length === 0) return { reset: [], tasks: store.tasks };
    for (const t of stale) {
      t.status = 'failed';
      delete t.runId;
      t.reason = 'its run ended with the hub process before it finished; it may already have pushed a branch or opened a pull request (check the repository), then press Retry to run it again';
    }
    await commit(file, repoPath, store, stale.map((t) => ({ set: t })));
    return { reset: stale.map((t) => t.id), tasks: store.tasks };
  });
}

/**
 * Take a task off the board. `archive` (a `done` task only) first appends it to the project's archive file, which is
 * never read back or rewritten; either way the board shrinks, which frees room under MAX_TASKS. A running task cannot
 * go. A task an open task waits on cannot go; a `done` one is dropped from its dependents' `blockedBy` (it was satisfied).
 */
export function removeHubTask(configDir: string, repoPath: string, id: string, mode: 'archive' | 'delete'): Promise<void> {
  const file = fileFor(configDir, repoPath);
  return lock(file, async () => {
    const store = await read(file);
    const task = store.tasks.find((t) => t.id === id);
    if (task === undefined) throw new BadRequestError(`no hub task ${id}`);
    if (task.status === 'running') throw new BadRequestError(`${id} is running; it cannot be removed`);
    if (mode === 'archive' && task.status !== 'done') throw new BadRequestError(`${id} is ${task.status}; only a done task can be archived (delete it instead)`);
    const dependents = store.tasks.filter((t) => t.blockedBy.includes(id));
    if (task.status !== 'done') {
      const open = dependents.filter((t) => t.status !== 'done');
      if (open.length > 0) throw new BadRequestError(`${open.map((t) => t.id).join(', ')} ${open.length > 1 ? 'are' : 'is'} blocked by ${id}; remove that dependency first`);
    }
    for (const t of dependents) t.blockedBy = t.blockedBy.filter((d) => d !== id);
    if (mode === 'archive') await appendLines(archiveFor(file), `${JSON.stringify(task)}\n`);
    store.tasks = store.tasks.filter((t) => t !== task);
    // The removal last: a crash that cuts it off leaves the task on the board, its done dependency already dropped.
    await commit(file, repoPath, store, [...dependents.map((t) => ({ set: t })), { remove: id }]);
  });
}
