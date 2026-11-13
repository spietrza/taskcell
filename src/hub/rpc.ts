// POST /rpc/:cmd dispatch table. Every handler that takes a repoPath resolves it through
// ProjectAllowlist.assertAllowed first (src/hub/allowlist.ts) — see docs/hub.md and the tech spec's
// "New in slice 1: the repo allowlist" section for why this is pulled forward from wave 2.
import { execa } from 'execa';
import {
  BadRequestError,
  invokeCoreMethod,
  validateCoreMethod,
  classifyCoreError,
  type SidecarDeps,
  type CreateRunParams,
  type CreateTaskParams,
} from '../sidecar/sidecar.js';
import { ProjectAllowlist, assertGitWorkTreeDir, assertMutationsAllowed, type BindOptions } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import type { SpawnRegistry } from './spawn.js';
import type { RunSession } from './run-session.js';
import { CompleteRegistry, type CompleteParams } from './complete.js';
import { assertWithinBrowseRoot, browseDirs } from './browse.js';
import { cloneProject } from './clone.js';
import { listNeedsYou, mergeNeedsYou, replyNeedsYou, MAX_COMMENT_FETCHES } from './needs-you.js';
import { detectRepoSlug } from '../runners/github.js';
import { BASE_LABEL_PREFIX, assertAllowedBase, assertSafeBaseBranch, readAllowedBases, readRepoBaseBranch } from '../core/base-branch.js';
import type { ErrorKind } from '../hub-wire.js';
import { defaultRunsRoot, remoteRunsRoot, listRunSummaries, readRunDetail } from './runs.js';
import { readRunEvents } from './run-events.js';
import { isSafeTaskId } from '../core/state-path.js';
import { listActive, readSession } from './active.js';
import { readAppConfig, readAppConfigStrict, writeAppConfig, type AppConfig } from './app-config.js';
import { checkCliVersions } from '../sandbox/cli-versions.js';
import { CREDENTIAL_PROVIDERS, type CredentialProvider, type CredentialStore } from './credentials.js';
import * as drafts from './drafts.js';
import * as projects from './projects.js';
import * as teams from './teams.js';
import type { TeamRole } from '../wire.js';
import * as remote from './remote.js';
import { AuditWriteError } from '../core/audit.js';
import { AuditLog, TOKEN_ACTOR, auditActorOf, reportAuditFailure, type Actor, type AuditAction, type AuditOutcome } from './audit.js';
import { startGithubTask, triggerLabelsFor } from './start-task.js';
import { enableFactory, factoryPlanTargets, noScripts, type FactoryPlan, type FactoryProviderId } from './enable-factory.js';

/** GitHub's cap on a label name. */
const MAX_LABEL_LENGTH = 50;

export class UnknownCommandError extends BadRequestError {}

/** The caller is known but not allowed (non-admin reading the audit log) — the HTTP layer maps it to 403. */
export class ForbiddenError extends BadRequestError {}

/** The Fleet screen (`spawn_run` et al) is off unless the hub is the desktop app's own local hub:
 * `spawn_run` executes arbitrary programs, which is remote code execution on a reachable server. */
export const FLEET_DISABLED_MESSAGE = 'the Fleet screen is not available on this hub';

export interface RpcContext {
  allowlist: ProjectAllowlist;
  watchRegistry: WatchRegistry;
  runSession: RunSession;
  /** Present only when fleet is enabled (loopback bind + VANGUARD_HUB_ALLOW_FLEET=1). */
  spawnRegistry?: SpawnRegistry;
  completeRegistry: CompleteRegistry;
  deps: SidecarDeps;
  configDir: string;
  browseRoot: string;
  bind: BindOptions;
  /** Hosts `clone_project` accepts beyond `DEFAULT_CLONE_HOSTS` (a self-hosted GitHub/GitLab). */
  cloneHosts?: readonly string[];
  /** Instance provider credentials (write-only; see credentials.ts). */
  credentials: CredentialStore;
  /** Publish a server->client event (wired to the hub's EventBus). */
  publish: (name: string, payload: unknown) => void;
  /** Audit log; absent in tests that do not exercise it. */
  audit?: AuditLog;
  /** Who is calling; the shared `token` identity when absent. */
  actor?: Actor;
}

/** Who is calling: the request's actor, or the shared `token` identity. */
function actorOf(ctx: RpcContext): Actor {
  return ctx.actor ?? TOKEN_ACTOR;
}

