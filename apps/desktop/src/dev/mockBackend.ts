import { DEMO_READ_ONLY_MESSAGE } from '../errors';
import type { BoardTask, Commands, NeedsYouItem, RepoLesson, RunDetail, RunSummary } from '../wire';
import { fixtureOutcome, withOutcome } from './fixtureOutcome';
import { stationOf } from '../stations';
import {
  projects,
  runs,
  runDetail,
  activeRuns,
  queuedRuns,
  session,
  appConfig,
  remoteRuns,
  boardTasks,
  capabilities,
  repoFlows,
  repoProviders,
  flowDoc,
  createdTask,
  dirListing,
  remoteImport,
  needsYouItems,
  factoryPlan,
  factoryApplyResult,
  factoryVerify,
  factoryStateNone,
  factoryStateSettingUp,
  taskSpecs,
  minsAgo,
} from './fixtures';
import { demoProject, demoRuns, demoRunDetails, demoActiveRuns, demoBoardTasks, demoFactoryState, demoLessonsFor, demoNeedsYou, demoRunBacklog, demoSession, demoSpec, DEMO_REPO_PATH, DEMO_RUN_ID, DEMO_REFUSED_WRITES } from './demoData';

let waitingNeedsYou = [...needsYouItems];
let mockLessons: RepoLesson[] = [
  { id: 'l1', rule: 'Add a test for every new link.', why: 'Links shipped untested.', evidence: 'https://github.com/acme/app/pull/12', paths: ['apps/desktop/**'], stage: 'review', prNumber: 12, timestamp: minsAgo(60 * 24 * 3) },
];

const READ_DRAFT = JSON.stringify({ id: 'draft-001', title: 'Draft task', body: 'Some draft content here.' });

/**
 * Fixture backend for the browser dev build, typed against the wire catalogue (S7): every key must
 * name a command, and every handler must return THAT command's result shape — a fixture that drifts
 * from the real backend's payload is a `tsc` error here (see mockBackend.test.ts for the exact
 * error a wrong return type produces), not a UI that renders convincingly against a shape no
 * backend sends. `Partial` because a browser build may legitimately stub only part of the surface;
 * the coverage guard in mockBackend.test.ts is what requires every command ipc.ts calls.
 *
 * Handlers take their args as `| undefined`: the caller's args arrive as sent, and the
 * wrappers in ipc.ts omit the record entirely for no-arg commands.
 */
const mockStamp = (): { repoPath: string; repoName: string } => ({ repoPath: projects[0]!.path, repoName: projects[0]!.name });

const detailWithOutcome = (d: RunDetail, rows: readonly RunSummary[]): RunDetail => {
  const row = rows.find((r) => r.taskId === d.taskId && r.timestamp === d.timestamp);
  return row === undefined ? d : { ...d, outcome: fixtureOutcome(row) };
};
/** A card's view: its column's place, its newest run's word and address, its waiting item. */
const withView = <T extends BoardTask>(t: T, rows: readonly RunSummary[], waiting: readonly NeedsYouItem[]): T => {
  const run = rows.find((r) => r.taskId === t.id);
  const item = waiting.find((i) => i.kind === 'card' && i.id === t.id);
  return { ...t, view: { place: stationOf(t), ...(run !== undefined ? { run: { ...fixtureOutcome(run), timestamp: run.timestamp, ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}) } } : {}), ...(item !== undefined ? { waiting: item } : {}) } };
};

const mockTeam = { id: 'default', name: 'Default', members: [{ login: 'you', role: 'admin' as const }], repositories: [] as string[] };

