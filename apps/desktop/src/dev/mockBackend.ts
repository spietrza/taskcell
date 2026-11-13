import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { Commands } from '../wire';
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
} from './fixtures';
import { demoProject, demoRuns, demoRunDetails, demoActiveRuns, demoBoardTasks, demoNeedsYou, DEMO_REPO_PATH, DEMO_WRITE_COMMANDS } from './demoData';

let waitingNeedsYou = [...needsYouItems];

const READ_DRAFT = JSON.stringify({ id: 'draft-001', title: 'Draft task', body: 'Some draft content here.' });

/**
 * Fixture backend for the browser dev build, typed against the wire catalogue (S7): every key must
 * name a command, and every handler must return THAT command's result shape — a fixture that drifts
 * from the real backend's payload is a `tsc` error here (see mockBackend.test.ts for the exact
 * error a wrong return type produces), not a UI that renders convincingly against a shape no
 * backend sends. `Partial` because a browser build may legitimately stub only part of the surface;
 * the coverage guard in mockBackend.test.ts is what requires every command ipc.ts calls.
 *
 * Handlers take their args as `| undefined`: mockIPC passes whatever the caller sent, and the
 * wrappers in ipc.ts omit the record entirely for no-arg commands.
 */
const mockStamp = (): { repoPath: string; repoName: string } => ({ repoPath: projects[0]!.path, repoName: projects[0]!.name });

const mockTeam = { id: 'default', name: 'Default', members: [{ login: 'you', role: 'admin' as const }], repositories: [] as string[] };

