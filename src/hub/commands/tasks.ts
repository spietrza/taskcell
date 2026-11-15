// Hub commands: the task board and creating/starting tasks. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { assertSkillsInstalled, namedSkillsProblem } from '../../context/named-skills.js';
import { hubSkillsDir, skillRegistryForRun } from '../../context/skill-registry.js';
import { TaskcellError, visibleError } from '../../core/errors.js';
import { resolveTaskRef } from '../../tasks/board.js';
import { setTaskSkills } from '../../tasks/create.js';
import { BadRequestError, invokeCoreMethod, type CreateTaskParams } from '../../sidecar/sidecar.js';
import { BASE_LABEL_PREFIX, assertAllowedBase, assertSafeBaseBranch, readAllowedBases, readRepoBaseBranch } from '../../core/base-branch.js';
import { readAppConfig } from '../app-config.js';
import type { RpcContext } from '../rpc.js';
import * as projects from '../projects.js';
import { listHubBoard } from '../hub-board.js';
import { HUB_TASK_ID, MAX_BLOCKED_BY, MAX_BODY_LENGTH, MAX_TITLE_LENGTH, createHubTask, editHubTask, listHubTasks, updateHubTask, type HubTaskOwner } from '../hub-tasks.js';
import { startGithubTask, triggerLabelsFor } from '../start-task.js';
import { markerReadBudget, retryPausedTask, withPausedTasks, type MarkerReadBudget } from '../paused.js';
import type { BoardTask, CreatedTask, RepoReadFailure, RepoStamp, RetryPausedResult, StartTaskResult } from '../../wire.js';
import { defineCommands, requireString, requireMatch, optionalString, optionalNumber, actorOf, githubSlug, repoTarget, repoItemTarget, assertHasRemote, type CommandCall } from '../command-kit.js';

export interface TasksCommands {
  /** `hubBoard`: the project's task source is the hub's own board (its cards are created and scheduled in the hub). */
  list_tasks: { args: { repoPath: string }; result: { tasks: BoardTask[]; capped: boolean; hubBoard?: true } };
  /** HUB_ONLY: `list_tasks` across every hub repository, each card stamped with its repository. `hubBoards`: the repositories whose task source is the hub board. */
  list_tasks_all: { args: { teamId?: string } | undefined; result: { tasks: (BoardTask & RepoStamp)[]; capped: boolean; failures: RepoReadFailure[]; hubBoards?: string[] } };
  fetch_spec: { args: { repoPath: string; taskId: string }; result: { spec: string } };
  /** `dependsOn`: ids of existing tasks this one depends on (`owner/repo#N`, `group/project#N`, `TEAM-N`), written as a `Depends on` line plus a native relation. */
  api_create_task: { args: { repoPath: string; title: string; body: string; baseBranch?: string; dependsOn?: string[] }; result: CreatedTask };
  /**
   * HUB_ONLY: split one piece of work into several tasks, created in order. A task's `dependsOn` lists the
   * positions (0-based) of earlier tasks in the same call; each becomes a dependency on the task just created.
   * At most 20 tasks and 40 dependencies in all per call; over either cap the call is refused before anything is created.
   */
  api_create_tasks: { args: { repoPath: string; tasks: { title: string; body: string; dependsOn?: number[] }[]; baseBranch?: string }; result: { tasks: CreatedTask[] } };
  /** HUB_ONLY, read-only: the target branches a card may name (repo default + `baseBranches` allowlist) and the configured default, for the new-card form. */
  list_branches: { args: { repoPath: string }; result: { branches: string[]; default?: string } };
  /** HUB_ONLY: add a task to the project's hub board (task source `hub`), with its dependencies and start date set before the scheduler can see it. The caller becomes the task's owner: it runs as them. */
  hub_task_create: { args: { repoPath: string; title: string; body?: string; blockedBy?: string[]; startDate?: string }; result: { id: string } };
  /** HUB_ONLY: set a hub-board task's dependencies (ids of the project's other tasks) and/or start date (`null` clears it). The caller becomes its owner. */
  hub_task_schedule: { args: { repoPath: string; id: string; blockedBy?: string[]; startDate?: string | null }; result: { id: string } };
  /** HUB_ONLY: put a failed hub-board task back to `todo`, to run as the caller. */
  hub_task_retry: { args: { repoPath: string; id: string }; result: { id: string } };
  /** HUB_ONLY: apply a trigger label to a GitHub issue of the project (src/hub/start-task.ts). */
  start_task: { args: { repoPath: string; number: number; label: string }; result: StartTaskResult };
  /** HUB_ONLY: "Retry now" on a task paused by a provider limit — remove the rate-limited label, re-apply the marker's trigger (src/hub/paused.ts). Refused where `start_task` is. */
  retry_paused_task: { args: { repoPath: string; number: number }; result: RetryPausedResult };
  /** HUB_ONLY, read-only: the ids of the skills a run of this project can load (what a hand-picked list is checked against). */
  list_skills: { args: { repoPath: string }; result: { skills: string[] } };
  /** HUB_ONLY: write a card's hand-picked skills: to its tracker task as the body's `Skills:` line, or on a hub-board task to the task itself (an empty list removes them). */
  set_task_skills: { args: { repoPath: string; taskId: string; skills: string[] }; result: { skills: string[] } };
}

