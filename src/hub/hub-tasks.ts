// The hub board's own tasks (project `taskSource: hub`). The store is the hub's, not the repository's: one JSON file
// per project under `<configDir>/hub-tasks/`, so nothing a checkout commits can add a task, change one or redirect a
// write. Dependencies and the start date are plain fields here; src/hub/schedule.ts decides what may start.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
  /** `running`: the run session's id for its run. */
  runId?: string;
  /** `failed`: why. `todo`: why its last start was refused. */
  reason?: string;
  /** `done`: the pull request URL, or `branch <name>`. */
  result?: string;
}

export const HUB_TASK_ID = /^hub-[1-9]\d{0,8}$/;
export const MAX_TITLE_LENGTH = 300;
export const MAX_BODY_LENGTH = 64 * 1024;
export const MAX_BLOCKED_BY = 50;
/** Tasks one project's board holds; the whole file is rewritten on every change. */
export const MAX_TASKS = 1000;

const STATUSES: readonly string[] = ['todo', 'running', 'done', 'failed'];
const storeDir = (configDir: string): string => join(configDir, 'hub-tasks');
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
}

function isTask(r: unknown, seen: Set<string>): r is HubTask {
  if (typeof r !== 'object' || r === null) return false;
  const t = r as Record<string, unknown>;
  return typeof t.id === 'string' && HUB_TASK_ID.test(t.id) && !seen.has(t.id)
    && typeof t.title === 'string' && t.title !== '' && typeof t.body === 'string'
    && typeof t.status === 'string' && STATUSES.includes(t.status)
    && Array.isArray(t.blockedBy) && t.blockedBy.every((x) => typeof x === 'string')
    && (t.startDate === undefined || typeof t.startDate === 'string');
}

/**
 * Strict read: a missing file is an empty board; a file that exists but cannot be read or parsed throws, so no later
 * save replaces it (the `readAppConfigStrict` rule).
 */
async function read(file: string): Promise<Store> {
  let raw: string;
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('it is a symlink');
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], invalid: [] };
    throw new BadRequestError(`the hub task store ${file} is unreadable: ${String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new BadRequestError(`the hub task store ${file} is unreadable: ${String(e)}`);
  }
  const entries = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(entries)) throw new BadRequestError(`the hub task store ${file} is unreadable: it holds no "tasks" list`);
  const store: Store = { tasks: [], invalid: [] };
  const seen = new Set<string>();
  for (const r of entries as unknown[]) {
    if (isTask(r, seen)) {
      seen.add(r.id);
      store.tasks.push(r);
    } else store.invalid.push(r);
  }
  return store;
}

async function save(file: string, repoPath: string, store: Store): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // A fresh name created exclusively, then renamed over the file: never a write through an existing file or link.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ repoPath, tasks: [...store.tasks, ...store.invalid] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
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

/** The repositories that have a hub task store. An unreadable store is reported and skipped. */
export async function listHubBoards(configDir: string): Promise<string[]> {
  const names = await readdir(storeDir(configDir)).catch(() => []);
  const out: string[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const repoPath = (JSON.parse(await readFile(join(storeDir(configDir), name), 'utf8')) as { repoPath?: unknown }).repoPath;
      if (typeof repoPath === 'string' && fileFor(configDir, repoPath) === join(storeDir(configDir), name)) out.push(repoPath);
    } catch (e) {
      console.error(`vanguard-hub: hub task store ${name} is unreadable: ${String(e)}`);
    }
  }
  return out;
}

export function createHubTask(configDir: string, repoPath: string, input: { title: string; body?: string; blockedBy?: string[]; startDate?: string; owner: HubTaskOwner }): Promise<HubTask> {
  if (input.startDate !== undefined && parseStart(input.startDate) === undefined) throw new BadRequestError('startDate must be YYYY-MM-DD or an ISO date-time with a zone');
  const file = fileFor(configDir, repoPath);
  return lock(file, async () => {
    const store = await read(file);
    if (store.tasks.length >= MAX_TASKS) throw new BadRequestError(`this board already holds ${MAX_TASKS} tasks`);
    // Numbered past invalid entries too: an id a hand edit left in the file is never reused.
    const used = [...store.tasks, ...store.invalid].map((t) => Number(/^hub-(\d+)$/.exec(String((t as { id?: unknown } | null)?.id))?.[1] ?? 0));
    const n = Math.max(0, ...used) + 1;
    const task: HubTask = { id: `hub-${n}`, title: input.title, body: input.body ?? '', status: 'todo', blockedBy: input.blockedBy ?? [], owner: input.owner, ...(input.startDate !== undefined ? { startDate: input.startDate } : {}) };
    store.tasks.push(task);
    await save(file, repoPath, store);
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
    await save(file, repoPath, store);
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
export function resetStaleRunning(configDir: string, repoPath: string, isLive: (id: string) => boolean = () => false): Promise<string[]> {
  const file = fileFor(configDir, repoPath);
  return lock(file, async () => {
    const store = await read(file);
    const stale = store.tasks.filter((t) => t.status === 'running' && !isLive(t.id));
    if (stale.length === 0) return [];
    for (const t of stale) {
      t.status = 'failed';
      delete t.runId;
      t.reason = 'its run ended with the hub process before it finished; it may already have pushed a branch or opened a pull request (check the repository), then press Retry to run it again';
    }
    await save(file, repoPath, store);
    return stale.map((t) => t.id);
  });
}
