// The hub board for a project whose task source is `hub`: its tasks as cards, each with the scheduler's answer.
import { parseSkillsLine } from '../context/named-skills.js';
import { readAppConfig } from './app-config.js';
import { boardServed } from './local-worker.js';
import { ASKED_REASON, hubTimeZone, readHubTasks, type HubTask } from './hub-tasks.js';
import { MAX_CONCURRENT_RUNS } from './run-session.js';
import { planSchedule } from './schedule.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import type { BoardTask, RunSummary } from '../wire.js';

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

/** Each task's newest run record; empty when the records cannot be read (the board still shows the store). */
async function latestRuns(repoPath: string): Promise<Map<string, RunSummary>> {
  const runs = await listRunSummaries(defaultRunsRoot(repoPath)).catch(() => []);
  const out = new Map<string, RunSummary>();
  for (const r of runs) if (!out.has(r.taskId) || out.get(r.taskId)!.timestamp < r.timestamp) out.set(r.taskId, r);
  return out;
}

/** Why a `done` task's newest run says otherwise (it failed, or its agent stopped to ask); undefined when it did not. Stores written before
 *  task-scheduler.ts failed a partial run hold such tasks as done; a person's Accept (`accepted`) keeps them done. */
function failedLast(run: RunSummary | undefined): string | undefined {
  if (run === undefined || run.stoppedBy !== undefined || !run.anyFailed) return undefined;
  return run.asked !== undefined ? ASKED_REASON : 'its last run failed (see Runs)';
}

/** `queued`: the run session's queue (run id → position), so a task waiting there is not shown as running. */
export async function listHubBoard(configDir: string, repoPath: string, queued: ReadonlyMap<string, number> = new Map(), now: Date = new Date()): Promise<{ tasks: BoardTask[]; capped: boolean; hubBoard: true }> {
  const { tasks, invalid } = await readHubTasks(configDir, repoPath);
  const timeZone = hubTimeZone();
  const served = await boardServed(configDir, repoPath);
  // The sweep's own filter (task-scheduler.ts): with auto-run off only a requested task takes a slot, so it reads "starts next".
  const plan = planSchedule(tasks, { now, limit: await parallelLimit(repoPath), timeZone, queued, ...(served ? {} : { only: (t: HubTask) => t.startRequested === true }) });
  const lastRun = await latestRuns(repoPath);
  const cards: BoardTask[] = tasks.map((t) => {
    const failedRun = t.status === 'done' && t.accepted !== true ? failedLast(lastRun.get(t.id)) : undefined;
    if (failedRun !== undefined) t = { ...t, status: 'failed', reason: failedRun };
    const schedule = failedRun !== undefined ? { state: 'failed' as const, label: `failed: ${failedRun}`, reason: failedRun } : plan.byId.get(t.id)!;
    // Auto-run off: a card the scheduler would start next only waits for a hand start (unless one was asked for).
    const idle = !served && t.startRequested !== true && (schedule.state === 'ready' || schedule.state === 'waits-slot');
    const waiting = schedule.state === 'queued' || schedule.state === 'ready' || schedule.state === 'refused' || schedule.state === 'waits-slot';
    // A failed card sits on the station its run failed at (the Board's mark and the card panel read the same run).
    const run = lastRun.get(t.id);
    const failedAt = t.status === 'failed' && run?.anyFailed === true && run.verifyFailed !== true ? run.failedStage : undefined;
    return {
      id: t.id,
      title: t.title,
      ...(failedAt !== undefined ? { stage: failedAt } : {}),
      ...(t.status === 'failed' && (t.reason === ASKED_REASON || run?.asked !== undefined) ? { asked: true as const } : {}),
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