/** Fill the retry time of paused cards from the factory's marker comment (GitHub only). A label-filtered `gh pr list` per spelling finds paused pull requests; marker reads only for paused cards. */
async function withPaused(ctx: RpcContext, real: string, tasks: BoardTask[], budget: MarkerReadBudget): Promise<BoardTask[]> {
  // Only a GitHub task source: a Linear or GitLab project with a github.com origin has no paused cards to read here.
  if (((await readAppConfig(real)).source ?? 'github') !== 'github') return tasks;
  const slug = await githubSlug(real);
  return slug === undefined ? tasks : withPausedTasks(slug, tasks, ctx.gh, budget);
}

/** GitHub's cap on a label name. */
const MAX_LABEL_LENGTH = 50;
/** Tasks one `api_create_tasks` call may create: each is an irreversible write. */
const MAX_SPLIT_TASKS = 20;
/** Dependencies one `api_create_tasks` call may declare in all: each costs CLI calls, and a client that times out and retries would duplicate issues. */
const MAX_SPLIT_DEPENDENCIES = 40;

/** Everything a create needs but the card's own text: tracker, team and labels from app.json, the target branch checked. Nothing is created here. */
async function createTaskBase(real: string, args: Record<string, unknown>): Promise<Omit<CreateTaskParams, 'title' | 'body'>> {
  // The client never chooses the tracker: source/team/label are read server-side from app.json.
  // `createTask`'s own validator (not a re-typed check here) rejects a bad source/missing team.
  const cfg = await readAppConfig(real);
  // The target branch rides on the card as a `taskcell:base=<branch>` label, so a run started from CI
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
  const base = {
    source: cfg.source ?? 'github',
    repoPath: real,
    ...(labels.length > 0 ? { labels } : {}),
    ...(cfg.team !== undefined ? { team: cfg.team } : {}),
  };
  // Linear needs no code host; `gh`/`glab issue create` do.
  if (base.source !== 'linear') await assertHasRemote(real, base.source === 'github');
  return base;
}

/**
 * The skills a run of this project loads: the hub's skills dir plus the repo's own. A broken dir or lock is
 * reported as a 400 that says what is wrong but names no host path (the detail goes to the hub log).
 */
async function installedSkills(repoPath: string): Promise<string[]> {
  try {
    return (await skillRegistryForRun(hubSkillsDir(), repoPath)).ids().sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`vanguard-hub: skills cannot be listed for ${repoPath}: ${detail}`);
    throw new BadRequestError(`Skills cannot be listed: ${/lock/i.test(detail) ? 'a skills lock does not match its skills' : 'the skills directory cannot be read'}; see the hub log.`);
  }
}

/** A hub-board card's skills: stored on the hub task (its run loads exactly these, even none). Only a task not yet started takes them; the editor becomes its owner, as for a schedule edit. */
async function setHubTaskSkills(call: CommandCall, real: string, taskId: string, names: string[]): Promise<{ skills: string[] }> {
  if (!(await isHubBoard(real))) throw new BadRequestError('this project\'s task source is not Hub board (Settings → Task source)');
  try {
    assertSkillsInstalled(names, await installedSkills(real));
  } catch (error) {
    if (error instanceof TaskcellError) throw new BadRequestError(error.message);
    throw error;
  }
  const owner = ownerOf(call);
  const task = await editHubTask(call.ctx.configDir, real, taskId, (t) => {
    if (t.status !== 'todo') throw new BadRequestError(`${taskId} is ${t.status}; skills can only be changed before it starts`);
    t.skills = names;
    t.owner = owner;
  });
  if (task === undefined) throw new BadRequestError(`no hub task ${taskId}`);
  return { skills: names };
}

