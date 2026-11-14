// Starts hub-board tasks: every tick plans the project's tasks (src/hub/schedule.ts) and starts those that may run.
import { hubTimeZone, listHubTasks, setHubTaskStatus, type HubTask } from './hub-tasks.js';
import { parallelLimit } from './hub-board.js';
import { planSchedule } from './schedule.js';

/** Runs the task to its end; a rejection marks it failed. */
export type StartTask = (task: HubTask) => Promise<unknown>;

const ticking = new Set<string>();

/** Start what may start now; resolves with the started ids once they are marked running (not when they end). */
export async function scheduleTick(repoPath: string, start: StartTask, now: Date = new Date()): Promise<string[]> {
  if (ticking.has(repoPath)) return [];
  ticking.add(repoPath);
  try {
    const tasks = await listHubTasks(repoPath);
    const plan = planSchedule(tasks, { now, limit: await parallelLimit(repoPath), timeZone: hubTimeZone() });
    for (const id of plan.start) {
      await setHubTaskStatus(repoPath, id, 'running');
      const task = tasks.find((t) => t.id === id)!;
      void start(task).then(
        () => setHubTaskStatus(repoPath, id, 'done'),
        () => setHubTaskStatus(repoPath, id, 'failed'),
      );
    }
    return plan.start;
  } finally {
    ticking.delete(repoPath);
  }
}
