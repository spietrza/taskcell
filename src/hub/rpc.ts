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
import type { RunSession } from './run-session.js';
import { CompleteRegistry, type CompleteParams } from './complete.js';
import { assertWithinBrowseRoot, browseDirs } from './browse.js';
import { cloneProject } from './clone.js';
import { listNeedsYou, replyNeedsYou } from './needs-you.js';
import { detectRepoSlug } from '../runners/github.js';
import type { ErrorKind } from '../hub-wire.js';
import { defaultRunsRoot, remoteRunsRoot, listRunSummaries, readRunDetail } from './runs.js';
import { listActive, readSession } from './active.js';
import { readAppConfig, readAppConfigStrict, writeAppConfig, type AppConfig } from './app-config.js';
import * as drafts from './drafts.js';
import * as projects from './projects.js';
import * as remote from './remote.js';
import { enableFactory, factoryPlanTargets, noScripts, type FactoryPlan, type FactoryProviderId } from './enable-factory.js';

export class UnknownCommandError extends BadRequestError {}

/** The Fleet screen (`spawn_run` et al) is dropped in hub mode: `spawn_run` executes arbitrary
 * shell, which is remote code execution on a reachable server. */
export const FLEET_DISABLED_MESSAGE = 'the Fleet screen is not available in hub mode';