function obj(rawArgs: unknown): Record<string, unknown> {
  return (rawArgs ?? {}) as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequestError(`${key} is required and must be a non-blank string`);
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

/** The provider the client picked. Only `github` has an adapter; `enableFactory` itself rejects the
 * other two with a `not implemented` BadRequestError, so this only narrows the string. */
function requireProvider(args: Record<string, unknown>, key: string): FactoryProviderId {
  const v = requireString(args, key);
  if (v !== 'github' && v !== 'gitlab' && v !== 'linear') throw new BadRequestError(`${key} must be github, gitlab or linear`);
  return v;
}

// `login` is spliced into the callers' YAML and `repoSlug` into the displayed `gh secret set`
// command, `defaultBranch` into git argv — so each must match its GitHub shape, nothing wider.
// `_` for Enterprise Managed Users (`name_shortcode`).
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;
const GITHUB_REPO_SLUG = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;
const GIT_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function requireMatch(args: Record<string, unknown>, key: string, shape: RegExp, label: string): string {
  const v = requireString(args, key);
  if (!shape.test(v)) throw new BadRequestError(`${key} must be a valid ${label}`);
  return v;
}

function requireOneOf(args: Record<string, unknown>, key: string, allowed: readonly string[]): string {
  const v = requireString(args, key);
  if (!allowed.includes(v)) throw new BadRequestError(`${key} must be one of ${allowed.join(', ')}`);
  return v;
}

function requireCredentialProvider(args: Record<string, unknown>): CredentialProvider {
  return requireOneOf(args, 'provider', CREDENTIAL_PROVIDERS) as CredentialProvider;
}

function requireScripts(raw: unknown): FactoryPlan['scripts'] {
  if (raw === undefined) return noScripts();
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const keys = ['typecheck', 'lint', 'test', 'build'] as const;
  if (keys.some((k) => typeof s[k] !== 'boolean')) throw new BadRequestError('plan.scripts must map typecheck/lint/test/build to booleans');
  return { typecheck: s.typecheck as boolean, lint: s.lint as boolean, test: s.test as boolean, build: s.build as boolean };
}

/** Re-read the plan the client echoes back from `enable_factory_plan`. The paths `apply` stages and
 * the labels it creates are NOT taken from the client: `factoryPlanTargets()` re-derives them from
 * this process's own constants, so a tampered plan cannot widen `git add` or `gh label create`; the
 * fields that reach YAML, shell text or git argv are shape-checked. */
function requirePlan(args: Record<string, unknown>, key: string): FactoryPlan {
  const raw = args[key];
  if (typeof raw !== 'object' || raw === null) throw new BadRequestError(`${key} is required`);
  const plan = raw as Record<string, unknown>;
  if (plan.provider !== 'github') throw new BadRequestError(`${key}.provider must be github`);
  const verifyCommand = optionalString(plan, 'verifyCommand');
  return {
    provider: 'github',
    repoSlug: requireMatch(plan, 'repoSlug', GITHUB_REPO_SLUG, 'owner/repo slug'),
    defaultBranch: requireMatch(plan, 'defaultBranch', GIT_BRANCH, 'branch name'),
    login: requireMatch(plan, 'login', GITHUB_LOGIN, 'GitHub login'),
    packageManager: requireOneOf(plan, 'packageManager', ['pnpm', 'yarn', 'npm', 'none']),
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    scripts: requireScripts(plan.scripts),
    ...factoryPlanTargets(),
  };
}

/** `read_run`'s `source` (wire's `RunSource`) → the root the records live under: the project's own
 * `.taskcell/runs`, or a CI run's imported `.taskcell/remote-runs/<id>`. The client never names a
 * root — the same discriminant resolves against the Tauri cache dir on the desktop side. */
function runSourceRoot(repoPath: string, raw: unknown): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (source.kind === 'local') return defaultRunsRoot(repoPath);
  if (source.kind === 'ci' && typeof source.runId === 'number') return remoteRunsRoot(repoPath, source.runId);
  throw new BadRequestError("source is required and must be { kind: 'local' } or { kind: 'ci', runId: number }");
}

/** The GitHub slug of an allowlisted repo's origin, or undefined when it has no GitHub remote. */
async function githubSlug(repoPath: string): Promise<string | undefined> {
  try {
    return await detectRepoSlug(repoPath);
  } catch {
    return undefined;
  }
}

