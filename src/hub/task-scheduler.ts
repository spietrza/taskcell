// Starts hub-board tasks: every tick plans the project's tasks (src/hub/schedule.ts) and hands those that may run to
// the run session, as the person each task runs as and under the same gates as `api_create_run`.
import { BadRequestError, type CreateRunParams, type CreateRunResult, type SidecarDeps } from '../sidecar/sidecar.js';
import { configuredFlow, readAppConfig } from './app-config.js';
import { auditActorOf, reportAuditFailure, type Actor, type AuditAction, type AuditLog, type AuditOutcome } from './audit.js';
import type { ProjectAllowlist } from './allowlist.js';
import type { CredentialService } from './credentials.js';
import { editHubTask, hubTimeZone, listHubBoards, resetAndListHubTasks, resetStaleRunning, type HubTask } from './hub-tasks.js';
import { parallelLimit } from './hub-board.js';
import { failureMessage } from './projects.js';
import type { RunSession } from './run-session.js';
import { planSchedule } from './schedule.js';
import * as teams from './teams.js';

/** The transport of a hub-board run. Not one of `TRANSPORTS`: only the scheduler can ask for it, never a client. */
export const HUB_TRANSPORT = 'hub';

/**
 * Hands the task to the run session and resolves with the run's result. `admitted(runId)` is called once the session
 * has taken the run (started or queued); a rejection before that is a refusal, not a failed run.
 */
export type StartTask = (task: HubTask, admitted: (runId: string) => void) => Promise<CreateRunResult>;

/** One hub's scheduler memory. It dies with the hub, like the run session's active run and queue. */
export interface SchedulerState {
  /** Projects a tick is planning right now. */
  ticking: Set<string>;
  /** Tasks this hub holds a run for. A `running` task that is not here has no live run. */
  live: Set<string>;
  /** Ends of runs the store could not record yet; written first on the next tick, and the task stays live until then. */
  pending: Map<string, Pick<HubTask, 'status' | 'reason' | 'result'>>;
}
export const schedulerState = (): SchedulerState => ({ ticking: new Set(), live: new Set(), pending: new Map() });
const key = (repoPath: string, id: string): string => `${repoPath}\n${id}`;

function ended(result: CreateRunResult): Pick<HubTask, 'status' | 'reason' | 'result'> {
  if (result.verificationFailed === true && (result.prUrl !== undefined || result.branch !== undefined)) {
    const where = result.prUrl ?? `branch ${result.branch}`;
    return { status: 'failed', reason: `verify failed on the delivered result (${where}); dependents do not start. Accept the result to mark it done, or Retry (a second run delivers a second branch or pull request)`, result: where };
  }
  if (result.prUrl !== undefined) return { status: 'done', result: result.prUrl };
  if (result.branch !== undefined) return { status: 'done', result: `branch ${result.branch}` };
  if (result.secretBlocked === true) return { status: 'failed', reason: 'the secret scan blocked the result (see the run record)' };
  if (result.baseRed === true) return { status: 'failed', reason: 'the base branch is red: its verify command fails before any change' };
  return { status: 'failed', reason: 'the run made no changes' };
}

/** Start what may start now; resolves with the ids the run session took, once they are marked running (not when they end). */
export async function scheduleTick({ ticking, live, pending }: SchedulerState, configDir: string, repoPath: string, start: StartTask, opts: { limit: number; now?: Date }): Promise<string[]> {
  if (ticking.has(repoPath)) return [];
  ticking.add(repoPath);
  try {
    for (const [k, end] of [...pending]) {
      if (!k.startsWith(`${repoPath}\n`)) continue;
      await editHubTask(configDir, repoPath, k.slice(repoPath.length + 1), (t) => {
        delete t.runId;
        Object.assign(t, end);
      });
      pending.delete(k);
      live.delete(k);
    }
    const { tasks } = await resetAndListHubTasks(configDir, repoPath, (id) => live.has(key(repoPath, id)));
    const plan = planSchedule(tasks, { now: opts.now ?? new Date(), limit: opts.limit, timeZone: hubTimeZone() });
    const started: string[] = [];
    for (const id of plan.start) {
      const k = key(repoPath, id);
      if (live.has(k)) continue;
      const task = tasks.find((t) => t.id === id)!;
      let run!: Promise<CreateRunResult>;
      const admission = await new Promise<string | Error>((resolve) => {
        run = Promise.resolve().then(() => start(task, resolve));
        run.then(() => resolve(''), (e: unknown) => resolve(e instanceof Error ? e : new Error(String(e))));
      });
      if (typeof admission !== 'string') {
        // Refused before the session took it (slot and queue busy, no credential, not allowed): still todo, retried next tick.
        const reason = failureMessage(admission);
        if (task.reason !== reason) await editHubTask(configDir, repoPath, id, (t) => { t.reason = reason; });
        continue;
      }
      live.add(k);
      await editHubTask(configDir, repoPath, id, (t) => {
        t.status = 'running';
        if (admission !== '') t.runId = admission;
        delete t.reason;
      });
      started.push(id);
      const record = (end: Pick<HubTask, 'status' | 'reason' | 'result'>): Promise<unknown> =>
        editHubTask(configDir, repoPath, id, (t) => {
          delete t.runId;
          Object.assign(t, end);
        });
      const finish = (end: Pick<HubTask, 'status' | 'reason' | 'result'>): Promise<void> =>
        record(end).then(
          () => { live.delete(k); },
          (e: unknown) => {
            // The store could not be written: keep the real end and the task live; the next tick writes it.
            pending.set(k, end);
            console.error(`vanguard-hub: scheduler: could not record the end of ${id} in ${repoPath}: ${failureMessage(e)}`);
          },
        );
      void run.then((result) => finish(ended(result)), (e: unknown) => finish({ status: 'failed', reason: failureMessage(e) }));
    }
    return started;
  } finally {
    ticking.delete(repoPath);
  }
}