const commandHandlers = {
  list_runs: () => runs.map(withOutcome),
  conflict_stats: () => ({ weeks: [], total: { merges: 0, conflicts: 0, autoResolved: 0, leftForHuman: 0 }, topFiles: [] }),
  list_runs_all: () => ({ runs: runs.map((r) => ({ ...withOutcome(r), ...mockStamp() })), failures: [] }),
  read_run: () => detailWithOutcome(runDetail, runs),
  // The live demo run's log: the typed-run backlog, one second apart ending now.
  read_run_events: () => {
    const events = demoRunBacklog.map((b, i) => ({ id: i + 1, ts: new Date(Date.now() - (demoRunBacklog.length - i) * 1000).toISOString(), event: 'api:event', data: b }));
    return { events, nextAfter: events.length, hasMore: false, truncated: false };
  },
  read_cost_breakdown: (args: unknown) => ({
    status: 'no-branch' as const, branch: 'taskcell-metrics', period: (args as { period?: 'all' } | undefined)?.period ?? 'all',
    hint: 'Run `taskcell metrics push` from your CI workflow (it writes the taskcell-metrics branch) and CI runs will show up here.',
    costKind: 'unknown' as const, runs: 0, totalCostUsd: 0, unknownEntries: 0, byModel: [], byStage: [],
  }),
  read_approver_scorecard: (args: unknown) => ({
    status: 'no-data' as const, period: (args as { period?: '90d' } | undefined)?.period ?? '90d',
    hint: 'No approver decisions on the metrics branch yet.', mode: 'off' as const, policyFound: false, actOffered: false, threshold: 30,
    judged: 0, approves: 0, escalates: 0, approvesRight: 0, approvesWrong: 0, approvesPending: 0, barMet: false, byRiskClass: [], topReasons: [],
  }),
  read_approver_decisions: () => ({ decisions: [], mode: 'shadow' }),
  set_approver_mode: (args: { mode?: 'off' | 'shadow' | 'act' } | undefined) => ({ branch: 'taskcell/approver-mode', prUrl: 'https://github.com/acme/widgets/pull/1', mode: args?.mode ?? 'off' }),
  list_projects: () => projects,
  list_teams: () => [{ ...mockTeam, repositories: projects.map((p) => p.path) }],
  team_role: () => 'admin' as const,
  // The dev mock is the hub owner on a loopback bind: everything is allowed.
  caller_capabilities: (args: { repoPath?: string } | undefined) => {
    const yes = { allowed: true };
    return {
      mutationsAllowed: true, owner: true, admin: true, canAddProject: yes, teamRoles: { default: 'admin' as const },
      ...(args?.repoPath !== undefined ? { project: { teamRole: 'admin' as const, canReply: yes, canMerge: yes, canEnableFactory: yes, canCreateTask: yes, canStartTask: yes, canChangeSettings: yes, canUpdateSkill: yes, canEditSkills: yes } } : {}),
    };
  },
  add_team_member: () => mockTeam,
  remove_team_member: () => mockTeam,
  add_team_repository: () => mockTeam,
  remove_team_repository: () => mockTeam,
  add_project: (args: { path?: string } | undefined) => {
    const { path = '/dev/null' } = args ?? {};
    return [
      ...projects,
      { path, name: path.split('/').pop() ?? 'new-project', runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 },
    ];
  },
  remove_project: (args: { path?: string } | undefined) => {
    const { path } = args ?? {};
    return projects.filter((p) => p.path !== path);
  },
  list_active: () => activeRuns,
  read_session: () => session,
  read_app_config: () => appConfig,
  read_app_config_strict: () => appConfig,
  write_app_config: () => undefined,
  setup_status: () => ({ tools: [{ id: 'gh', state: 'ready' }, { id: 'glab', state: 'missing' }, { id: 'linear', state: 'needs-login' }], models: { claude: false, codex: false } }),
  list_remote_runs: () => remoteRuns,
  import_remote_run: (args: { runId?: number } | undefined) => {
    const { runId = remoteImport.runId } = args ?? {};
    return { ...remoteImport, runId };
  },
  list_tasks: () => ({ tasks: boardTasks.map((t) => withView(t, runs, waitingNeedsYou)), capped: false }),
  list_tasks_all: () => ({ tasks: boardTasks.map((t) => ({ ...withView(t, runs, waitingNeedsYou), ...mockStamp() })), capped: false, failures: [] }),
  fetch_spec: (args: { taskId?: string } | undefined) => ({ spec: taskSpecs[args?.taskId ?? ''] ?? taskSpecs['LINEAR-123']! }),
  list_spawns: () => [],
  spawn_run: () => 42,
  kill_run: () => undefined,
  watch_project: () => undefined,
  unwatch_project: () => undefined,
  api_capabilities: () => capabilities,
  api_create_run: () => ({ prUrl: undefined, secretBlocked: false }),
  api_complete: () => ({ text: 'Here is my analysis of the requested change. The implementation looks sound.' }),
  api_cancel_complete: () => undefined,
  api_create_task: () => createdTask,
  api_create_tasks: () => ({ tasks: [createdTask] }),
  list_branches: () => ({ branches: ['dev', 'main'], default: 'main' }),
  list_skills: () => ({ skills: ['code-review', 'ponytail', 'simplify'] }),
  set_task_skills: (args: { skills?: string[] } | undefined) => ({ skills: args?.skills ?? [] }),
  list_drafts: () => ['draft-001'],
  read_draft: () => READ_DRAFT,
  write_draft: () => undefined,
  delete_draft: () => undefined,
  // Editor UX 7/7 (composer attachments + mentions).
  api_list_repo_files: () => ({
    files: ['src/App.tsx', 'src/main.tsx', 'apps/desktop/README.md', 'package.json'],
    capped: false,
  }),
  api_read_repo_file: (args: { path?: string } | undefined) => {
    const { path = 'src/App.tsx' } = args ?? {};
    return { path, content: `// mock content of ${path}\nexport const answer = 42;\n`, truncated: false };
  },
  write_draft_asset: (args: { id?: string; name?: string } | undefined) => {
    const { id = 'draft-001', name = 'pic.png' } = args ?? {};
    return `/mock/.taskcell/drafts/${id}-assets/${name}`;
  },
  clear_draft_assets: () => undefined,
  api_list_flows: () => ({ flows: repoFlows }),
  api_list_providers: () => ({ providers: repoProviders }),
  api_read_flow: () => ({ doc: flowDoc, source: 'flow "plan-implement-review" {\n  label = "Plan → Implement → Review"\n\n  stage "planner" {}\n  stage "implement" { max_turns = 40 }\n  stage "reviewer" {}\n}\n' }),
  api_write_flow: () => ({ source: '' }),
  api_delete_flow: () => undefined,
  api_active_run: () => null,
  api_run_backlog: () => [],
  api_queue: () => queuedRuns,
  api_cancel: () => undefined,
  api_repo_ok: () => true,
  // The dev mock needs a fixture so RepoPicker is drivable, and so the ipc.ts coverage guard passes.
  browse_dirs: () => dirListing,
  clone_project: (args: { url?: string; name?: string } | undefined) => ({
    ...projects[0]!,
    path: `/mock/clones/${args?.name ?? 'repo'}`,
    name: args?.name ?? 'repo',
    runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0,
  }),
  read_audit: () => [
    { time: minsAgo(30), login: 'token', action: 'run-start', target: 'run-0', outcome: 'ok' },
  ],
  read_settings_history: () => [
    { time: minsAgo(60), login: 'you', outcome: 'ok', detail: ['budgetUsd', 'verifyCmd'], target: '/mock/repo', changes: [{ key: 'budgetUsd', from: '5', to: '8' }] },
  ],
  list_chat_models: () => ({ source: 'static', models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }),
  list_activity: () => [
    { time: minsAgo(15), kind: 'pr-merged', repoPath: '/mock/repo', repoName: 'repo', login: 'you', subject: '#12' },
    { time: minsAgo(60), kind: 'settings-changed', repoPath: '/mock/repo', repoName: 'repo', login: 'you', keys: ['budgetUsd', 'verifyCmd'] },
  ],
  read_issue_history: () => ({ repo: 'acme/app', issue: 1, prs: [], entries: [], chains: [], unavailable: [] }),
  list_needs_you: () => ({ items: waitingNeedsYou }),
  needs_you_comment: () => ({}),
  list_lessons: () => ({ lessons: mockLessons, branchFound: true }),
  list_repo_skills: () => ({ skills: [] }),
  update_skill_pr: () => ({ prUrl: 'https://github.com/acme/app/pull/1' }),
  add_skill_pr: () => ({ prUrl: 'https://github.com/acme/app/pull/1' }),
  discover_skills: () => ({ commit: 'c'.repeat(40), skills: [{ path: 'skills/demo', name: 'demo' }] }),
  list_pending_skill_prs: () => ({ prs: [] }),
  pull_checkout: () => ({ updated: false }),
  remove_skill_pr: () => ({ prUrl: 'https://github.com/acme/app/pull/1' }),
  dismiss_lesson: (args: { id?: string } | undefined) => {
    mockLessons = mockLessons.filter((l) => l.id !== args?.id);
  },
  list_needs_you_all: () => ({ items: waitingNeedsYou.map((i) => ({ ...i, ...mockStamp() })), failures: [] }),
  // A reply hands the item back to the factory (issue: trigger label; PR: `needs revision`), so it
  // drops out of the next list for either kind — as on a real repo.
  reply_needs_you: (args: { id?: string } | undefined) => {
    waitingNeedsYou = waitingNeedsYou.filter((i) => i.id !== args?.id);
  },
  rereview_pr: () => undefined,
  merge_needs_you: (args: { id?: string } | undefined) => {
    waitingNeedsYou = waitingNeedsYou.filter((i) => i.id !== args?.id);
  },
  retry_paused_task: () => ({ label: 'ready for agent' }),
  hub_task_schedule: (args: { id?: string } | undefined) => ({ id: args?.id ?? 'hub-1' }),
  hub_task_create: () => ({ id: 'hub-1' }),
  hub_task_accept: (args: { id?: string } | undefined) => ({ id: args?.id ?? 'hub-1' }),
  hub_task_archive: (args: { id?: string } | undefined) => ({ id: args?.id ?? 'hub-1' }),
  hub_task_delete: (args: { id?: string } | undefined) => ({ id: args?.id ?? 'hub-1' }),
  hub_task_start: (args: { id?: string } | undefined) => ({ id: args?.id ?? 'hub-1' }),
  hub_task_retry: (args: { id?: string } | undefined) => ({ id: args?.id ?? 'hub-1' }),
  start_task: (args: { label?: string } | undefined) => ({ status: 'labelled', label: args?.label ?? 'ready for agent', waitingOn: [] }),
  // Hub-only Enable factory flow (EnableFactoryDialog).
  enable_factory_host: () => ({ host: 'github' as const }),
  enable_factory_watch: () => ({ repoSlug: 'acme/widgets', source: 'github' as const, compose: 'services:\n  taskcell-watch: {}', command: 'taskcell watch --source=github', credentials: ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'], seen: 'unknown' as const }),
  local_worker_state: () => ({ enabled: false, source: 'github' as const, credentials: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], present: true } }),
  local_worker_set: (args: { enabled?: boolean } | undefined) => ({ enabled: args?.enabled === true, source: 'github' as const, credentials: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], present: true } }),
  local_worker_doctor: () => ({ enabled: false, source: 'github' as const, credentials: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], present: true }, doctor: { at: '2026-11-15T10:00:00.000Z', ok: true, failed: [] } }),
  enable_factory_plan: () => factoryPlan,
  enable_factory_apply: () => factoryApplyResult,
  enable_factory_verify: () => factoryVerify,
  enable_factory_start: () => factoryStateSettingUp,
  factory_state: () => factoryStateNone,
  factory_refresh: () => factoryStateSettingUp,
  // Hub-only per-user credentials (CredentialsPanel): the dev mock is a signed-in admin with none saved.
  user_credentials_status: () => ({ enabled: true, admin: true, names: [] as string[] }),
  save_user_credential: () => undefined,
  delete_user_credential: () => undefined,
  get_credential_policy: () => ({ policy: 'off' as const }),
  set_credential_policy: () => undefined,
  instance_credentials_status: () => ({ names: [] as string[] }),
  save_instance_credential: () => undefined,
  delete_instance_credential: () => undefined,
} satisfies Partial<{
  [K in keyof Commands]: (args: Commands[K]['args']) => Promise<Commands[K]['result']> | Commands[K]['result'];
}>;