async function repoOk(repoPath: string): Promise<boolean> {
  try {
    const res = await execa('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/** The Fleet screen's shell-spawn surface — the owner's only, and refused unless `ctx.spawnRegistry` is set. */
function requireFleet(ctx: RpcContext, caller: teams.Caller): SpawnRegistry {
  teams.assertOwner(caller);
  if (ctx.spawnRegistry === undefined) throw new BadRequestError(FLEET_DISABLED_MESSAGE);
  return ctx.spawnRegistry;
}

/**
 * Dispatch one RPC command. Returns the raw result (never `undefined` — void commands resolve
 * `null`) or throws: `BadRequestError`/`FlowError`/`TaskcellError` classify `bad-request`,
 * `UnknownCommandError` (a BadRequestError subtype) is additionally mapped to 404 by the caller,
 * anything else classifies `internal`. See `classifyError` below.
 */
async function dispatchInner(ctx: RpcContext, cmd: string, rawArgs: unknown, caller: teams.Caller): Promise<unknown> {
  const args = obj(rawArgs);

  // The allowlist, then the caller's teams: a repository outside every team of the caller is refused
  // for every command that reads or writes one (runs, files, drafts, flows, ...). The team roots are
  // read once per request.
  let rootsOnce: Promise<string[] | undefined> | undefined;
  const roots = (): Promise<string[] | undefined> => (rootsOnce ??= teams.callerRepoRoots(ctx.configDir, caller));
  const allow = async (repoPath: string): Promise<string> => {
    const real = await ctx.allowlist.assertAllowed(repoPath);
    teams.assertRepoInRoots(await roots(), real);
    return real;
  };
  // The repositories a list is limited to: the selected team's. Undefined (no limit) for the owner
  // without a `teamId` — token-only mode, one team — which keeps the pre-teams behaviour.
  const scope = async (): Promise<string[] | undefined> => {
    const teamId = optionalString(args, 'teamId');
    if (caller.owner && teamId === undefined) return undefined;
    // A signed-in user in no team has nothing to list (not an error); an explicit foreign `teamId` is refused.
    if (teamId === undefined && (await teams.callerTeams(ctx.configDir, caller)).length === 0) return [];
    return (await teams.selectTeam(ctx.configDir, caller, teamId)).repositories;
  };
  // A run known to the session: its repository must be the caller's. Unknown (finished) runs: owner only.
  const assertRunVisible = async (runId: string, unknownOk: boolean): Promise<void> => {
    const known = [ctx.runSession.activeRun(), ...ctx.runSession.queued()].find((r) => r !== null && r.runId === runId);
    if (known != null) teams.assertRepoInRoots(await roots(), known.repoPath);
    else if (!unknownOk) teams.assertOwner(caller);
  };

  switch (cmd) {
    case 'spawn_run': {
      const spawns = requireFleet(ctx, caller);
      const real = await allow(requireString(args, 'cwd'));
      const argv = args.argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
        throw new BadRequestError('argv is required and must be a non-empty array of strings');
      }
      return spawns.spawn(real, argv as string[]);
    }
    case 'kill_run': {
      const spawns = requireFleet(ctx, caller);
      const pid = optionalNumber(args, 'pid');
      if (pid === undefined) throw new BadRequestError('pid is required and must be a number');
      spawns.kill(pid);
      return null;
    }
    case 'list_spawns':
      return requireFleet(ctx, caller).list();
    case 'list_runs': {
      const real = await allow(requireString(args, 'repoPath'));
      return listRunSummaries(defaultRunsRoot(real));
    }
    case 'list_runs_all': {
      const { items, failures } = await projects.listAcrossProjects(
        ctx.configDir,
        allow,
        (real) => listRunSummaries(defaultRunsRoot(real)),
        await scope(),
      );
      // Newest first across repositories, as each repository's own list is.
      items.sort((x, y) => (x.timestamp < y.timestamp ? 1 : x.timestamp > y.timestamp ? -1 : 0));
      return { runs: items, failures };
    }
    case 'read_run': {
      const real = await allow(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      const timestamp = requireString(args, 'timestamp');
      return readRunDetail(runSourceRoot(real, args.source), taskId, timestamp);
    }
    case 'read_run_events': {
      // Read-only: allowed in server mode like read_run.
      const real = await allow(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      if (!isSafeTaskId(taskId)) throw new BadRequestError('taskId must name a single direct child of the runs root');
      const timestamp = optionalString(args, 'timestamp');
      const after = optionalNumber(args, 'after');
      const limit = optionalNumber(args, 'limit');
      return readRunEvents(real, taskId, {
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }
    case 'list_projects': {
      return projects.list(ctx.configDir, await scope());
    }
    case 'list_teams': {
      return teams.callerTeams(ctx.configDir, caller);
    }
    case 'get_team': {
      const id = requireString(args, 'id');
      return (await teams.callerTeams(ctx.configDir, caller)).find((t) => t.id === id) ?? null;
    }
    case 'add_team_member': {
      const role = requireOneOf(args, 'role', ['admin', 'member']) as TeamRole;
      return teams.addMember(ctx.configDir, caller, requireString(args, 'teamId'), { login: requireString(args, 'login').trim(), role });
    }
    case 'remove_team_member': {
      return teams.removeMember(ctx.configDir, caller, requireString(args, 'teamId'), requireString(args, 'login').trim());
    }
    case 'add_team_repository': {
      // Only a project registered on the hub that the caller already holds can be attached.
      const real = await allow(requireString(args, 'path'));
      const path = (await projects.registeredPath(ctx.configDir, real)) ?? real;
      return teams.addRepository(ctx.configDir, caller, requireString(args, 'teamId'), path);
    }
    case 'remove_team_repository': {
      const input = requireString(args, 'path');
      const path = (await projects.registeredPath(ctx.configDir, input)) ?? input;
      return teams.removeRepository(ctx.configDir, caller, requireString(args, 'teamId'), path);
    }
    case 'add_project': {
      assertMutationsAllowed(ctx.bind);
      teams.assertOwner(caller);
      const real = await assertWithinBrowseRoot(ctx.browseRoot, requireString(args, 'path'));
      await assertGitWorkTreeDir(real);
      return projects.add(ctx.configDir, real);
    }
    case 'clone_project': {
      assertMutationsAllowed(ctx.bind);
      teams.assertOwner(caller);
      const url = requireString(args, 'url');
      const parentDir = requireString(args, 'parentDir');
      const name = optionalString(args, 'name');
      const target = await cloneProject(
        ctx.browseRoot,
        { url, parentDir, name },
        { allowedHosts: ctx.cloneHosts, onProgress: (line) => ctx.publish('vanguard:clone-progress', { line }) },
      );
      await assertGitWorkTreeDir(target);
      await projects.add(ctx.configDir, target);
      return projects.aggregate(target);
    }
    case 'remove_project': {
      teams.assertOwner(caller);
      const path = requireString(args, 'path');
      await teams.purgeRepository(ctx.configDir, path);
      return projects.remove(ctx.configDir, path);
    }
    case 'list_active': {
      const real = await allow(requireString(args, 'repoPath'));
      return listActive(real);
    }
    case 'read_session': {
      const sessionFile = requireString(args, 'sessionFile');
      const real = await ctx.allowlist.assertSessionPath(sessionFile);
      teams.assertRepoInRoots(await roots(), real);
      return readSession(real);
    }
    case 'read_app_config': {
      const real = await allow(requireString(args, 'repoPath'));
      return readAppConfig(real);
    }
    case 'read_app_config_strict': {
      const real = await allow(requireString(args, 'repoPath'));
      return readAppConfigStrict(real);
    }
    case 'write_app_config': {
      const real = await allow(requireString(args, 'repoPath'));
      const config = args.config;
      if (typeof config !== 'object' || config === null) throw new BadRequestError('config is required');
      // A repository default or label-allowlist entry that git would misread is refused before it is saved,
      // not at the next run (one unsafe allowlist entry would refuse every labelled run and list_branches).
      const { baseBranch, baseBranches } = config as AppConfig;
      for (const b of [baseBranch, ...(Array.isArray(baseBranches) ? baseBranches : [])]) {
        if (typeof b === 'string' && b.trim() !== '') assertSafeBaseBranch(b.trim());
      }
      await writeAppConfig(real, config as AppConfig);
      return null;
    }
    case 'get_credentials': {
      teams.assertOwner(caller);
      return ctx.credentials.summary();
    }
    case 'set_credential': {
      teams.assertOwner(caller);
      assertMutationsAllowed(ctx.bind);
      const provider = requireCredentialProvider(args);
      return ctx.credentials.set(provider, requireString(args, 'value').trim());
    }
    case 'delete_credential': {
      teams.assertOwner(caller);
      assertMutationsAllowed(ctx.bind);
      return ctx.credentials.delete(requireCredentialProvider(args));
    }
    case 'list_drafts': {
      const real = await allow(requireString(args, 'repoPath'));
      return drafts.list(real);
    }
    case 'read_draft': {
      const real = await allow(requireString(args, 'repoPath'));
      return drafts.read(real, requireString(args, 'id'));
    }
    case 'write_draft': {
      const real = await allow(requireString(args, 'repoPath'));
      await drafts.write(real, requireString(args, 'id'), requireString(args, 'content'));
      return null;
    }
    case 'delete_draft': {
      const real = await allow(requireString(args, 'repoPath'));
      await drafts.del(real, requireString(args, 'id'));
      return null;
    }
    case 'write_draft_asset': {
      const real = await allow(requireString(args, 'repoPath'));
      const id = requireString(args, 'id');
      const name = requireString(args, 'name');
      const bytesRaw = args.bytes;
      if (!Array.isArray(bytesRaw)) throw new BadRequestError('bytes is required and must be an array of numbers');
      return drafts.writeAsset(real, id, name, Uint8Array.from(bytesRaw as number[]));
    }
    case 'clear_draft_assets': {
      const real = await allow(requireString(args, 'repoPath'));
      await drafts.clearAssets(real, requireString(args, 'id'));
      return null;
    }
    case 'list_remote_runs': {
      const real = await allow(requireString(args, 'repoPath'));
      return remote.listRemoteRuns(real);
    }
    case 'import_remote_run': {
      const real = await allow(requireString(args, 'repoPath'));
      const runId = optionalNumber(args, 'runId');
      if (runId === undefined) throw new BadRequestError('runId is required and must be a number');
      return remote.fetchRemoteRun(real, runId);
    }
    case 'list_tasks': {
      const real = await allow(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listTasks', { repoPath: real });
    }
    case 'list_tasks_all': {
      let capped = false;
      const { items, failures } = await projects.listAcrossProjects(
        ctx.configDir,
        allow,
        async (real) => {
          const r = (await invokeCoreMethod(ctx.deps, 'listTasks', { repoPath: real })) as { tasks: object[]; capped: boolean };
          capped ||= r.capped;
          return r.tasks;
        },
        await scope(),
      );
      return { tasks: items, capped, failures };
    }
    case 'fetch_spec': {
      const real = await allow(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      return invokeCoreMethod(ctx.deps, 'fetchSpec', { repoPath: real, taskId });
    }
    case 'watch_project': {
      const real = await allow(requireString(args, 'repoPath'));
      ctx.watchRegistry.watchProject(real, (p) => ctx.publish('vanguard:changed', p));
      return null;
    }
    case 'unwatch_project': {
      const real = await allow(requireString(args, 'repoPath'));
      ctx.watchRegistry.unwatchProject(real);
      return null;
    }
    case 'api_capabilities': {
      return invokeCoreMethod(ctx.deps, 'capabilities', undefined);
    }
    case 'api_create_run': {
      const params = (args.params ?? {}) as Record<string, unknown>;
      // startedBy comes from the request's actor, never from the client's params.
      const startedBy = actorOf(ctx).login;
      const actor = auditActorOf(actorOf(ctx));
      // One audit line: at acceptance (the call then stays pending until the run ends), or, when the
      // run is refused before that, one refusal line.
      let accepted = false;
      try {
        const real = await allow(requireString(params, 'repoPath'));
        // The run session (not deps.createRun) owns single-in-flight gating and event
        // buffering/publishing — validate via the table row, then call it directly.
        const validated = validateCoreMethod('createRun', { ...params, repoPath: real }) as CreateRunParams;
        const log = (action: AuditAction, runId: string, outcome: AuditOutcome): void => {
          accepted = true;
          // The run is already admitted (this call stays pending until it ends): an unwritable audit log is reported, not thrown.
          void ctx.audit?.record({ login: startedBy, actor, action, target: runId, outcome }).catch(reportAuditFailure);
        };
        return await ctx.runSession.createRun({ ...validated, startedBy }, {
          onStarted: (id) => log('run-start', id, 'ok'),
          onQueued: (id) => log('run-queue', id, 'ok'),
          onRefused: (id) => log('run-start', id, 'refused'),
        });
      } catch (err) {
        if (!accepted) {
          const repoPath = optionalString(params, 'repoPath');
          await ctx.audit?.record({ login: startedBy, actor, action: 'run-start', ...(repoPath !== undefined ? { target: repoPath, subject: { repo: repoPath } } : {}), outcome: outcomeOf(err) }).catch(reportAuditFailure);
        }
        throw err;
      }
    }
    case 'read_audit': {
      if (!actorOf(ctx).admin) throw new ForbiddenError('the audit log is admin-only');
      const login = optionalString(args, 'login');
      const limit = optionalNumber(args, 'limit');
      return ctx.audit === undefined ? [] : ctx.audit.read({ ...(login !== undefined && login !== '' ? { login } : {}), ...(limit !== undefined ? { limit } : {}) });
    }
    case 'api_active_run': {
      const active = ctx.runSession.activeRun();
      return active !== null && teams.repoInRoots(await roots(), active.repoPath) ? active : null;
    }
    case 'api_run_backlog': {
      const runId = requireString(args, 'runId');
      await assertRunVisible(runId, false);
      return ctx.runSession.backlog(runId);
    }
    case 'api_queue': {
      const visible = await roots();
      return ctx.runSession.queued().filter((q) => teams.repoInRoots(visible, q.repoPath));
    }
    case 'api_cancel': {
      // Required on the hub: with a queue, an id-less "cancel the active run" can hit another
      // project's run, or the successor promoted after the clicked run ended.
      const runId = requireString(args, 'runId');
      await assertRunVisible(runId, true);
      ctx.runSession.cancel(runId);
      return null;
    }
    case 'api_create_task': {
      const real = await allow(requireString(args, 'repoPath'));
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      // The client never chooses the tracker: source/team/label are read server-side from app.json.
      // `createTask`'s own validator (not a re-typed check here) rejects a bad source/missing team.
      const cfg = await readAppConfig(real);
      // The target branch rides on the card as a `vanguard:base=<branch>` label, so a run started from CI
      // or `watch` sees it too. Refused here when unsafe or not allowlisted (the run would refuse it) — before
      // anything is created, with no undo.
      // Blank means unset (as in app.json). The label must survive the tracker: GitHub caps a label name at
      // 50 characters, and GitLab takes labels as a comma-separated list.
      const baseBranch = optionalString(args, 'baseBranch')?.trim() || undefined;
      let baseLabel: string | undefined;
      if (baseBranch !== undefined) {
        assertSafeBaseBranch(baseBranch);
        baseLabel = `${BASE_LABEL_PREFIX}${baseBranch}`;
        if (baseLabel.length > MAX_LABEL_LENGTH || baseBranch.includes(',')) throw new BadRequestError(`baseBranch cannot be carried as a label (at most ${MAX_LABEL_LENGTH - BASE_LABEL_PREFIX.length} characters, no ",")`);
        if ((cfg.source ?? 'github') === 'linear') throw new BadRequestError('a target branch cannot be carried on a Linear card yet — leave it unset');
        assertAllowedBase(baseBranch, await readAllowedBases(real));
      }
      const labels = [cfg.label, baseLabel].filter((l): l is string => l !== undefined);
      const params: CreateTaskParams = {
        source: cfg.source ?? 'github',
        repoPath: real,
        title,
        body,
        ...(labels.length > 0 ? { labels } : {}),
        ...(cfg.team !== undefined ? { team: cfg.team } : {}),
      };
      return invokeCoreMethod(ctx.deps, 'createTask', params);
    }
    case 'list_branches': {
      const real = await allow(requireString(args, 'repoPath'));
      return listBranches(real);
    }
    case 'api_list_flows': {
      const real = await allow(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listFlows', { repoPath: real });
    }
    case 'api_list_providers': {
      const real = await allow(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listProviders', { repoPath: real });
    }
    case 'api_read_flow': {
      const real = await allow(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'readFlow', { repoPath: real, file });
    }
    case 'api_write_flow': {
      const real = await allow(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'writeFlow', { repoPath: real, file, doc: args.doc });
    }
    case 'api_delete_flow': {
      const real = await allow(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'deleteFlow', { repoPath: real, file });
    }
    case 'api_list_repo_files': {
      const real = await allow(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listRepoFiles', { repoPath: real });
    }
    case 'api_read_repo_file': {
      const real = await allow(requireString(args, 'repoPath'));
      const path = requireString(args, 'path');
      return invokeCoreMethod(ctx.deps, 'readRepoFile', { repoPath: real, path });
    }
    case 'api_repo_ok': {
      const repoPath = requireString(args, 'repoPath');
      try {
        const real = await allow(repoPath);
        return repoOk(real);
      } catch {
        return false;
      }
    }
    case 'api_complete': {
      const real = await allow(requireString(args, 'repoPath'));
      const reqRaw = args.req;
      if (typeof reqRaw !== 'object' || reqRaw === null) throw new BadRequestError('req is required');
      const reqObj = reqRaw as Record<string, unknown>;
      if (typeof reqObj.model !== 'string') throw new BadRequestError('req.model is required');
      // ALLOWLIST, not Omit<>: only these fields cross into the child's request, exactly like
      // ipc.ts's CompleteParams (baseUrl/assetRoot are never read from the caller — see complete.ts).
      const params: CompleteParams = {
        messages: reqObj.messages,
        model: reqObj.model,
        ...(reqObj.system !== undefined ? { system: reqObj.system } : {}),
        ...(reqObj.attachments !== undefined ? { attachments: reqObj.attachments } : {}),
      };
      return ctx.completeRegistry.complete(real, params, optionalString(args, 'callId'));
    }
    case 'api_cancel_complete': {
      ctx.completeRegistry.cancel(requireString(args, 'callId'));
      return null;
    }
    case 'browse_dirs': {
      assertMutationsAllowed(ctx.bind);
      // Feeds add_project / clone_project only, which are the owner's: a member must not list the host.
      teams.assertOwner(caller);
      return browseDirs(ctx.browseRoot, optionalString(args, 'path'));
    }
    case 'list_needs_you': {
      const real = await allow(requireString(args, 'repoPath'));
      const repoSlug = await githubSlug(real);
      // Not a GitHub remote — nothing for this read model to show.
      return { items: repoSlug === undefined ? [] : await listNeedsYou(repoSlug) };
    }
    case 'list_needs_you_all': {
      // One comment-fetch budget for every repository, not MAX_COMMENT_FETCHES each.
      const commentBudget = { remaining: MAX_COMMENT_FETCHES };
      const { items, failures } = await projects.listAcrossProjects(
        ctx.configDir,
        allow,
        async (real) => {
          const repoSlug = await githubSlug(real);
          return repoSlug === undefined ? [] : listNeedsYou(repoSlug, undefined, { commentBudget });
        },
        await scope(),
      );
      return { items, failures };
    }
    case 'reply_needs_you': {
      // Comments under the hub's `gh` identity and adds a trigger label — a remote mutation.
      assertMutationsAllowed(ctx.bind);
      const real = await allow(requireString(args, 'repoPath'));
      const id = requireString(args, 'id');
      const kind = requireString(args, 'kind');
      if (kind !== 'issue' && kind !== 'pr') throw new BadRequestError("kind must be 'issue' or 'pr'");
      const body = requireString(args, 'body');
      const repoSlug = await githubSlug(real);
      if (repoSlug === undefined) throw new BadRequestError('reply_needs_you: this project has no GitHub remote');
      // The slug comes from the allowlisted repo, never from `id` — `replyNeedsYou` refuses an `id`
      // naming any other repo, so a reply can only ever touch a registered project.
      // The repo's configured trigger label (app.json `label`, as api_create_task applies), else the default.
      const { label } = await readAppConfig(real);
      await replyNeedsYou(repoSlug, id, kind, body, undefined, label?.trim() ? label : undefined);
      return null;
    }
    case 'merge_needs_you': {
      // Merges under the hub's `gh` identity — a remote mutation.
      assertMutationsAllowed(ctx.bind);
      const real = await allow(requireString(args, 'repoPath'));
      const id = requireString(args, 'id');
      const repoSlug = await githubSlug(real);
      if (repoSlug === undefined) throw new BadRequestError('merge_needs_you: this project has no GitHub remote');
      await mergeNeedsYou(repoSlug, id);
      return null;
    }
    case 'start_task': {
      // Adds a trigger label as the hub's `gh` identity — a remote mutation.
      assertMutationsAllowed(ctx.bind);
      const real = await allow(requireString(args, 'repoPath'));
      const label = requireString(args, 'label');
      const number = optionalNumber(args, 'number');
      if (number === undefined) throw new BadRequestError('number is required and must be a number');
      const cfg = await readAppConfig(real);
      const source = cfg.source ?? 'github';
      if (source !== 'github') throw new BadRequestError(`start_task: ${source} is not supported yet`);
      const repoSlug = await githubSlug(real);
      if (repoSlug === undefined) throw new BadRequestError('start_task: this project has no GitHub remote');
      return startGithubTask(repoSlug, number, label, triggerLabelsFor(cfg.label));
    }
    case 'agent_cli_versions':
      // Starts a container on the host and makes outbound lookups — gated like the other side effects.
      assertMutationsAllowed(ctx.bind);
      return checkCliVersions({ cwd: ctx.configDir });
    case 'enable_factory_plan': {
      const real = await allow(requireString(args, 'repoPath'));
      return enableFactory(real, requireProvider(args, 'provider')).plan();
    }
    case 'enable_factory_apply': {
      // Writes a branch, a commit and a PR in the target repo — a mutation, like clone_project.
      assertMutationsAllowed(ctx.bind);
      const real = await allow(requireString(args, 'repoPath'));
      const shown = requirePlan(args, 'plan');
      const provider = enableFactory(real, 'github');
      // `login` becomes the callers' actor gate: apply a plan re-derived here, never the client's echo,
      // and refuse one that no longer matches what the user was shown.
      const plan = await provider.plan();
      if (plan.login !== shown.login || plan.repoSlug !== shown.repoSlug || plan.defaultBranch !== shown.defaultBranch) {
        throw new BadRequestError('the plan no longer matches the repository (gh login, repo or default branch changed); review the new plan and apply again');
      }
      return provider.apply(plan);
    }
    case 'enable_factory_secret': {
      const real = await allow(requireString(args, 'repoPath'));
      return enableFactory(real, 'github').secretCommand(requirePlan(args, 'plan'));
    }
    case 'enable_factory_verify': {
      // Dispatches the doctor workflow, so it mutates the remote too.
      assertMutationsAllowed(ctx.bind);
      const real = await allow(requireString(args, 'repoPath'));
      return enableFactory(real, 'github').verify(requirePlan(args, 'plan'));
    }
    default:
      throw new UnknownCommandError(`unknown command: ${cmd}`);
  }
}

type Args = Record<string, unknown>;

interface AuditSpec {
  action: AuditAction;
  target: (a: Args) => string | undefined;
  /** Names only — computed before the command runs. */
  detail?: (ctx: RpcContext, a: Args) => Promise<string[]>;
  /** Outcome of a call that did not throw (default `ok`). */
  okOutcome?: (ctx: RpcContext, a: Args) => AuditOutcome;
}

const repoTarget = (a: Args): string | undefined => optionalString(a, 'repoPath');
/** `<repoPath>:<a[key]>` — a file or item within a repository. */
const repoItemTarget = (key: string): AuditSpec['target'] => (a) => `${repoTarget(a) ?? ''}:${optionalString(a, key) ?? ''}`;

/** Top-level keys of `next` whose value differs from `prev` — names, never values. */
function changedKeys(prev: Args, next: Args): string[] {
  return [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

/** A credential write names the provider only — the value never reaches the log. */
const CREDENTIAL_AUDIT: AuditSpec = { action: 'settings-change', target: (a) => `credential:${optionalString(a, 'provider') ?? ''}` };

/** Audited commands: the action each logs, and the target/detail it names (never a value). */
const AUDITED: Record<string, AuditSpec> = {
  add_project: { action: 'project-add', target: (a) => optionalString(a, 'path') },
  remove_project: { action: 'project-remove', target: (a) => optionalString(a, 'path') },
  clone_project: { action: 'clone', target: (a) => optionalString(a, 'url') },
  api_cancel: {
    action: 'run-cancel',
    target: (a) => optionalString(a, 'runId'),
    // Cancelling an id that is neither active nor queued does nothing: logged as refused, not ok.
    okOutcome: (ctx, a) => {
      const id = optionalString(a, 'runId');
      return ctx.runSession.activeRun()?.runId === id || ctx.runSession.queued().some((q) => q.runId === id) ? 'ok' : 'refused';
    },
  },
  start_task: { action: 'task-start', target: (a) => `${repoTarget(a) ?? ''}#${String(optionalNumber(a, 'number') ?? '')}` },
  write_app_config: {
    action: 'settings-change',
    target: repoTarget,
    detail: async (ctx, a) => {
      if (typeof a.config !== 'object' || a.config === null) return [];
      try {
        const prev = await readAppConfig(await ctx.allowlist.assertAllowed(requireString(a, 'repoPath')));
        return changedKeys(prev as Args, a.config as Args);
      } catch {
        return [];
      }
    },
  },
  set_credential: CREDENTIAL_AUDIT,
  delete_credential: CREDENTIAL_AUDIT,
  api_write_flow: { action: 'settings-change', target: repoItemTarget('file') },
  api_delete_flow: { action: 'settings-change', target: repoItemTarget('file') },
  api_create_task: { action: 'task-create', target: repoTarget },
  reply_needs_you: { action: 'needs-reply', target: repoItemTarget('id') },
  merge_needs_you: { action: 'needs-merge', target: repoItemTarget('id') },
  enable_factory_apply: { action: 'enable-factory', target: repoTarget },
  enable_factory_verify: { action: 'enable-factory', target: repoTarget },
};

/** A caller-correctable error is `refused` (the HTTP 400 class); anything else, and a git clone that ran and failed, is `failed`. */
function outcomeOf(err: unknown): AuditOutcome {
  const { kind, message } = classifyError(err);
  return kind === 'bad-request' && !message.startsWith('git clone failed') ? 'refused' : 'failed';
}

/**
 * Dispatch one RPC command, writing exactly one audit line for an audited action — success, refusal
 * or failure. A run start/queue logs itself once the run is admitted (the call then stays pending
 * until the run ends), so it is not wrapped here.
 */
export async function dispatchRpc(ctx: RpcContext, cmd: string, rawArgs: unknown, caller: teams.Caller): Promise<unknown> {
  const spec = AUDITED[cmd];
  const audit = ctx.audit;
  if (spec === undefined || audit === undefined) return dispatchInner(ctx, cmd, rawArgs, caller);
  const args = obj(rawArgs);
  const login = actorOf(ctx).login;
  const target = spec.target(args);
  const detail = await spec.detail?.(ctx, args);
  const okOutcome = spec.okOutcome?.(ctx, args) ?? 'ok';
  const line = (outcome: AuditOutcome): Promise<void> =>
    audit.record({ login, actor: auditActorOf(actorOf(ctx)), action: spec.action, ...(target !== undefined ? { target } : {}), outcome, ...(detail !== undefined ? { detail } : {}) });
  try {
    const result = await dispatchInner(ctx, cmd, rawArgs, caller);
    // Fail closed: the change is already applied, so the caller is told it went unrecorded rather than that it failed.
    await line(okOutcome).catch((e: unknown) => {
      throw new AuditWriteError(`${cmd} was applied but its audit line could not be written: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    });
    return result;
  } catch (err) {
    // Fail closed on success (the caller is told the action went unrecorded); on a failed action keep the original error.
    await line(outcomeOf(err)).catch(reportAuditFailure);
    throw err;
  }
}

/** Classify a thrown value for the wire, on top of `classifyCoreError`'s message/kind (the one
 * place that pairing lives — see `src/sidecar/sidecar.ts`): adds the 404 hint the HTTP layer wants
 * for an unknown command. */
export function classifyError(err: unknown): { message: string; kind: ErrorKind; notFound: boolean } {
  const notFound = err instanceof UnknownCommandError;
  const { message, kind } = classifyCoreError(err);
  return { message, kind, notFound };
}

/** The targets a card may name (the allowlist a run enforces, see readAllowedBases), plus the repo's configured default. */
async function listBranches(repoPath: string): Promise<{ branches: string[]; default?: string }> {
  const [allowed, dflt] = await Promise.all([readAllowedBases(repoPath), readRepoBaseBranch(repoPath)]);
  return { branches: [...allowed].sort(), ...(dflt !== undefined ? { default: dflt } : {}) };
}
