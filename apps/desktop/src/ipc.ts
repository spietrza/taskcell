import { invoke } from './transport';
import type { Team, TeamRole } from './wire';
import type {
  RunSummary,
  RunDetail,
  Project,
  ActiveRun,
  SessionRead,
  RemoteRun,
  RemoteImport,
  RunRef,
  DirListing,
  AppConfig,
} from './taskcell-output';
import type {
  BoardTask,
  Commands,
  CompleteResponse,
  CredentialProvider,
  CredentialsSummary,
  CredentialPolicy,
  FactoryApplyResult,
  FactoryPlan,
  FactoryProviderId,
  FactorySecretStep,
  FactoryVerifyResult,
  NeedsYouItem,
  SpawnInfo,
  StartTaskResult,
} from './wire';

export type { NeedsYouItem, RepoReadFailure, RepoStamp } from './wire';

/**
 * The one typed seam over the transport (S7): `cmd` must name a command in the wire's `Commands`
 * catalogue, and its args/result are that command's — so a renamed field, a forgotten argument or a
 * wrapper that claims the wrong result shape is a `tsc` error here instead of a runtime surprise in
 * whichever backend answers (Tauri, hub, or dev/mockBackend.ts).
 *
 * The cast is the single place the per-command arg type is erased: `invoke` dispatches by string
 * name and takes a plain record, exactly like Rust's `invoke` and the hub's `POST /rpc/<cmd>`.
 */
function call<K extends keyof Commands>(cmd: K, args: Commands[K]['args']): Promise<Commands[K]['result']> {
  return invoke<Commands[K]['result']>(cmd, args as Record<string, unknown> | undefined);
}

/** The optional team scope of the hub's list commands: no id = the server's default. */
const teamArgs = (teamId?: string): { teamId: string } | undefined => (teamId === undefined ? undefined : { teamId });

export function listRuns(repoPath: string): Promise<RunSummary[]> {
  return call('list_runs', { repoPath });
}

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

/** Hub-only: a native-dialog stand-in (src/hub/browse.ts) — lists `path`'s subdirectories, confined
 * to the hub's browse root, for `RepoPicker`. `path` omitted lists the root itself. */
export function browseDirs(path?: string): Promise<DirListing> {
  return call('browse_dirs', { path });
}

export function listProjects(teamId?: string): Promise<Project[]> {
  return call('list_projects', teamArgs(teamId));
}

export function addProject(path: string): Promise<Project[]> {
  return call('add_project', { path });
}

/** Hub-only: clone `url` under `parentDir` (the same browse-root-confined picker as `browseDirs`)
 *  and register the result, returning just the new project (not the whole list — the caller appends
 *  it, like `cloneProject`'s RepoPicker caller does). */
export function cloneProject(url: string, parentDir: string, name?: string): Promise<Project> {
  return call('clone_project', { url, parentDir, name });
}

// Enable factory (hub-only): plan -> apply (branch + PR, never the default branch) -> secret
// command text for the user to run -> verify (dispatch the doctor workflow). See src/hub/enable-factory.ts.
export function enableFactoryPlan(repoPath: string, provider: FactoryProviderId): Promise<FactoryPlan> {
  return call('enable_factory_plan', { repoPath, provider });
}

export function enableFactoryApply(repoPath: string, plan: FactoryPlan): Promise<FactoryApplyResult> {
  return call('enable_factory_apply', { repoPath, plan });
}

/** Command text only — the hub never reads, prints or stores the secret value. */
export function enableFactorySecret(repoPath: string, plan: FactoryPlan): Promise<FactorySecretStep> {
  return call('enable_factory_secret', { repoPath, plan });
}

export function enableFactoryVerify(repoPath: string, plan: FactoryPlan): Promise<FactoryVerifyResult> {
  return call('enable_factory_verify', { repoPath, plan });
}

/** Hub-only, admin-only (403 otherwise): the audit log, newest first. */
export function readAudit(login?: string): Promise<AuditEntry[]> {
  return call('read_audit', { login });
}

/** Hub-only: one issue's history over the audit streams, run records and Git host events. */
export function readIssueHistory(repoPath: string, issue: number): Promise<Commands['read_issue_history']['result']> {
  return call('read_issue_history', { repoPath, issue });
}

export function removeProject(path: string): Promise<Project[]> {
  return call('remove_project', { path });
}

/** Hub-only: the "Needs you" read model (src/hub/needs-you.ts) — items waiting on a human, gh/labels
 *  only, no model call. Empty on a project with no GitHub remote. */