/** The targets a card may name (the allowlist a run enforces, see readAllowedBases), plus the repo's configured default. */
async function listBranches(repoPath: string): Promise<{ branches: string[]; default?: string }> {
  const [allowed, dflt] = await Promise.all([readAllowedBases(repoPath), readRepoBaseBranch(repoPath)]);
  return { branches: [...allowed].sort(), ...(dflt !== undefined ? { default: dflt } : {}) };
}

const isHubBoard = async (real: string): Promise<boolean> => (await readAppConfig(real)).taskSource === 'hub';

/** The hub-board commands work only on a project whose task source is the hub board; every other source is refused. */
async function hubBoardRepo({ args, allow }: CommandCall): Promise<string> {
  const real = await allow(requireString(args, 'repoPath'));
  if (!(await isHubBoard(real))) throw new BadRequestError('this project\'s task source is not Hub board (Settings → Task source)');
  return real;
}

/** A `blockedBy` argument: a list of at most MAX_BLOCKED_BY hub task ids, or undefined when absent. */
function scheduleBlockedBy(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_BLOCKED_BY || value.some((x) => typeof x !== 'string' || !HUB_TASK_ID.test(x))) {
    throw new BadRequestError(`blockedBy must be a list of at most ${MAX_BLOCKED_BY} task ids (hub-1, hub-2, …)`);
  }
  return value as string[];
}

/** The caller, as the person a task they create, schedule or retry runs as. */
const ownerOf = ({ ctx, caller }: CommandCall): HubTaskOwner => ({ actor: actorOf(ctx), caller });

/** The board's cards: a hub-board project's own tasks, else the tracker's through core. */
async function boardOf(ctx: RpcContext, real: string): Promise<{ tasks: BoardTask[]; capped: boolean; hubBoard?: true }> {
  if (await isHubBoard(real)) return listHubBoard(ctx.configDir, real, new Map(ctx.runSession.queued().map((q) => [q.runId, q.position])));
  return (await invokeCoreMethod(ctx.deps, 'listTasks', { repoPath: real })) as { tasks: BoardTask[]; capped: boolean };
}

