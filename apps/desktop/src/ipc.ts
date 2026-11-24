import { hub } from './transport';
import type { CallArgs } from '../../../packages/hub-client/src/client';
import { tailRun, type RunTail, type RunTailHandlers, type RunTailTarget } from '../../../packages/hub-client/src/runTail';
import type { ApproverMode, CallerCapabilities, ApproverModeChange } from './wire';
import type { RunDetail, Project, RunRef } from './taskcell-output';
import type { Commands, CompleteResponse, FactoryPlan, FactoryVerifyResult } from './wire';

export type { NeedsYouItem, RepoReadFailure, RepoStamp } from './wire';

/**
 * Only the calls that shape their arguments or result live here; every other command is called directly as
 * `hub().call(cmd, args)` (transport.ts), typed by the same catalogue.
 *
 * The one typed seam over the transport (S7): `cmd` must name a command in the wire's `Commands`
 * catalogue, and its args/result are that command's — so a renamed field, a forgotten argument or a
 * wrapper that claims the wrong result shape is a `tsc` error here instead of a runtime surprise in
 * whichever backend answers (the hub, or dev/mockBackend.ts).
 */
function call<K extends keyof Commands>(cmd: K, args: Commands[K]['args']): Promise<Commands[K]['result']> {
  return hub().call(cmd, ...([args] as CallArgs<K>));
}

/** The optional team scope of the hub's list commands: no id = the server's default. */
const teamArgs = (teamId?: string): { teamId: string } | undefined => (teamId === undefined ? undefined : { teamId });

/** HUB_ONLY: every repository's runs, each stamped with its repository; unreadable ones in `failures`. */
export function listRunsAll(teamId?: string): Promise<Commands['list_runs_all']['result']> {
  return call('list_runs_all', teamArgs(teamId));
}

/** Read one run record under `repoPath`. `ref.source` names WHICH tree it lives in (the project's
 *  own runs, or a CI run imported by `importRemoteRun`) — the backend answering resolves it to a
 *  root, so the renderer never carries one. */
export function readRun(repoPath: string, ref: RunRef): Promise<RunDetail> {
  return call('read_run', { repoPath, taskId: ref.taskId, timestamp: ref.timestamp, source: ref.source });
}

/** HUB_ONLY: a run's persisted event log (stage starts and ends with their times), `timestamp` picking that run, default the newest. */
export function readRunEvents(repoPath: string, taskId: string, timestamp?: string): Promise<Commands['read_run_events']['result']> {
  return call('read_run_events', { repoPath, taskId, ...(timestamp !== undefined ? { timestamp } : {}) });
}

/**
 * HUB_ONLY: follow a run's event log (the shared tail in packages/hub-client): every page past the first 500, a read only
 * on an `api:event` of this run, ended at its terminal event. `refresh()` reads again (the file watcher's backstop).
 */
export function tailRunEvents(target: RunTailTarget, handlers: RunTailHandlers): RunTail {
  return tailRun(hub(), target, handlers);
}

export function listProjects(teamId?: string): Promise<Project[]> {
  return call('list_projects', teamArgs(teamId));
}

/** Hub-only: clone `url` under `parentDir` (the same browse-root-confined picker as `browseDirs`)
 *  and register the result, returning just the new project (not the whole list — the caller appends
 *  it, like `cloneProject`'s RepoPicker caller does). */
export function cloneProject(url: string, parentDir: string, name?: string, teamId?: string): Promise<Project> {
  return call('clone_project', { url, parentDir, name, ...(teamId !== undefined ? { teamId } : {}) });
}

/** Enable factory (hub-only), its last step: dispatch the doctor workflow (src/hub/enable-factory.ts). */
export function enableFactoryVerify(repoPath: string, plan: FactoryPlan, confirmedJobs: string[] = []): Promise<FactoryVerifyResult> {
  return call('enable_factory_verify', { repoPath, plan, confirmedJobs });
}

/** HUB_ONLY: Home's activity feed across the team's repositories (run records and hub actions), newest first. */
export function listActivity(teamId?: string): Promise<Commands['list_activity']['result']> {
  return call('list_activity', teamArgs(teamId));
}