export function listNeedsYou(repoPath: string): Promise<{ items: NeedsYouItem[] }> {
  return call('list_needs_you', { repoPath });
}

/** HUB_ONLY: `listNeedsYou` for every repository. */
export function listNeedsYouAll(teamId?: string): Promise<Commands['list_needs_you_all']['result']> {
  return call('list_needs_you_all', teamArgs(teamId));
}

/** Hub-only: post `body` as the caller's own comment on the item, then move it on (issue: `needs
 *  info` -> `ready for agent`; PR: adds `needs revision`). Throws with no label change when the item
 *  is no longer in a waiting state. */
export function replyNeedsYou(repoPath: string, id: string, kind: 'issue' | 'pr', body: string): Promise<void> {
  return call('reply_needs_you', { repoPath, id, kind, body });
}

/** Hub-only: merge a waiting PR. Throws with a UI-ready message when it is not in "Needs you" or
 *  its required checks are not green. */
export function mergeNeedsYou(repoPath: string, id: string): Promise<void> {
  return call('merge_needs_you', { repoPath, id });
}

/** Hub-only: apply a trigger label to a GitHub issue of the project (src/hub/start-task.ts). Throws
 *  on a non-trigger label, a closed or already-started issue, or a non-GitHub project. */
export function startTask(repoPath: string, number: number, label: string): Promise<StartTaskResult> {
  return call('start_task', { repoPath, number, label });
}

export function listActive(repoPath: string): Promise<ActiveRun[]> {
  return call('list_active', { repoPath });
}

export function readSession(sessionFile: string): Promise<SessionRead> {
  return call('read_session', { sessionFile });
}

export function readAppConfig(repoPath: string): Promise<AppConfig> {
  return call('read_app_config', { repoPath });
}

/** Settings' read (S6 guard b): rejects when app.json exists but does not parse — the passive
 *  readAppConfig collapses that to defaults, which is right for chat/board and WRONG for a form
 *  that will write the whole object back. */
export function readAppConfigStrict(repoPath: string): Promise<AppConfig> {
  return call('read_app_config_strict', { repoPath });
}

export function getCredentials(): Promise<CredentialsSummary> {
  return call('get_credentials', undefined);
}

export function setCredential(provider: CredentialProvider, value: string): Promise<CredentialsSummary> {
  return call('set_credential', { provider, value });
}

export function deleteCredential(provider: CredentialProvider): Promise<CredentialsSummary> {
  return call('delete_credential', { provider });
}

export function writeAppConfig(repoPath: string, config: AppConfig): Promise<void> {
  return call('write_app_config', { repoPath, config });
}

export function listRemoteRuns(repoPath: string): Promise<RemoteRun[]> {
  return call('list_remote_runs', { repoPath });
}

/** Import a CI run's record artifact (once; a cache hit skips `gh`) and group it into run summaries.
 *  Both backends implement it — the desktop caches under the app config dir, the hub under the
 *  project's `.taskcell/remote-runs/<id>`. Open one with `readRun(project, { source: { kind: 'ci',
 *  runId }, … })`: the root stays on whichever side imported it. */
export function importRemoteRun(repoPath: string, runId: number): Promise<RemoteImport> {
  return call('import_remote_run', { repoPath, runId });
}

/** Board read path (S9): served by core over the sidecar query pipe; capped drives the banner. */
export function listTasks(repoPath: string): Promise<{ tasks: BoardTask[]; capped: boolean }> {
  return call('list_tasks', { repoPath });
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

export function listSpawns(): Promise<SpawnInfo[]> {
  return call('list_spawns', undefined);
}

/** Spawn `argv` (program first) in `cwd` without a shell — see `spawn_run` in the wire catalogue. */
export function spawnRun(cwd: string, argv: string[]): Promise<number> {
  return call('spawn_run', { cwd, argv });
}

export function killRun(pid: number): Promise<void> {
  return call('kill_run', { pid });
}

export function watchProject(repoPath: string): Promise<void> {
  return call('watch_project', { repoPath });
}

export function unwatchProject(repoPath: string): Promise<void> {
  return call('unwatch_project', { repoPath });
}

// Typed core API over the `vanguard __sidecar` child (no stdout scraping). Run events arrive on the
// `api:event` Tauri channel — subscribe with `listen('api:event', …)` where the run UI needs them
// (that consumption is Subsystem 1; this only exposes the wrappers).
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
import type { AuditEntry, Capabilities, CreateRunParams, CreateRunResult, FlowDoc, RepoFlowInfo, RepoProviderInfo, CompleteCallArgs } from './wire';

export function apiCapabilities(): Promise<Capabilities> {
  return call('api_capabilities', undefined);
}

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
  capsCache ??= apiCapabilities().catch((err: unknown) => {
    capsCache = undefined;
    throw err;
  });
  return capsCache;
}

