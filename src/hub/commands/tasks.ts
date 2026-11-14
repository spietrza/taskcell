// Hub commands: the task board and creating/starting tasks. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError, invokeCoreMethod, type CreateTaskParams } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { BASE_LABEL_PREFIX, assertAllowedBase, assertSafeBaseBranch, readAllowedBases, readRepoBaseBranch } from '../../core/base-branch.js';
import { readAppConfig } from '../app-config.js';
import * as projects from '../projects.js';
import { startGithubTask, triggerLabelsFor } from '../start-task.js';
import type { BoardTask, CreatedTask, RepoReadFailure, RepoStamp, StartTaskResult } from '../../wire.js';
import { defineCommands, requireString, optionalString, optionalNumber, githubSlug, repoTarget, assertHasRemote } from '../command-kit.js';

export interface TasksCommands {
  list_tasks: { args: { repoPath: string }; result: { tasks: BoardTask[]; capped: boolean } };
  /** HUB_ONLY: `list_tasks` across every hub repository, each card stamped with its repository. */
  list_tasks_all: { args: { teamId?: string } | undefined; result: { tasks: (BoardTask & RepoStamp)[]; capped: boolean; failures: RepoReadFailure[] } };
  fetch_spec: { args: { repoPath: string; taskId: string }; result: { spec: string } };
  api_create_task: { args: { repoPath: string; title: string; body: string; baseBranch?: string }; result: CreatedTask };
  /** HUB_ONLY, read-only: the target branches a card may name (repo default + `baseBranches` allowlist) and the configured default, for the new-card form. */
  list_branches: { args: { repoPath: string }; result: { branches: string[]; default?: string } };
  /** HUB_ONLY: apply a trigger label to a GitHub issue of the project (src/hub/start-task.ts). */
  start_task: { args: { repoPath: string; number: number; label: string }; result: StartTaskResult };
}

/** GitHub's cap on a label name. */
const MAX_LABEL_LENGTH = 50;

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
    const params: CreateTaskParams = {
      source: cfg.source ?? 'github',
      repoPath: real,
      title,
      body,
      ...(labels.length > 0 ? { labels } : {}),
      ...(cfg.team !== undefined ? { team: cfg.team } : {}),
    };
    // Linear needs no code host; `gh`/`glab issue create` do.
    if (params.source !== 'linear') await assertHasRemote(real, params.source === 'github');
    return invokeCoreMethod(ctx.deps, 'createTask', params);
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
  start_task: { action: 'task-start', target: (a) => `${repoTarget(a) ?? ''}#${String(optionalNumber(a, 'number') ?? '')}` },
});
