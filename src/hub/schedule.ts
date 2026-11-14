// What the hub board's scheduler does with each task: pure, so the board and the scheduler read the same answer.
import { parseStart, type HubTask } from './hub-tasks.js';
import type { TaskSchedule } from '../wire.js';

/** Parallel runs when the project's `concurrency` is unset. */
export const DEFAULT_PARALLEL = 3;

/** `Tue 18.11 (Europe/Berlin)` — the day in the hub's time zone, zone named. */
export function formatWait(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone }).formatToParts(at);
  const p = (t: string): string => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('weekday')} ${p('day')}.${p('month')} (${timeZone})`;
}

/** The cycle `id` is part of, as `a → b → a`, or undefined. Missing ids end the walk. */
function cycleThrough(id: string, byId: ReadonlyMap<string, HubTask>): string[] | undefined {
  const walk = (cur: string, path: string[], seen: Set<string>): string[] | undefined => {
    for (const dep of byId.get(cur)?.blockedBy ?? []) {
      if (dep === id) return [...path, id];
      if (seen.has(dep) || !byId.has(dep)) continue;
      seen.add(dep);
      const found = walk(dep, [...path, dep], seen);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(id, [id], new Set([id]));
}

export interface SchedulePlan {
  /** Every task's schedule, by id. */
  byId: Map<string, TaskSchedule>;
  /** Tasks to start now, in board order. */
  start: string[];
}

/**
 * Decide each task: a `todo` starts when it is valid, every dependency is `done`, its start date has passed and a slot
 * is free (`limit` minus the running tasks). A missing reference or a cycle is `invalid` with the reason and never starts.
 */
export function planSchedule(tasks: readonly HubTask[], opts: { now: Date; limit: number; timeZone: string }): SchedulePlan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, TaskSchedule>();
  const candidates: string[] = [];
  const free = opts.limit - tasks.filter((t) => t.status === 'running').length;
  for (const t of tasks) {
    if (t.status !== 'todo') { out.set(t.id, { state: t.status, label: t.status }); continue; }
    const missing = t.blockedBy.filter((d) => !byId.has(d));
    const cycle = cycleThrough(t.id, byId);
    const start = t.startDate === undefined ? undefined : parseStart(t.startDate, opts.timeZone);
    const reason =
      missing.length > 0 ? `blocked by ${missing.join(', ')}, which ${missing.length > 1 ? 'are not tasks' : 'is not a task'} of this project`
      : cycle !== undefined ? `dependency cycle: ${cycle.join(' → ')}`
      : t.startDate !== undefined && start === undefined ? `start date "${t.startDate}" is not valid`
      : undefined;
    if (reason !== undefined) { out.set(t.id, { state: 'invalid', reason, label: `cannot start: ${reason}` }); continue; }
    const open = t.blockedBy.filter((d) => byId.get(d)?.status !== 'done');
    if (open.length > 0) { out.set(t.id, { state: 'blocked', blockedBy: open, label: `blocked by ${open.join(', ')}` }); continue; }
    if (start !== undefined && start.getTime() > opts.now.getTime()) {
      out.set(t.id, { state: 'waits-date', until: start.toISOString(), label: `waits until ${formatWait(start, opts.timeZone)}` });
      continue;
    }
    candidates.push(t.id);
  }
  const start = candidates.slice(0, Math.max(0, free));
  for (const id of candidates) out.set(id, start.includes(id) ? { state: 'ready', label: 'starts next' } : { state: 'waits-slot', label: 'waits for a free slot' });
  return { byId: out, start };
}
