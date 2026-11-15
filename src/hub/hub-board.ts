// The hub board for a project whose task source is `hub`: its tasks as cards, each with the scheduler's answer.
import { parseSkillsLine } from '../context/named-skills.js';
import { readAppConfig } from './app-config.js';
import { hubTimeZone, readHubTasks, type HubTask } from './hub-tasks.js';
import { MAX_CONCURRENT_RUNS } from './run-session.js';
import { planSchedule } from './schedule.js';
import type { BoardTask } from '../wire.js';

/**
 * How many of a project's tasks may be with the run session at once: what the session can hold for one project — its
 * running slot(s) plus the one queued run a project may have — lowered by the project's `concurrency` when that is set.
 */
export async function parallelLimit(repoPath: string): Promise<number> {
  const capacity = MAX_CONCURRENT_RUNS + 1;
  const n = (await readAppConfig(repoPath)).concurrency;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? Math.min(n, capacity) : capacity;
}

/** What a run of the task loads: its stored list, else the body's `Skills:` line. */
const shownSkills = (t: HubTask): string[] => t.skills ?? parseSkillsLine(t.body).skills;

const COLUMN: Record<HubTask['status'], BoardTask['column']> = { todo: 'queued', running: 'running', done: 'done', failed: 'verify-failed' };

/** `queued`: the run session's queue (run id → position), so a task waiting there is not shown as running. */
export async function listHubBoard(configDir: string, repoPath: string, queued: ReadonlyMap<string, number> = new Map(), now: Date = new Date()): Promise<{ tasks: BoardTask[]; capped: boolean; hubBoard: true }> {
  const { tasks, invalid } = await readHubTasks(configDir, repoPath);
  const timeZone = hubTimeZone();
  const plan = planSchedule(tasks, { now, limit: await parallelLimit(repoPath), timeZone, queued });
  const cards: BoardTask[] = tasks.map((t) => {
    const schedule = plan.byId.get(t.id)!;
    const waiting = schedule.state === 'queued' || schedule.state === 'ready' || schedule.state === 'refused' || schedule.state === 'waits-slot';
    return {
      id: t.id,
      title: t.title,
      column: schedule.state === 'queued' ? 'queued' : COLUMN[t.status],
      state: schedule.label,
      ...(waiting ? { waiting: true } : {}),
      blockedBy: t.blockedBy,
      ...(t.startDate !== undefined ? { startDate: t.startDate } : {}),
      ...(shownSkills(t).length > 0 ? { skills: shownSkills(t) } : {}),
      schedule,
      timeZone,
    };
  });
  // Entries of the store that are not valid tasks are kept in the file and shown, never dropped or run.
  if (invalid > 0) {
    const reason = `${invalid} ${invalid > 1 ? 'entries' : 'entry'} of this board's task store ${invalid > 1 ? 'are' : 'is'} not a valid task; kept in the file, never run`;
    cards.push({ id: 'hub-invalid', title: 'Invalid entries in the hub task store', column: 'verify-failed', state: reason, schedule: { state: 'invalid', reason, label: `cannot start: ${reason}` } });
  }
  return { capped: false, hubBoard: true, tasks: cards };
}
