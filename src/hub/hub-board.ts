// The hub board for a project whose task source is `hub`: its tasks as cards, each with the scheduler's answer.
import { parseSkillsLine } from '../context/named-skills.js';
import { readAppConfig } from './app-config.js';
import { boardServed } from './local-worker.js';
import { ASKED_REASON, hubTimeZone, readHubTasks, type HubTask } from './hub-tasks.js';
import { MAX_CONCURRENT_RUNS } from './run-session.js';
import { planSchedule } from './schedule.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import { newestRuns } from './card-view.js';
import { taskRefKey } from '../tasks/board.js';
import type { BoardChip, BoardTask } from '../wire.js';

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

/** The chip of a `done` card whose newest run had a failed stage (a re-review that never answered, a draft PR): the
 *  store's `done` stands (it delivered, dependents start); the chip only says to look. A person's Accept clears it. */
const DELIVERED_WITH_FAILURE: BoardChip = { key: 'warning', label: 'delivered, but a stage failed (see Runs)', tone: 'changes' };

/** `queued`: the run session's queue (run id → position), so a task waiting there is not shown as running. */
export async function listHubBoard(configDir: string, repoPath: string, queued: ReadonlyMap<string, number> = new Map(), now: Date = new Date()): Promise<{ tasks: BoardTask[]; capped: boolean; hubBoard: true }> {
  const { tasks, invalid } = await readHubTasks(configDir, repoPath);
  const timeZone = hubTimeZone();
  const served = await boardServed(configDir, repoPath);
  // The sweep's own filter (task-scheduler.ts): with auto-run off only a requested task takes a slot, so it reads "starts next".
  const plan = planSchedule(tasks, { now, limit: await parallelLimit(repoPath), timeZone, queued, ...(served ? {} : { only: (t: HubTask) => t.startRequested === true }) });
  // Each task's newest run record; empty when the records cannot be read (the board still shows the store).
  const lastRun = newestRuns(await listRunSummaries(defaultRunsRoot(repoPath)).catch(() => []));
  const cards: BoardTask[] = tasks.map((t) => {
    const run = lastRun.get(taskRefKey(t.id));
    // Only the run record says the agent asked (`exitReason: 'incomplete'`, never a turn cap or a timeout); Home's inbox reads the same.
    const asked = t.status === 'failed' && run?.asked !== undefined;
    const planned = plan.byId.get(t.id)!;
    const schedule = asked ? { ...planned, reason: ASKED_REASON, label: `failed: ${ASKED_REASON}` } : planned;
    const warn = t.status === 'done' && t.accepted !== true && run?.anyFailed === true && run.stoppedBy === undefined;
    // Auto-run off: a card the scheduler would start next only waits for a hand start (unless one was asked for).
    const idle = !served && t.startRequested !== true && (schedule.state === 'ready' || schedule.state === 'waits-slot');
    const waiting = schedule.state === 'queued' || schedule.state === 'ready' || schedule.state === 'refused' || schedule.state === 'waits-slot';
    // A failed card sits on the station its run failed at (the Board's mark and the card panel read the same run).
    const failedAt = t.status === 'failed' && run?.anyFailed === true && run.verifyFailed !== true ? run.failedStage : undefined;
    return {
      id: t.id,
      title: t.title,
      ...(failedAt !== undefined ? { stage: failedAt } : {}),
      ...(asked ? { asked: true as const } : {}),
      ...(warn ? { chips: [DELIVERED_WITH_FAILURE] } : {}),
      column: schedule.state === 'queued' ? 'queued' : COLUMN[t.status],
      state: idle ? 'auto-run is off — start it by hand' : schedule.label,
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