/** Commands the fixtures deliberately do not answer: mobile-only or never sent by the UI. */
type Unmocked = 'agent_cli_versions' | 'enable_factory_secret' | 'migrate_labels' | 'register_push_token' | 'unregister_push_token' | 'get_team';

// The coverage guard, in the type system: a command added to the wire catalogue needs a fixture handler here (or a
// place in `Unmocked`), or this line stops compiling — screens call the session directly, so there is no wrapper list to scan.
const _everyCommandIsMocked: Exclude<keyof Commands, keyof typeof commandHandlers | Unmocked> extends never ? true : never = true;
void _everyCommandIsMocked;

// Commands dispatch by string name, so this is the one place the per-command arg types are erased.
const handlers = commandHandlers as Record<string, (args: unknown) => unknown>;

export const HANDLED_COMMANDS: readonly string[] = Object.keys(handlers);

/** Answer one command from the fixture table: the dev server's mock backend (transport.ts), and
 *  what a hub-mode test serves `POST /rpc/<cmd>` from. */
export function handle(cmd: string, args: unknown): unknown {
  const handler = handlers[cmd];
  if (handler) return handler(args);
  console.warn(`[mockBackend] unhandled IPC command: ${cmd}`);
  return undefined;
}

/** Demo-mode overrides (`hub --demo`, `?demo=1`): the one seeded project, served in-browser. Reads
 *  fall through to the fixtures above; every command that could write to a repo, remote or hub
 *  store is refused. */