/** HUB_ONLY: `list_needs_you` for every repository. */
export function listNeedsYouAll(teamId?: string): Promise<Commands['list_needs_you_all']['result']> {
  return call('list_needs_you_all', teamArgs(teamId));
}

/** HUB_ONLY: every repository's board cards, each stamped with its repository. */
export function listTasksAll(teamId?: string): Promise<Commands['list_tasks_all']['result']> {
  return call('list_tasks_all', teamArgs(teamId));
}

export async function fetchSpec(repoPath: string, taskId: string): Promise<string> {
  const { spec } = await call('fetch_spec', { repoPath, taskId });
  return spec;
}

export const SPAWN_OUTPUT_EVENT = 'spawn:output';
export const SPAWN_EXIT_EVENT = 'spawn:exit';

// The spawned-process shape is the `list_spawns` result in the wire catalogue (S7) — re-exported
// here because Fleet has always imported its IPC types from this module.
export type { SpawnInfo } from './wire';

// Wire types come from the GENERATED src/wire.ts (S7) — no more hand-mirrors. Feature code keeps
// importing them from this module.
export type {
  BoardTask,
  Capabilities,
  FlowInfo,
  CreateRunParams,
  CreateRunResult,
  StageOverrides,
  StageDecl,
  LoopDecl,
  FlowDoc,
  RepoFlowInfo,
  RepoProviderInfo,
  CreatedTask,
  Finding,
  /** The `api_complete` allowlist (see apiComplete below); named CompleteParams here historically. */
  CompleteCallArgs,
  CompleteCallArgs as CompleteParams,
} from './wire';
import type { Capabilities, CompleteCallArgs } from './wire';

// capabilities() is pure and never changes in a session, so cache it — one fewer IPC round-trip on
// every mount. It is NO LONGER a workaround for the run mutex: capabilities now goes over the sidecar's
// query pipe, which answers while a run holds the run pipe. (It used to be exactly that workaround, and
// the comment said so — leaving that claim here would have someone "simplify" the cache away on the
// belief that the block it dodged still exists, or keep it for a reason that is no longer true.)
let capsCache: Promise<Capabilities> | undefined;
export function apiCapabilitiesCached(): Promise<Capabilities> {
  // Cache successes only: `??=` would pin a REJECTED promise for the whole session (a sidecar
  // that was briefly unavailable at startup would permanently disable everything caps-gated —
  // the flow editor's create form, the palette — with no recovery short of an app restart).
  capsCache ??= hub().call('api_capabilities').catch((err: unknown) => {
    capsCache = undefined;
    throw err;
  });
  return capsCache;
}

/**
 * Doc-editor chat completion (Subsystem 3). One-shot spawn, never the run mutex.
 *
 * No `baseUrl` here on purpose: the completion runs with the inherited Anthropic credential, so a
 * caller-supplied base URL would be a way for anything running in the webview to redirect that token
 * to a host of its choosing. The hub reads `chatBaseUrl` from `app.json` itself — hence `repoPath`.
 *
 * `req` is wire's `CompleteCallArgs`: an ALLOWLIST, deliberately not `Omit<CompleteRequest, …>` —
 * every field in it is one the renderer is permitted to send, so a new `CompleteRequest` field must
 * be added there to cross the webview boundary (a denylist would auto-expose it — review #342).
 */
export function apiComplete(
  repoPath: string,
  params: CompleteCallArgs,
  // Opaque per-turn handle. When present, the hub tracks the spawned `__complete` child under it so
  // `apiCancelComplete(callId)` can kill exactly this turn (the Stop button). Omitted for
  // fire-and-forget completions (the auto-title) that are never cancelled.
  callId?: string,
): Promise<CompleteResponse> {
  return call('api_complete', { repoPath, req: params, callId });
}