const commandHandlers = {
  list_runs: () => runs,
  list_runs_all: () => ({ runs: runs.map((r) => ({ ...r, ...mockStamp() })), failures: [] }),
  read_run: () => runDetail,
  list_projects: () => projects,
  list_teams: () => [{ ...mockTeam, repositories: projects.map((p) => p.path) }],
  team_role: () => 'admin' as const,
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
  get_credentials: () => ({ enabled: false, reason: 'VANGUARD_HUB_SECRET is not set', providers: [] }),
  setup_status: () => ({ tools: [{ id: 'gh', state: 'ready' }, { id: 'glab', state: 'missing' }, { id: 'linear', state: 'needs-login' }], models: { claude: false, codex: false } }),
  set_credential: () => ({ enabled: false, providers: [] }),
  delete_credential: () => ({ enabled: false, providers: [] }),
  list_remote_runs: () => remoteRuns,
  import_remote_run: (args: { runId?: number } | undefined) => {
    const { runId = remoteImport.runId } = args ?? {};
    return { ...remoteImport, runId };
  },
  list_tasks: () => ({ tasks: boardTasks, capped: false }),
  list_tasks_all: () => ({ tasks: boardTasks.map((t) => ({ ...t, ...mockStamp() })), capped: false, failures: [] }),
  fetch_spec: () => ({ spec: '## Task\n\nFix the login bug when the JWT token expires after inactivity.\n\n**Acceptance criteria:**\n- [ ] Login still works after token refresh\n- [ ] Tests pass\n- [ ] No regressions in the auth flow\n' }),
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
  list_branches: () => ({ branches: ['dev', 'main'], default: 'main' }),
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
  // Hub-only command (apps/desktop never reaches it through Tauri, but the browser dev build —
  // no Tauri runtime, hub marker absent — still needs a fixture so RepoPicker is drivable via the
  // mock backend, and so the ipc.ts coverage guard below passes).
  browse_dirs: () => dirListing,
  clone_project: (args: { url?: string; name?: string } | undefined) => ({
    ...projects[0]!,
    path: `/mock/clones/${args?.name ?? 'repo'}`,
    name: args?.name ?? 'repo',
    runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0,
  }),
  read_audit: () => [
    { time: '2026-07-06T19:12:02.123Z', login: 'token', action: 'run-start', target: 'run-0', outcome: 'ok' },
  ],
  read_issue_history: () => ({ repo: 'acme/app', issue: 1, prs: [], entries: [], chains: [], unavailable: [] }),
  list_needs_you: () => ({ items: waitingNeedsYou }),
  list_needs_you_all: () => ({ items: waitingNeedsYou.map((i) => ({ ...i, ...mockStamp() })), failures: [] }),
  // A reply hands the item back to the factory (issue: trigger label; PR: `needs revision`), so it
  // drops out of the next list for either kind — as on a real repo.
  reply_needs_you: (args: { id?: string } | undefined) => {
    waitingNeedsYou = waitingNeedsYou.filter((i) => i.id !== args?.id);
  },
  merge_needs_you: (args: { id?: string } | undefined) => {
    waitingNeedsYou = waitingNeedsYou.filter((i) => i.id !== args?.id);
  },
  start_task: (args: { label?: string } | undefined) => ({ status: 'labelled', label: args?.label ?? 'ready for agent', waitingOn: [] }),
  // Hub-only Enable factory flow (EnableFactoryDialog).
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

/** Tauri PLUGIN ipc the webview also makes (dialog, event) — not wire commands, so they sit outside
 * the catalogue-checked map above. */
const pluginHandlers = {
  'plugin:dialog|open': () => '/home/user/projects/new-project',
  'plugin:event|listen': () => 1,
  'plugin:event|unlisten': () => null,
};

// mockIPC dispatches by string name, so this is the one place the per-command arg types are erased.
const handlers = { ...commandHandlers, ...pluginHandlers } as Record<string, (args: unknown) => unknown>;

export const HANDLED_COMMANDS: readonly string[] = Object.keys(handlers);

/** Answer one command from the fixture table. Exposed so a hub-mode test can serve
 *  `POST /rpc/<cmd>` from the same fixtures `install()` serves over Tauri. */
export function handle(cmd: string, args: unknown): unknown {
  const handler = handlers[cmd];
  if (handler) return handler(args);
  console.warn(`[mockBackend] unhandled IPC command: ${cmd}`);
  return undefined;
}

export function install(): void {
  mockWindows('main');
  mockIPC(handle);
}

/** Demo-mode overrides (`hub --demo`, `?demo=1`): the one seeded project, served in-browser. Reads
 *  fall through to the fixtures above; every command that could write to a repo, remote or hub
 *  store is refused. */
const demoOverrides: Record<string, (args: unknown) => unknown> = {
  list_projects: () => [demoProject],
  list_teams: () => [{ ...mockTeam, repositories: [DEMO_REPO_PATH] }],
  list_runs: () => demoRuns,
  list_runs_all: () => ({ runs: demoRuns.map((r) => ({ ...r, repoPath: DEMO_REPO_PATH, repoName: demoProject.name })), failures: [] }),
  read_run: (args) => demoRunDetails[(args as { taskId?: string } | undefined)?.taskId ?? ''] ?? demoRunDetails['DEMO-101'],
  list_active: () => demoActiveRuns,
  list_tasks: () => ({ tasks: demoBoardTasks, capped: false }),
  list_tasks_all: () => ({ tasks: demoBoardTasks.map((t) => ({ ...t, repoPath: DEMO_REPO_PATH, repoName: demoProject.name })), capped: false, failures: [] }),
  list_needs_you: () => ({ items: demoNeedsYou }),
  list_needs_you_all: () => ({ items: demoNeedsYou.map((i) => ({ ...i, repoPath: DEMO_REPO_PATH, repoName: demoProject.name })), failures: [] }),
  list_remote_runs: () => [],
  api_active_run: () => ({ runId: 'demo-run-1', repoPath: DEMO_REPO_PATH }),
  api_queue: () => [],
  api_repo_ok: () => true,
  read_app_config: () => ({ ...appConfig, label: 'storefront (demo)' }),
  read_app_config_strict: () => ({ ...appConfig, label: 'storefront (demo)' }),
  ...Object.fromEntries(
    DEMO_WRITE_COMMANDS.map((cmd) => [cmd, (): never => { throw 'Demo project is read-only — nothing is written to any repository.'; }]),
  ),
};

/** `handle` for demo mode: the overrides first, then the shared fixtures. */
export function handleDemo(cmd: string, args: unknown): unknown {
  const override = demoOverrides[cmd];
  return override ? override(args) : handle(cmd, args);
}