export interface SweepContext {
  scheduler: SchedulerState;
  configDir: string;
  allowlist: ProjectAllowlist;
  runSession: RunSession;
  /** `deps.checkRun`: a missing model credential refuses the start here, before the session admits it. */
  deps?: Pick<SidecarDeps, 'checkRun'>;
  userCredentials?: CredentialService;
  audit?: AuditLog;
  /** Re-resolves the stored owner at start (current account and owner flag); undefined: no longer valid, the task does not run. */
  recheckCaller: (stored: teams.Caller) => Promise<teams.Caller | undefined>;
  /** A project the sweep may serve (default: all). The local worker's switch, when set off, stops a board's pick-ups. */
  served?: (repoPath: string) => Promise<boolean>;
  /** Called with the ids a tick started. */
  picked?: (repoPath: string, ids: string[]) => Promise<void>;
}

/**
 * Start one task as its owner, through the gates `api_create_run` applies to a request: the owner's teams still reach
 * the repository, the credential policy picks whose key funds the run (`user-only` with none saved refuses), and the
 * admission is audited under the owner's login.
 */
async function startHubTask(ctx: SweepContext, repoPath: string, task: HubTask, admitted: (runId: string) => void): Promise<CreateRunResult> {
  const who = task.owner;
  // The stored actor is a snapshot; once the owner is re-resolved, the login and name are the account's current ones.
  let actor: Actor | undefined = who?.actor;
  let logged = false;
  const log = (action: AuditAction, target: string, outcome: AuditOutcome): void => {
    if (who === undefined || actor === undefined) return;
    logged = true;
    void ctx.audit?.record({ login: actor.login, actor: auditActorOf(actor), action, target, outcome }).catch(reportAuditFailure);
  };
  try {
    if (who === undefined) throw new BadRequestError('this task has no owner on this hub — save its schedule to run it as you');
    const caller = await ctx.recheckCaller(who.caller);
    if (caller === undefined) throw new BadRequestError('the owner of this task no longer has an account on this hub (or is no longer allowed on it) — save its schedule to run it as you');
    if (who.actor.id !== undefined) actor = { ...who.actor, login: caller.user.email, name: caller.user.name };
    teams.assertRepoInRoots(await teams.callerRepoRoots(ctx.configDir, caller), repoPath);
    const config = await readAppConfig(repoPath);
    const provider = typeof config.provider === 'string' && config.provider.trim() !== '' ? config.provider : undefined;
    const flow = configuredFlow(config);
    const credential = ctx.userCredentials !== undefined ? await ctx.userCredentials.resolveForRun(caller.user, provider) : undefined;
    const params: CreateRunParams = { issueRef: task.id, repoPath, transport: HUB_TRANSPORT, hubTask: { id: task.id, title: task.title, body: task.body }, ...(task.skills !== undefined ? { skills: task.skills } : {}), startedBy: actor!.login, ...(provider !== undefined ? { provider } : {}), ...(flow !== undefined ? { flow } : {}) };
    await ctx.deps?.checkRun?.(params, credential);
    return await ctx.runSession.createRun(
      params,
      {
        onStarted: (id) => { log('run-start', `${id} ${task.id}`, 'ok'); admitted(id); },
        onQueued: (id) => { log('run-queue', `${id} ${task.id}`, 'ok'); admitted(id); },
        onRefused: (id) => log('run-start', `${id} ${task.id}`, 'refused'),
      },
      credential,
    );
  } catch (err) {
    // One refusal line per reason, not one per tick: the same refusal is retried every tick.
    if (!logged && failureMessage(err) !== task.reason) log('run-start', `${repoPath} ${task.id}`, 'refused');
    throw err;
  }
}

/**
 * One scheduler pass over the projects that have a hub task store. A project is touched only when the hub created
 * tasks for it, it is still registered and its task source is still `hub`: GitHub, GitLab and Linear projects, and a
 * checkout that merely commits `taskSource: hub`, see no scheduler activity.
 */
export async function sweepHubBoards(ctx: SweepContext): Promise<void> {
  for (const repoPath of await listHubBoards(ctx.configDir)) {
    try {
      if ((await ctx.allowlist.assertAllowed(repoPath).catch(() => undefined)) !== repoPath) continue;
      if ((await readAppConfig(repoPath)).taskSource !== 'hub') continue;
      if (ctx.served !== undefined && !(await ctx.served(repoPath))) continue;
      const started = await scheduleTick(ctx.scheduler, ctx.configDir, repoPath, (task, admitted) => startHubTask(ctx, repoPath, task, admitted), { limit: await parallelLimit(repoPath) });
      await ctx.picked?.(repoPath, started);
    } catch (e) {
      console.error(`vanguard-hub: scheduler: ${repoPath}: ${failureMessage(e)}`);
    }
  }
}

/** On hub start no run is live: every stored `running` task is marked `failed` (a person retries it). */
export async function reconcileHubBoards(configDir: string): Promise<void> {
  for (const repoPath of await listHubBoards(configDir)) {
    await resetStaleRunning(configDir, repoPath).catch((e: unknown) => console.error(`vanguard-hub: scheduler: ${repoPath}: ${failureMessage(e)}`));
  }
}
