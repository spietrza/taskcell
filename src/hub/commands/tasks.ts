// Hub commands: the task board and creating/starting tasks. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError, invokeCoreMethod, type CreateTaskParams } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { BASE_LABEL_PREFIX, assertAllowedBase, assertSafeBaseBranch, readAllowedBases, readRepoBaseBranch } from '../../core/base-branch.js';
import { readAppConfig } from '../app-config.js';
import * as projects from '../projects.js';
import { TaskcellError } from '../../core/errors.js';
import { startGithubTask, triggerLabelsFor } from '../start-task.js';
import type { BoardTask, CreatedTask, RepoReadFailure, RepoStamp, StartTaskResult } from '../../wire.js';
import { defineCommands, requireString, optionalString, optionalNumber, githubSlug, repoTarget, assertHasRemote } from '../command-kit.js';

export interface TasksCommands {
  list_tasks: { args: { repoPath: string }; result: { tasks: BoardTask[]; capped: boolean } };
  /** HUB_ONLY: `list_tasks` across every hub repository, each card stamped with its repository. */
  list_tasks_all: { args: { teamId?: string } | undefined; result: { tasks: (BoardTask & RepoStamp)[]; capped: boolean; failures: RepoReadFailure[] } };
  fetch_spec: { args: { repoPath: string; taskId: string }; result: { spec: string } };
  /** `dependsOn`: ids of existing tasks this one depends on (`owner/repo#N`, `group/project#N`, `TEAM-N`), written as a `Depends on` line plus a native relation. */
  api_create_task: { args: { repoPath: string; title: string; body: string; baseBranch?: string; dependsOn?: string[] }; result: CreatedTask };
  /**
   * HUB_ONLY: split one piece of work into several tasks, created in order. A task's `dependsOn` lists the
   * positions (0-based) of earlier tasks in the same call; each becomes a dependency on the task just created.
   */
  api_create_tasks: { args: { repoPath: string; tasks: { title: string; body: string; dependsOn?: number[] }[]; baseBranch?: string }; result: { tasks: CreatedTask[] } };
  /** HUB_ONLY, read-only: the target branches a card may name (repo default + `baseBranches` allowlist) and the configured default, for the new-card form. */
  list_branches: { args: { repoPath: string }; result: { branches: string[]; default?: string } };
  /** HUB_ONLY: apply a trigger label to a GitHub issue of the project (src/hub/start-task.ts). */
  start_task: { args: { repoPath: string; number: number; label: string }; result: StartTaskResult };
}

/** GitHub's cap on a label name. */
const MAX_LABEL_LENGTH = 50;
/** Tasks one `api_create_tasks` call may create: each is an irreversible write. */
const MAX_SPLIT_TASKS = 20;

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

/** The targets a card may name (the allowlist a run enforces, see readAllowedBases), plus the repo's configured default. */
async function listBranches(repoPath: string): Promise<{ branches: string[]; default?: string }> {
  const [allowed, dflt] = await Promise.all([readAllowedBases(repoPath), readRepoBaseBranch(repoPath)]);
  return { branches: [...allowed].sort(), ...(dflt !== undefined ? { default: dflt } : {}) };
}

export const commands = defineCommands<TasksCommands>({
  list_tasks: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return invokeCoreMethod(ctx.deps, 'listTasks', { repoPath: real });
  },
  list_tasks_all: async ({ ctx, allow, scope }) => {
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
  },
  fetch_spec: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const taskId = requireString(args, 'taskId');
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
  list_branches: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return listBranches(real);
  },
  start_task: async ({ ctx, args, allow }) => {
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
  },
}, {
  api_create_task: { action: 'task-create', target: repoTarget },
  api_create_tasks: { action: 'task-create', target: repoTarget },
  start_task: { action: 'task-start', target: (a) => `${repoTarget(a) ?? ''}#${String(optionalNumber(a, 'number') ?? '')}` },
});