export function apiCreateRun(params: CreateRunParams): Promise<CreateRunResult> {
  return call('api_create_run', { params });
}

/**
 * Doc-editor chat completion (Subsystem 3). One-shot spawn, never the run mutex.
 *
 * No `baseUrl` here on purpose: the completion runs with the inherited Anthropic credential, so a
 * caller-supplied base URL would be a way for anything running in the webview to redirect that token
 * to a host of its choosing. Rust reads `chatBaseUrl` from `app.json` itself — hence `repoPath`.
 *
 * `req` is wire's `CompleteCallArgs`: an ALLOWLIST, deliberately not `Omit<CompleteRequest, …>` —
 * every field in it is one the renderer is permitted to send, so a new `CompleteRequest` field must
 * be added there to cross the webview boundary (a denylist would auto-expose it — review #342).
 */
export function apiComplete(
  repoPath: string,
  params: CompleteCallArgs,
  // Opaque per-turn handle. When present, Rust tracks the spawned `__complete` child under it so
  // `apiCancelComplete(callId)` can kill exactly this turn (the Stop button). Omitted for
  // fire-and-forget completions (the auto-title) that are never cancelled.
  callId?: string,
): Promise<CompleteResponse> {
  return call('api_complete', { repoPath, req: params, callId });
}

/**
 * Stop an in-flight doc-chat completion (Editor UX 5/7): kill the `__complete` child that
 * `apiComplete` spawned for this `callId`. Kill-by-id is the whole surface — it cannot touch the run
 * sidecar. An unknown/finished id is a silent no-op.
 */
export function apiCancelComplete(callId: string): Promise<void> {
  return call('api_cancel_complete', { callId });
}

/**
 * Create a task on the configured transport. The app's first WRITE to an external system, and it cannot
 * be undone from here — so the caller must confirm first, and it must never fire as a side effect.
 *
 * Only title/body cross: `source`, `team` and `label` are read from app.json in Rust. The renderer does
 * not choose which tracker gets written to. (Same rule as CompleteCallArgs — and it matters more here.)
 */
export function apiCreateTask(repoPath: string, title: string, body: string, baseBranch?: string): Promise<import('./wire').CreatedTask> {
  return call('api_create_task', { repoPath, title, body, ...(baseBranch !== undefined ? { baseBranch } : {}) });
}

/** HUB_ONLY: the target branches a card may name and the configured default, for the new-card form. */
export function apiListBranches(repoPath: string): Promise<{ branches: string[]; default?: string }> {
  return call('list_branches', { repoPath });
}

/** Composer `@`-mention autocomplete (Editor UX 7/7): the project repo's tracked files, capped. */
export function apiListRepoFiles(repoPath: string): Promise<{ files: string[]; capped: boolean }> {
  return call('api_list_repo_files', { repoPath });
}

/** Read one tracked file for mention inlining (Editor UX 7/7); `path` is repo-relative, capped read. */
export function apiReadRepoFile(repoPath: string, path: string): Promise<{ path: string; content: string; truncated: boolean }> {
  return call('api_read_repo_file', { repoPath, path });
}

/** Persist a pasted image under the draft's assets dir (Editor UX 7/7); returns its absolute path. */
export function writeDraftAsset(repoPath: string, id: string, name: string, bytes: Uint8Array): Promise<string> {
  return call('write_draft_asset', { repoPath, id, name, bytes: Array.from(bytes) });
}

/** Remove a draft's pasted-image assets dir (keeping the JSON) when the draft is filed (Editor UX 7/7). */
export function clearDraftAssets(repoPath: string, id: string): Promise<void> {
  return call('clear_draft_assets', { repoPath, id });
}

// Task drafts (S10): one JSON file per draft under `.taskcell/drafts/`; the webview owns the shape
// (see features/task/draftStore.ts), Rust is dumb storage.
export function listDrafts(repoPath: string): Promise<string[]> {
  return call('list_drafts', { repoPath });
}
export function readDraft(repoPath: string, id: string): Promise<string> {
  return call('read_draft', { repoPath, id });
}
export function writeDraft(repoPath: string, id: string, content: string): Promise<void> {
  return call('write_draft', { repoPath, id, content });
}
export function deleteDraft(repoPath: string, id: string): Promise<void> {
  return call('delete_draft', { repoPath, id });
}