const demoOverrides: Record<string, (args: unknown) => unknown> = {
  list_projects: () => [demoProject],
  list_teams: () => [{ ...mockTeam, repositories: [DEMO_REPO_PATH] }],
  list_runs: () => demoRuns.map(withOutcome),
  list_runs_all: () => ({ runs: demoRuns.map((r) => ({ ...withOutcome(r), repoPath: DEMO_REPO_PATH, repoName: demoProject.name })), failures: [] }),
  read_run: (args) => detailWithOutcome(demoRunDetails[(args as { taskId?: string } | undefined)?.taskId ?? ''] ?? demoRunDetails['DEMO-101']!, demoRuns),
  list_active: () => demoActiveRuns,
  list_tasks: () => ({ tasks: demoBoardTasks.map((t) => withView(t, demoRuns, demoNeedsYou)), capped: false }),
  list_tasks_all: () => ({ tasks: demoBoardTasks.map((t) => ({ ...withView(t, demoRuns, demoNeedsYou), repoPath: DEMO_REPO_PATH, repoName: demoProject.name })), capped: false, failures: [] }),
  list_needs_you: () => ({ items: demoNeedsYou }),
  list_needs_you_all: () => ({ items: demoNeedsYou.map((i) => ({ ...i, repoPath: DEMO_REPO_PATH, repoName: demoProject.name })), failures: [] }),
  list_remote_runs: () => [],
  api_active_run: () => ({ runId: DEMO_RUN_ID, repoPath: DEMO_REPO_PATH }),
  api_run_backlog: () => demoRunBacklog,
  fetch_spec: (args) => ({ spec: demoSpec((args as { taskId?: string } | undefined)?.taskId) }),
  list_repo_skills: () => ({ skills: [] }),
  list_lessons: (args) => ({ lessons: demoLessonsFor((args as { taskText?: string } | undefined)?.taskText), branchFound: true }),
  factory_state: () => demoFactoryState,
  // The live run's detail and its strip show one cost (`DEMO_LIVE_COST_USD`).
  read_session: () => demoSession,
  list_drafts: () => [],
  api_queue: () => [],
  api_repo_ok: () => true,
  read_app_config: () => ({ ...appConfig, label: 'storefront (demo)' }),
  read_app_config_strict: () => ({ ...appConfig, label: 'storefront (demo)' }),
  ...Object.fromEntries(
    DEMO_REFUSED_WRITES.map((cmd) => [cmd, (): never => { throw DEMO_READ_ONLY_MESSAGE; }]),
  ),
};

/** `handle` for demo mode: the overrides first, then the shared fixtures. */
export function handleDemo(cmd: string, args: unknown): unknown {
  const override = demoOverrides[cmd];
  return override ? override(args) : handle(cmd, args);
}
