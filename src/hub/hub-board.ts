// The hub board for a project whose task source is `hub`: its tasks as cards, each with the scheduler's answer.
import { readAppConfig } from './app-config.js';
import { hubTimeZone, listHubTasks, type HubTask } from './hub-tasks.js';
import { DEFAULT_PARALLEL, planSchedule } from './schedule.js';
import type { BoardTask } from '../wire.js';

/** Parallel-run limit: the project's `concurrency` when it is a whole number of 1 or more. */
export async function parallelLimit(repoPath: string): Promise<number> {
  const n = (await readAppConfig(repoPath)).concurrency;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_PARALLEL;
}

const COLUMN: Record<HubTask['status'], BoardTask['column']> = { todo: 'queued', running: 'running', done: 'done', failed: 'verify-failed' };

export async function listHubBoard(repoPath: string, now: Date = new Date()): Promise<{ tasks: BoardTask[]; capped: boolean }> {
  const tasks = await listHubTasks(repoPath);
  const timeZone = hubTimeZone();
  const plan = planSchedule(tasks, { now, limit: await parallelLimit(repoPath), timeZone });
  return {
    capped: false,
    tasks: tasks.map((t) => {
      const schedule = plan.byId.get(t.id)!;
      return {
        id: t.id,
        title: t.title,
        column: COLUMN[t.status],
        state: schedule.label,
        ...(t.status === 'todo' && (schedule.state === 'ready' || schedule.state === 'waits-slot') ? { waiting: true } : {}),
        blockedBy: t.blockedBy,
        ...(t.startDate !== undefined ? { startDate: t.startDate } : {}),
        schedule,
        timeZone,
      };
    }),
  };
}