// Flow-file editing (S5). Types now come from the generated wire (S7).
export function apiListFlows(repoPath: string): Promise<{ flows: RepoFlowInfo[] }> {
  return call('api_list_flows', { repoPath });
}

/** Fresh per mount, like apiListFlows — a provider saved in Settings must be runnable immediately. */
export function apiListProviders(repoPath: string): Promise<{ providers: RepoProviderInfo[] }> {
  return call('api_list_providers', { repoPath });
}

/** `source` is the raw file bytes on read; the canonical form appears only after a write. */
export function apiReadFlow(repoPath: string, file: string): Promise<{ doc: FlowDoc; source: string }> {
  return call('api_read_flow', { repoPath, file });
}

export function apiWriteFlow(repoPath: string, file: string, doc: FlowDoc): Promise<{ source: string }> {
  return call('api_write_flow', { repoPath, file, doc });
}

/** Delete one flow file (S8). Idempotent — an already-deleted file succeeds. */
export function apiDeleteFlow(repoPath: string, file: string): Promise<void> {
  return call('api_delete_flow', { repoPath, file });
}

/** The in-flight typed run `{runId, repoPath}`, or null when idle. repoPath scopes re-attach to
 *  the owning project (S8 — the sidecar is global, Inspectors are per-project). */
export function apiActiveRun(): Promise<{ runId: string; repoPath: string } | null> {
  return call('api_active_run', undefined);
}

/** Buffered `{ runId, event }` backlog for a run, for a re-attaching live strip. */
export function apiRunBacklog(runId: string): Promise<unknown[]> {
  return call('api_run_backlog', { runId });
}

/** HUB_ONLY: runs waiting behind the active one, for a page that just (re)loaded — events alone
 * cannot reconstruct this for a client that wasn't listening when they were queued. */
export function apiQueue(): Promise<{ runId: string; repoPath: string; position: number }[]> {
  return call('api_queue', undefined);
}

/** Cancel one run: `runId` given cancels exactly that run (active or queued, hub-only for the
 * latter); omitted cancels the active run (out-of-band SIGUSR2 to the sidecar child on Tauri). */
export function apiCancel(runId?: string): Promise<void> {
  return call('api_cancel', { runId });
}

/** Click-time pre-flight: is `repoPath` a git work tree? */
export function apiRepoOk(repoPath: string): Promise<boolean> {
  return call('api_repo_ok', { repoPath });
}

// Per-user provider credentials (hub-only, write-only: status returns names, never values). The
// instance/policy calls are admin-only — the hub answers 403 to anyone else.
export function userCredentialsStatus(): Promise<{ enabled: boolean; admin: boolean; names: string[] }> {
  return call('user_credentials_status', undefined);
}

export function saveUserCredential(name: string, value: string): Promise<void> {
  return call('save_user_credential', { name, value });
}

export function deleteUserCredential(name: string): Promise<void> {
  return call('delete_user_credential', { name });
}

export function getCredentialPolicy(): Promise<{ policy: CredentialPolicy }> {
  return call('get_credential_policy', undefined);
}

export function setCredentialPolicy(policy: CredentialPolicy): Promise<void> {
  return call('set_credential_policy', { policy });
}

export function instanceCredentialsStatus(): Promise<{ names: string[] }> {
  return call('instance_credentials_status', undefined);
}

export function saveInstanceCredential(name: string, value: string): Promise<void> {
  return call('save_instance_credential', { name, value });
}

export function deleteInstanceCredential(name: string): Promise<void> {
  return call('delete_instance_credential', { name });
}

/** Hub-only: the teams the caller can see. */
export function listTeams(): Promise<Team[]> {
  return call('list_teams', undefined);
}

/** Hub-only: the caller's role in a team (`null` for a non-member). */
export function teamRole(id: string): Promise<TeamRole | null> {
  return call('team_role', { id });
}

export function teamAddMember(teamId: string, login: string, role: TeamRole): Promise<Team> {
  return call('add_team_member', { teamId, login, role });
}

/** `add_team_member` replaces an existing member's role; the team must keep an admin. */
export function teamSetRole(teamId: string, login: string, role: TeamRole): Promise<Team> {
  return call('add_team_member', { teamId, login, role });
}

export function teamRemoveMember(teamId: string, login: string): Promise<Team> {
  return call('remove_team_member', { teamId, login });
}

export function teamAddRepository(teamId: string, path: string): Promise<Team> {
  return call('add_team_repository', { teamId, path });
}

export function teamRemoveRepository(teamId: string, path: string): Promise<Team> {
  return call('remove_team_repository', { teamId, path });
}