/**
 * Create a task on the configured transport. The app's first WRITE to an external system, and it cannot
 * be undone from here — so the caller must confirm first, and it must never fire as a side effect.
 *
 * Only title/body cross: `source`, `team` and `label` are read from app.json by the hub. The renderer does
 * not choose which tracker gets written to. (Same rule as CompleteCallArgs — and it matters more here.)
 */
export function apiCreateTask(repoPath: string, title: string, body: string, baseBranch?: string, dependsOn?: string[]): Promise<import('./wire').CreatedTask> {
  return call('api_create_task', { repoPath, title, body, ...(baseBranch !== undefined ? { baseBranch } : {}), ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn } : {}) });
}

/**
 * HUB_ONLY: split work into several tasks in one call. `dependsOn` holds positions of earlier tasks in the
 * list; the hub creates them in order and writes each dependency itself. As irreversible as apiCreateTask.
 */
export function apiCreateTasks(repoPath: string, tasks: { title: string; body: string; dependsOn?: number[] }[], baseBranch?: string): Promise<{ tasks: import('./wire').CreatedTask[] }> {
  return call('api_create_tasks', { repoPath, tasks, ...(baseBranch !== undefined ? { baseBranch } : {}) });
}

/** Persist a pasted image under the draft's assets dir (Editor UX 7/7); returns its absolute path. */
export function writeDraftAsset(repoPath: string, id: string, name: string, bytes: Uint8Array): Promise<string> {
  return call('write_draft_asset', { repoPath, id, name, bytes: Array.from(bytes) });
}

/** Hub-only: the live lessons of a repo (newest first); with `taskText`, only those a task with that text would receive. */
export function listLessons(repoPath: string, taskText?: string): Promise<Commands['list_lessons']['result']> {
  return call('list_lessons', { repoPath, ...(taskText !== undefined ? { taskText } : {}) });
}

/** Hub-only, owner only, a mutation: open a PR that adds the skill at `source`, or the `paths` found by `discoverSkills` (pinned by `ref`) in one PR. */
export function addSkillPr(repoPath: string, source: string, pick?: { ref: string; paths: string[] }): Promise<Commands['add_skill_pr']['result']> {
  return call('add_skill_pr', { repoPath, source, ...pick });
}

/** HUB_ONLY: open a PR that changes `.taskcell/approver.json` (never writes the mode directly). */
export function setApproverMode(repoPath: string, mode: ApproverMode, confirmBelowBar?: boolean): Promise<ApproverModeChange> {
  return call('set_approver_mode', { repoPath, mode, ...(confirmBelowBar === true ? { confirmBelowBar } : {}) });
}

/** HUB_ONLY: add a task to a hub-board project; it runs as the caller. */
export function hubTaskCreate(repoPath: string, title: string, body: string, schedule: { blockedBy?: string[]; startDate?: string } = {}): Promise<{ id: string }> {
  return call('hub_task_create', { repoPath, title, body, ...schedule });
}

/** HUB_ONLY: ask the hub scheduler to start a todo hub-board task (within ~15 s, even with auto-run off). */
export function hubTaskStart(repoPath: string, id: string, flow?: string): Promise<{ id: string }> {
  return call('hub_task_start', { repoPath, id, ...(flow !== undefined ? { flow } : {}) });
}

/** HUB_ONLY: put a failed hub-board task back to todo. */
export function hubTaskRetry(repoPath: string, id: string, flow?: string): Promise<{ id: string }> {
  return call('hub_task_retry', { repoPath, id, ...(flow !== undefined ? { flow } : {}) });
}

/** HUB_ONLY: set a hub-board task's dependencies and start date (`null` clears it). */
export function hubTaskSchedule(repoPath: string, id: string, patch: { blockedBy?: string[]; startDate?: string | null }): Promise<{ id: string }> {
  return call('hub_task_schedule', { repoPath, id, ...patch });
}

/** Hub-only, read-only: what the caller may do on the hub and, with `repoPath`, on that project. Every UI gate reads this. */
export function callerCapabilities(repoPath?: string): Promise<CallerCapabilities> {
  return call('caller_capabilities', repoPath === undefined ? undefined : { repoPath });
}
