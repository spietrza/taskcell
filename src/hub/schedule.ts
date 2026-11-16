// What the hub board's scheduler does with each task: pure, so the board and the scheduler read the same answer.
import { parseStart, type HubTask } from './hub-tasks.js';
import type { TaskSchedule } from '../wire.js';

/** `Tue 18.11 (Europe/Berlin)` — the day in the hub's time zone, zone named. */
export function formatWait(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone }).formatToParts(at);
  const p = (t: string): string => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('weekday')} ${p('day')}.${p('month')} (${timeZone})`;
}

/**
 * Why each task that a dependency cycle keeps from ever starting cannot start: its own loop (`a → b → a`), or the loop
 * it waits behind. Linear in tasks plus references and without recursion: tasks whose dependencies can all finish are
 * peeled off first (Kahn), then each remaining task is walked once along its first stuck dependency until a loop closes.
 * A reference to a missing task is reported on its own and does not count here.
 */
function cycleReasons(tasks: readonly HubTask[], byId: ReadonlyMap<string, HubTask>): Map<string, string> {
  const open = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    const deps = [...new Set(t.blockedBy)].filter((d) => byId.has(d));
    open.set(t.id, deps.length);
    for (const d of deps) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [t.id]);
      else list.push(t.id);
    }
  }
  const free = tasks.filter((t) => open.get(t.id) === 0).map((t) => t.id);
  for (let i = 0; i < free.length; i++) {
    for (const n of dependents.get(free[i]!) ?? []) {
      open.set(n, open.get(n)! - 1);
      if (open.get(n) === 0) free.push(n);
    }
  }
  const stuck = new Set(tasks.filter((t) => open.get(t.id)! > 0).map((t) => t.id));
  const loopOf = new Map<string, string>();
  const reasons = new Map<string, string>();
  for (const from of stuck) {
    const path: string[] = [];
    const at = new Map<string, number>();
    let cur = from;
    while (!loopOf.has(cur) && !at.has(cur)) {
      at.set(cur, path.length);
      path.push(cur);
      cur = byId.get(cur)!.blockedBy.find((d) => stuck.has(d))!; // a stuck task always has a stuck dependency
    }
    const first = at.get(cur) ?? path.length; // the walk's tasks from here on are the loop; the ones before wait behind it
    const loop = loopOf.get(cur) ?? [...path.slice(first), cur].join(' → ');
    path.forEach((id, i) => {
      loopOf.set(id, loop);
      reasons.set(id, i >= first ? `dependency cycle: ${loop}` : `waits behind a dependency cycle: ${loop}`);
    });
  }
  return reasons;
}

export interface SchedulePlan {
  /** Every task's schedule, by id. */
  byId: Map<string, TaskSchedule>;
  /** Tasks to start now, in board order. */
  start: string[];
}

/**
 * Decide each task: a `todo` starts when it is valid, every dependency is `done`, its start date has passed and a slot
 * is free (`limit` minus the tasks already handed to the run session). A missing reference or a cycle is `invalid`
 * with the reason and never starts. `queued` maps a run id waiting in the run session's queue to its position.
 */
export function planSchedule(tasks: readonly HubTask[], opts: { now: Date; limit: number; timeZone: string; queued?: ReadonlyMap<string, number> }): SchedulePlan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cycles = cycleReasons(tasks, byId);
  const out = new Map<string, TaskSchedule>();
  const candidates: HubTask[] = [];
  const free = opts.limit - tasks.filter((t) => t.status === 'running').length;
  for (const t of tasks) {
    if (t.status === 'running') {
      const position = t.runId === undefined ? undefined : opts.queued?.get(t.runId);
      out.set(t.id, position === undefined ? { state: 'running', label: 'running' } : { state: 'queued', label: `queued behind another run (position ${position})` });
      continue;
    }
    if (t.status === 'done') { out.set(t.id, { state: 'done', label: 'done', ...(t.result !== undefined ? { result: t.result } : {}) }); continue; }
    if (t.status === 'failed') { out.set(t.id, { state: 'failed', label: t.reason !== undefined ? `failed: ${t.reason}` : 'failed', ...(t.reason !== undefined ? { reason: t.reason } : {}), ...(t.result !== undefined ? { result: t.result } : {}) }); continue; }
    const missing = t.blockedBy.filter((d) => !byId.has(d));
    const start = t.startDate === undefined ? undefined : parseStart(t.startDate, opts.timeZone);
    const reason =
      missing.length > 0 ? `blocked by ${missing.join(', ')}, which ${missing.length > 1 ? 'are not tasks' : 'is not a task'} of this project`
      : cycles.get(t.id) ?? (t.startDate !== undefined && start === undefined ? `start date "${t.startDate}" is not valid` : undefined);
    if (reason !== undefined) { out.set(t.id, { state: 'invalid', reason, label: `cannot start: ${reason}` }); continue; }
    const open = t.blockedBy.filter((d) => byId.get(d)?.status !== 'done');
    if (open.length > 0) { out.set(t.id, { state: 'blocked', blockedBy: open, label: `blocked by ${open.join(', ')}` }); continue; }
    if (start !== undefined && start.getTime() > opts.now.getTime()) {
      out.set(t.id, { state: 'waits-date', until: start.toISOString(), label: `waits until ${formatWait(start, opts.timeZone)}` });
      continue;
    }
    candidates.push(t);
  }
  const start = candidates.slice(0, Math.max(0, free));
  for (const t of candidates) {
    out.set(
      t.id,
      !start.includes(t) ? { state: 'waits-slot', label: 'waits for a free slot' }
      // Its last start was refused (no credential, the run queue is full): still todo, tried again on the next tick.
      : t.reason !== undefined ? { state: 'refused', reason: t.reason, label: `not started: ${t.reason}` }
      : { state: 'ready', label: 'starts next' },
    );
  }
  return { byId: out, start: start.map((t) => t.id) };
}