export interface RpcContext {
  allowlist: ProjectAllowlist;
  watchRegistry: WatchRegistry;
  runSession: RunSession;
  completeRegistry: CompleteRegistry;
  deps: SidecarDeps;
  configDir: string;
  browseRoot: string;
  bind: BindOptions;
  /** Hosts `clone_project` accepts beyond `DEFAULT_CLONE_HOSTS` (a self-hosted GitHub/GitLab). */
  cloneHosts?: readonly string[];
  /** Publish a server->client event (wired to the hub's EventBus). */
  publish: (name: string, payload: unknown) => void;
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

/** Commands disabled in hub mode — the Fleet screen's shell-spawn surface. */
export const DISABLED_COMMANDS = ['spawn_run', 'kill_run', 'list_spawns'] as const;

/**
 * Dispatch one RPC command. Returns the raw result (never `undefined` — void commands resolve
 * `null`) or throws: `BadRequestError`/`FlowError`/`TaskcellError` classify `bad-request`,
 * `UnknownCommandError` (a BadRequestError subtype) is additionally mapped to 404 by the caller,
 * anything else classifies `internal`. See `classifyError` below.
 */
export async function dispatchRpc(ctx: RpcContext, cmd: string, rawArgs: unknown): Promise<unknown> {
  const args = obj(rawArgs);

  if ((DISABLED_COMMANDS as readonly string[]).includes(cmd)) {
    throw new BadRequestError(FLEET_DISABLED_MESSAGE);
  }

  switch (cmd) {
    case 'list_runs': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return listRunSummaries(defaultRunsRoot(real));
    }
    case 'read_run': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      const timestamp = requireString(args, 'timestamp');
      return readRunDetail(runSourceRoot(real, args.source), taskId, timestamp);
    }
    case 'list_projects': {
      return projects.list(ctx.configDir);
    }
    case 'add_project': {
      assertMutationsAllowed(ctx.bind);
      const real = await assertWithinBrowseRoot(ctx.browseRoot, requireString(args, 'path'));
      await assertGitWorkTreeDir(real);
      return projects.add(ctx.configDir, real);
    }
    case 'clone_project': {
      assertMutationsAllowed(ctx.bind);
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
      const path = requireString(args, 'path');
      return projects.remove(ctx.configDir, path);
    }
    case 'list_active': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return listActive(real);
    }
    case 'read_session': {
      const sessionFile = requireString(args, 'sessionFile');
      const real = await ctx.allowlist.assertSessionPath(sessionFile);
      return readSession(real);
    }
    case 'read_app_config': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return readAppConfig(real);
    }
    case 'read_app_config_strict': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return readAppConfigStrict(real);
    }
    case 'write_app_config': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const config = args.config;
      if (typeof config !== 'object' || config === null) throw new BadRequestError('config is required');
      await writeAppConfig(real, config as AppConfig);
      return null;
    }
    case 'list_drafts': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return drafts.list(real);
    }
    case 'read_draft': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return drafts.read(real, requireString(args, 'id'));
    }
    case 'write_draft': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      await drafts.write(real, requireString(args, 'id'), requireString(args, 'content'));
      return null;
    }
    case 'delete_draft': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      await drafts.del(real, requireString(args, 'id'));
      return null;
    }
    case 'write_draft_asset': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const id = requireString(args, 'id');
      const name = requireString(args, 'name');
      const bytesRaw = args.bytes;
      if (!Array.isArray(bytesRaw)) throw new BadRequestError('bytes is required and must be an array of numbers');
      return drafts.writeAsset(real, id, name, Uint8Array.from(bytesRaw as number[]));
    }
    case 'clear_draft_assets': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      await drafts.clearAssets(real, requireString(args, 'id'));
      return null;
    }
    case 'list_remote_runs': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return remote.listRemoteRuns(real);
    }
    case 'import_remote_run': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const runId = optionalNumber(args, 'runId');
      if (runId === undefined) throw new BadRequestError('runId is required and must be a number');
      return remote.fetchRemoteRun(real, runId);
    }
    case 'list_tasks': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listTasks', { repoPath: real });
    }
    case 'fetch_spec': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      return invokeCoreMethod(ctx.deps, 'fetchSpec', { repoPath: real, taskId });
    }
    case 'watch_project': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      ctx.watchRegistry.watchProject(real, (p) => ctx.publish('vanguard:changed', p));
      return null;
    }
    case 'unwatch_project': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      ctx.watchRegistry.unwatchProject(real);
      return null;
    }
    case 'api_capabilities': {
      return invokeCoreMethod(ctx.deps, 'capabilities', undefined);
    }
    case 'api_create_run': {
      const params = (args.params ?? {}) as Record<string, unknown>;
      const real = await ctx.allowlist.assertAllowed(requireString(params, 'repoPath'));
      // The run session (not deps.createRun) owns single-in-flight gating and event
      // buffering/publishing — validate via the table row, then call it directly.
      const validated = validateCoreMethod('createRun', { ...params, repoPath: real });
      return ctx.runSession.createRun(validated as CreateRunParams);
    }
    case 'api_active_run': {
      return ctx.runSession.activeRun();
    }
    case 'api_run_backlog': {
      return ctx.runSession.backlog(requireString(args, 'runId'));
    }
    case 'api_queue': {
      return ctx.runSession.queued();
    }
    case 'api_cancel': {
      // Required on the hub: with a queue, an id-less "cancel the active run" can hit another
      // project's run, or the successor promoted after the clicked run ended.
      ctx.runSession.cancel(requireString(args, 'runId'));
      return null;
    }
    case 'api_create_task': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      // The client never chooses the tracker: source/team/label are read server-side from app.json.
      // `createTask`'s own validator (not a re-typed check here) rejects a bad source/missing team.
      const cfg = await readAppConfig(real);
      const params: CreateTaskParams = {
        source: cfg.source ?? 'github',
        repoPath: real,
        title,
        body,
        ...(cfg.label !== undefined ? { labels: [cfg.label] } : {}),
        ...(cfg.team !== undefined ? { team: cfg.team } : {}),
      };
      return invokeCoreMethod(ctx.deps, 'createTask', params);
    }
    case 'api_list_flows': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listFlows', { repoPath: real });
    }
    case 'api_list_providers': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listProviders', { repoPath: real });
    }
    case 'api_read_flow': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'readFlow', { repoPath: real, file });
    }
    case 'api_write_flow': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'writeFlow', { repoPath: real, file, doc: args.doc });
    }
    case 'api_delete_flow': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'deleteFlow', { repoPath: real, file });
    }
    case 'api_list_repo_files': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listRepoFiles', { repoPath: real });
    }
    case 'api_read_repo_file': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const path = requireString(args, 'path');
      return invokeCoreMethod(ctx.deps, 'readRepoFile', { repoPath: real, path });
    }
    case 'api_repo_ok': {
      const repoPath = requireString(args, 'repoPath');
      try {
        const real = await ctx.allowlist.assertAllowed(repoPath);
        return repoOk(real);
      } catch {
        return false;
      }
    }
    case 'api_complete': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
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
      return browseDirs(ctx.browseRoot, optionalString(args, 'path'));
    }
    case 'list_needs_you': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const repoSlug = await githubSlug(real);
      // Not a GitHub remote — nothing for this read model to show.
      return { items: repoSlug === undefined ? [] : await listNeedsYou(repoSlug) };
    }
    case 'reply_needs_you': {
      // Comments under the hub's `gh` identity and adds a trigger label — a remote mutation.
      assertMutationsAllowed(ctx.bind);
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
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
    case 'enable_factory_plan': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return enableFactory(real, requireProvider(args, 'provider')).plan();
    }
    case 'enable_factory_apply': {
      // Writes a branch, a commit and a PR in the target repo — a mutation, like clone_project.
      assertMutationsAllowed(ctx.bind);
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
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
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return enableFactory(real, 'github').secretCommand(requirePlan(args, 'plan'));
    }
    case 'enable_factory_verify': {
      // Dispatches the doctor workflow, so it mutates the remote too.
      assertMutationsAllowed(ctx.bind);
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return enableFactory(real, 'github').verify(requirePlan(args, 'plan'));
    }
    default:
      throw new UnknownCommandError(`unknown command: ${cmd}`);
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
