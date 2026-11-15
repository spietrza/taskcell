// Hub commands: the task board and creating/starting tasks. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { assertSkillsInstalled, namedSkillsProblem } from '../../context/named-skills.js';
import { hubSkillsDir, skillRegistryForRun } from '../../context/skill-registry.js';
import { TaskcellError, visibleError } from '../../core/errors.js';
import { resolveTaskRef } from '../../tasks/board.js';
import { setTaskSkills } from '../../tasks/create.js';
import { BadRequestError, invokeCoreMethod, type CreateTaskParams } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { BASE_LABEL_PREFIX, assertAllowedBase, assertSafeBaseBranch, readAllowedBases, readRepoBaseBranch } from '../../core/base-branch.js';
import { readAppConfig } from '../app-config.js';
import * as projects from '../projects.js';
import { startGithubTask, triggerLabelsFor } from '../start-task.js';
import type { BoardTask, CreatedTask, RepoReadFailure, RepoStamp, StartTaskResult } from '../../wire.js';
import { defineCommands, requireString, optionalString, optionalNumber, githubSlug, repoTarget, repoItemTarget, assertHasRemote } from '../command-kit.js';

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
  /** HUB_ONLY, read-only: the ids of the skills a run of this project can load (what a hand-picked list is checked against). */
  list_skills: { args: { repoPath: string }; result: { skills: string[] } };
  /** HUB_ONLY: write a card's hand-picked skills to its task as the body's `Skills:` line (an empty list removes it). */
  set_task_skills: { args: { repoPath: string; taskId: string; skills: string[] }; result: { skills: string[] } };
}

/** GitHub's cap on a label name. */
const MAX_LABEL_LENGTH = 50;

/** The skills a run of this project loads: the hub's skills dir plus the repo's own. A broken dir or lock is the caller's to fix (400, with the reason). */
async function installedSkills(repoPath: string): Promise<string[]> {
  try {
    return (await skillRegistryForRun(hubSkillsDir(), repoPath)).ids().sort();
  } catch (error) {
    throw new BadRequestError(`Skills cannot be listed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The targets a card may name (the allowlist a run enforces, see readAllowedBases), plus the repo's configured default. */
async function listBranches(repoPath: string): Promise<{ branches: string[]; default?: string }> {
  const [allowed, dflt] = await Promise.all([readAllowedBases(repoPath), readRepoBaseBranch(repoPath)]);
  return { branches: [...allowed].sort(), ...(dflt !== undefined ? { default: dflt } : {}) };
}

export const commands = defineCommands<TasksCommands>({
  list_skills: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return { skills: await installedSkills(real) };
  },
  set_task_skills: async ({ ctx, args, allow }) => {
    // Edits the issue body as the hub's tracker identity — a remote mutation. Every refusal happens before any write.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    const taskId = requireString(args, 'taskId');
    const skills = args.skills;
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) throw new BadRequestError('skills must be an array of skill ids');
    const names = [...new Set(skills as string[])];
    const problem = namedSkillsProblem(names);
    if (problem !== undefined) throw new BadRequestError(`skills ${problem}`);
    const source = resolveTaskRef(taskId)?.source;
    if (source === undefined) throw new BadRequestError(`taskId ${JSON.stringify(taskId.slice(0, 80))} names no GitHub, GitLab or Linear task`);
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
  set_task_skills: { action: 'task-edit', target: repoItemTarget('taskId'), detail: async () => ['skills'] },
  start_task: { action: 'task-start', target: (a) => `${repoTarget(a) ?? ''}#${String(optionalNumber(a, 'number') ?? '')}` },
});
