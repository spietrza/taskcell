// The hub board's own tasks (project `taskSource: hub`): one JSON file under `.taskcell/`, validated on read.
// Dependencies and the start date are plain fields here; src/hub/schedule.ts decides what may start.
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { ensureStateDir, stateDir } from '../core/state-path.js';

export type HubTaskStatus = 'todo' | 'running' | 'done' | 'failed';

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
}

const STATUSES: readonly string[] = ['todo', 'running', 'done', 'failed'];
const file = (repoPath: string): string => join(stateDir(repoPath), 'hub-tasks.json');

/** The hub's time zone, which a date-only start date is read in. */
export const hubTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `ts`'s offset from UTC in `timeZone`, in ms. */
function zoneOffset(ts: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ts)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ts / 1000) * 1000;
}

/** A start date is `YYYY-MM-DD` (00:00 in the hub's time zone) or a full ISO instant with `Z`/offset; anything else is undefined. */
export function parseStart(value: string, timeZone: string = hubTimeZone()): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  if (value.length > 10) return d;
  if (d.toISOString().slice(0, 10) !== value) return undefined; // 2026-02-31 rolls over
  // Midnight local: shift by the zone's offset, once more across a DST change.
  const first = d.getTime() - zoneOffset(d.getTime(), timeZone);
  return new Date(d.getTime() - zoneOffset(first, timeZone));
}

function clean(raw: unknown): HubTask[] {
  if (!Array.isArray(raw)) return [];
  const out: HubTask[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r?.id !== 'string' || typeof r.title !== 'string' || typeof r.status !== 'string' || !STATUSES.includes(r.status)) continue;
    out.push({
      id: r.id,
      title: r.title,
      body: typeof r.body === 'string' ? r.body : '',
      status: r.status as HubTaskStatus,
      blockedBy: Array.isArray(r.blockedBy) ? r.blockedBy.filter((x): x is string => typeof x === 'string') : [],
      ...(typeof r.startDate === 'string' ? { startDate: r.startDate } : {}),
    });
  }
  return out;
}

export async function listHubTasks(repoPath: string): Promise<HubTask[]> {
  try {
    if ((await lstat(file(repoPath))).isSymbolicLink()) return [];
    return clean(JSON.parse(await readFile(file(repoPath), 'utf8')));
  } catch {
    return [];
  }
}

async function save(repoPath: string, tasks: HubTask[]): Promise<void> {
  await ensureStateDir(repoPath, stateDir(repoPath));
  const tmp = `${file(repoPath)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tasks, null, 2)}\n`);
  await rename(tmp, file(repoPath));
}

// One write at a time per file: read-modify-write must not interleave (the scheduler and the UI both write).
const chains = new Map<string, Promise<unknown>>();
function serial<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = file(repoPath);
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

export function createHubTask(repoPath: string, title: string, body = ''): Promise<HubTask> {
  return serial(repoPath, async () => {
    const tasks = await listHubTasks(repoPath);
    const n = Math.max(0, ...tasks.map((t) => Number(/^hub-(\d+)$/.exec(t.id)?.[1] ?? 0))) + 1;
    const task: HubTask = { id: `hub-${n}`, title, body, status: 'todo', blockedBy: [] };
    await save(repoPath, [...tasks, task]);
    return task;
  });
}

/**
 * Edit a task's dependencies and start date (`startDate: null` clears it). A reference to a task that does not exist
 * is kept and shown on the card by the scheduler, so a hand-edited file and the UI behave alike; only malformed values are refused.
 */
export async function updateHubTask(repoPath: string, id: string, patch: { blockedBy?: string[]; startDate?: string | null }): Promise<HubTask> {
  if (patch.startDate != null && parseStart(patch.startDate) === undefined) throw new BadRequestError('startDate must be YYYY-MM-DD or an ISO date-time with a zone');
  return serial(repoPath, async () => {
    const tasks = await listHubTasks(repoPath);
    const task = tasks.find((t) => t.id === id);
    if (task === undefined) throw new BadRequestError(`no hub task ${id}`);
    if (patch.blockedBy !== undefined) task.blockedBy = [...new Set(patch.blockedBy)];
    if (patch.startDate === null) delete task.startDate;
    else if (patch.startDate !== undefined) task.startDate = patch.startDate;
    await save(repoPath, tasks);
    return task;
  });
}

export function setHubTaskStatus(repoPath: string, id: string, status: HubTaskStatus): Promise<void> {
  return serial(repoPath, async () => {
    const tasks = await listHubTasks(repoPath);
    const task = tasks.find((t) => t.id === id);
    if (task === undefined) return;
    task.status = status;
    await save(repoPath, tasks);
  });
}