export const commands = defineCommands<TasksCommands>({
  list_skills: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return { skills: await installedSkills(real) };
  },
  set_task_skills: async (call) => {
    const { args, allow } = call;
    const real = await allow(requireString(args, 'repoPath'));
    const taskId = requireString(args, 'taskId');
    const skills = args.skills;
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) throw new BadRequestError('skills must be an array of skill ids');
    const names = [...new Set(skills as string[])];
    const problem = namedSkillsProblem(names);
    if (problem !== undefined) throw new BadRequestError(`skills ${problem}`);
    if (HUB_TASK_ID.test(taskId)) return setHubTaskSkills(call, real, taskId, names);
    const ref = resolveTaskRef(taskId);
    const source = ref?.source;
    if (ref === undefined || source === undefined) throw new BadRequestError(`taskId ${JSON.stringify(taskId.slice(0, 80))} names no GitHub, GitLab or Linear task`);
    // The tracker is the project's, never the caller's choice: a prefix alone would let any repo's user edit any issue the hub's key reaches.
    const cfg = await readAppConfig(real);
    if (cfg.taskSource === 'hub' || source !== (cfg.source ?? 'github')) throw new BadRequestError('this task is not on the project\'s task source');
    if (source === 'linear' && (cfg.team === undefined || !ref.reference.toUpperCase().startsWith(`${cfg.team.toUpperCase()}-`))) throw new BadRequestError('this task is not in the project\'s Linear team');
    try {
      assertSkillsInstalled(names, await installedSkills(real));
    } catch (error) {
      if (error instanceof TaskcellError) throw new BadRequestError(error.message);
      throw error;
    }
    if (source !== 'linear') await assertHasRemote(real, source === 'github');
    try {
      return await setTaskSkills(real, taskId, names);
    } catch (error) {
      // gh/glab/Linear failures (not signed in, no such issue) are the caller's to fix: one line, like the board's.
      throw new BadRequestError(visibleError(error).message);
    }
  },
  list_tasks: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const r = await boardOf(ctx, real);
    return r.hubBoard === true ? r : { ...r, tasks: await withPaused(ctx, real, r.tasks, markerReadBudget()) };
  },
  list_tasks_all: async ({ ctx, allow, scope }) => {
    let capped = false;
    const budget = markerReadBudget();
    const hubBoards: string[] = [];
    // Named as registered (the path the UI knows the project by), not as resolved.
    const registered = new Map<string, string>();
    const { items, failures } = await projects.listAcrossProjects(
      ctx.configDir,
      async (path) => {
        const real = await allow(path);
        registered.set(real, path);
        return real;
      },
      async (real) => {
        const r = await boardOf(ctx, real);
        capped ||= r.capped;
        if (r.hubBoard === true) {
          hubBoards.push(registered.get(real) ?? real);
          return r.tasks;
        }
        return withPaused(ctx, real, r.tasks, budget);
      },
      await scope(),
    );
    return { tasks: items, capped, failures, ...(hubBoards.length > 0 ? { hubBoards } : {}) };
  },
  fetch_spec: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const taskId = requireString(args, 'taskId');
    // A hub-board card's spec is its stored title and body: there is no tracker to ask.
    if (HUB_TASK_ID.test(taskId) && (await isHubBoard(real))) {
      const task = (await listHubTasks(ctx.configDir, real)).find((t) => t.id === taskId);
      if (task === undefined) throw new BadRequestError(`no hub task ${taskId}`);
      return { spec: `# ${task.title}\n\n${task.body}`.trim() };
    }
    return invokeCoreMethod(ctx.deps, 'fetchSpec', { repoPath: real, taskId });
  },
  api_create_task: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const title = requireString(args, 'title');
    const body = typeof args.body === 'string' ? args.body : '';
    const dependsOn = args.dependsOn;
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string'))) throw new BadRequestError('dependsOn must be a list of task references');
    const params: CreateTaskParams = { ...(await createTaskBase(real, args)), title, body, ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn: dependsOn as string[] } : {}) };
    return invokeCoreMethod(ctx.deps, 'createTask', params);
  },
  api_create_tasks: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const tasks = args.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_SPLIT_TASKS) throw new BadRequestError(`tasks must be a list of 1 to ${MAX_SPLIT_TASKS} tasks`);
    // Everything is checked before the first create: a task created ahead of a bad one cannot be taken back.
    const items = tasks.map((raw: unknown, i) => {
      const t = (raw ?? {}) as Record<string, unknown>;
      const deps = t.dependsOn ?? [];
      if (typeof t.title !== 'string' || t.title.trim() === '' || typeof t.body !== 'string') throw new BadRequestError(`tasks[${i}] needs a title and a body`);
      if (!Array.isArray(deps) || deps.some((d) => !Number.isInteger(d) || d < 0 || d >= i)) throw new BadRequestError(`tasks[${i}].dependsOn must list positions of earlier tasks in this call`);
      return { title: t.title, body: t.body, dependsOn: deps as number[] };
    });
    if (items.reduce((n, i) => n + new Set(i.dependsOn).size, 0) > MAX_SPLIT_DEPENDENCIES) throw new BadRequestError(`tasks may declare at most ${MAX_SPLIT_DEPENDENCIES} dependencies in all`);
    const base = await createTaskBase(real, args);
    const created: CreatedTask[] = [];
    for (const item of items) {
      const dependsOn = [...new Set(item.dependsOn)].map((d) => created[d]!.id);
      try {
        created.push((await invokeCoreMethod(ctx.deps, 'createTask', { ...base, title: item.title, body: item.body, ...(dependsOn.length > 0 ? { dependsOn } : {}) })) as CreatedTask);
      } catch (error) {
        if (created.length === 0) throw error;
        throw new TaskcellError(`task ${created.length + 1} of ${items.length} could not be created (${error instanceof Error ? error.message : String(error)}); already created and not undone: ${created.map((c) => c.id).join(', ')}`);
      }
    }
    return { tasks: created };
  },
  hub_task_create: async (call) => {
    const real = await hubBoardRepo(call);
    const title = requireString(call.args, 'title').trim();
    const body = optionalString(call.args, 'body') ?? '';
    if (title.length > MAX_TITLE_LENGTH) throw new BadRequestError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
    if (body.length > MAX_BODY_LENGTH) throw new BadRequestError(`body must be at most ${MAX_BODY_LENGTH} characters`);
    const blockedBy = scheduleBlockedBy(call.args.blockedBy);
    const startDate = call.args.startDate;
    if (startDate !== undefined && typeof startDate !== 'string') throw new BadRequestError('startDate must be a string');
    return { id: (await createHubTask(call.ctx.configDir, real, { title, body, ...(blockedBy !== undefined ? { blockedBy: [...new Set(blockedBy)] } : {}), ...(startDate !== undefined && startDate !== '' ? { startDate } : {}), owner: ownerOf(call) })).id };
  },
  hub_task_schedule: async (call) => {
    const real = await hubBoardRepo(call);
    const { args } = call;
    const id = requireMatch(args, 'id', HUB_TASK_ID, 'hub task id');
    const blockedBy = scheduleBlockedBy(args.blockedBy);
    const startDate = args.startDate;
    if (startDate !== undefined && startDate !== null && typeof startDate !== 'string') throw new BadRequestError('startDate must be a string or null');
    const task = await updateHubTask(call.ctx.configDir, real, id, { ...(blockedBy !== undefined ? { blockedBy } : {}), ...(startDate !== undefined ? { startDate } : {}), owner: ownerOf(call) });
    return { id: task.id };
  },
  hub_task_retry: async (call) => {
    const real = await hubBoardRepo(call);
    const id = requireMatch(call.args, 'id', HUB_TASK_ID, 'hub task id');
    const task = await editHubTask(call.ctx.configDir, real, id, (t) => {
      if (t.status !== 'failed') throw new BadRequestError(`${id} is ${t.status}, not failed`);
      t.status = 'todo';
      delete t.reason;
      t.owner = ownerOf(call);
    });
    if (task === undefined) throw new BadRequestError(`no hub task ${id}`);
    return { id };
  },
  list_branches: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return listBranches(real);
  },
  start_task: async ({ args, allow }) => {
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
  },
  retry_paused_task: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const number = optionalNumber(args, 'number');
    if (number === undefined) throw new BadRequestError('number is required and must be a number');
    const cfg = await readAppConfig(real);
    const source = cfg.source ?? 'github';
    if (source !== 'github') throw new BadRequestError(`retry_paused_task: ${source} is not supported yet`);
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('retry_paused_task: this project has no GitHub remote');
    return retryPausedTask(repoSlug, number, triggerLabelsFor(cfg.label));
  },
}, {
  list_skills: { write: false, repo: 'repoPath' },
  set_task_skills: { write: true, remote: true, repo: 'repoPath' },
  list_tasks: { write: false, repo: 'repoPath' },
  list_tasks_all: { write: false },
  fetch_spec: { write: false, repo: 'repoPath' },
  // Both create issues as the hub's tracker identity: remote writes, gated like start_task.
  api_create_task: { write: true, remote: true, repo: 'repoPath' },
  api_create_tasks: { write: true, remote: true, repo: 'repoPath' },
  // The hub board is the hub's own store, not a code host: no remote gate.
  hub_task_create: { write: true, repo: 'repoPath' },
  hub_task_schedule: { write: true, repo: 'repoPath' },
  hub_task_retry: { write: true, repo: 'repoPath' },
  list_branches: { write: false, repo: 'repoPath' },
  start_task: { write: true, remote: true, repo: 'repoPath' },
  retry_paused_task: { write: true, remote: true, repo: 'repoPath' },
}, {
  api_create_task: { action: 'task-create', target: repoTarget },
  set_task_skills: { action: 'task-edit', target: repoItemTarget('taskId'), detail: async () => ['skills'] },
  api_create_tasks: { action: 'task-create', target: repoTarget },
  hub_task_create: { action: 'task-create', target: repoTarget },
  hub_task_schedule: { action: 'task-schedule', target: repoItemTarget('id') },
  hub_task_retry: { action: 'task-schedule', target: repoItemTarget('id') },
  start_task: { action: 'task-start', target: (a) => `${repoTarget(a) ?? ''}#${String(optionalNumber(a, 'number') ?? '')}` },
  retry_paused_task: { action: 'task-retry', target: (a) => `${repoTarget(a) ?? ''}#${String(optionalNumber(a, 'number') ?? '')}` },
});
