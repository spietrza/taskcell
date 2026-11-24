import { TaskcellError } from '../core/errors.js';
import { decisionModelConfig, decisionEgressAllowed, decisionModelMissing, DECISION_MODEL_DEFAULT, type DecisionModelConfig } from '../core/decision-model.js';
import { readEnv } from '../core/env.js';
import { forcedProviderModel, isProviderName } from '../agents/registry.js';
import type { CustomProviderEntry } from '../agents/registry.js';
import { labelValue } from '../core/labels.js';
import { resolveTargetBase } from '../core/base-branch.js';
import { poolTaskKey } from '../core/model-pool.js';
import { routeModelPools, resolveFlowStagePools } from './model-pool-routing.js';
import type { PoolRouting, StagePick } from './model-pool-routing.js';
import { assembleReviewPipeline, implementReviewSimplifyStages, withPrimaryFallback, withStageFallback, withStageFallbackModel, withStageMaxTurns, withStageModel, withStageModelExcept, withStageProvider, withStageResumeUntilComplete, STAGE } from '../pipeline/pipeline.js';
import type { ReviseGithubPrDeps } from './revise-pr.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import { FLOWS } from '../api/capabilities.js';
import { resolveRepoFlow, unknownFlowError } from '../flows/repo.js';
import { assertSkillsInstalled, normalizeSkillNames, parseSkillsLine, providerSupportsSkills, withNamedSkills } from '../context/named-skills.js';
import type { RunSkills } from '../core/run-store.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentProvider } from '../agents/provider.js';
import type { RunIssueDeps, Tracker } from './source-adapter.js';

/** Issue label that pins the implementer-tier model for ONE task: `taskcell:model=<model>`. */
export const MODEL_LABEL_PREFIX = 'taskcell:model=';

/**
 * Model ids/aliases/slugs as every supported provider spells them (`opus`, `claude-sonnet-5`,
 * `anthropic/claude-sonnet-4.6`, `gpt-5.6-sol`, `glm-5.2`). Labels are a lower-trust input than a CLI
 * flag — anyone with triage permission can set one — so the value is allowlisted by shape before it
 * becomes a `--model` argument, even though the arg is shell-quoted downstream.
 */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * Per-task model override from the issue's labels. A human judging "this one is hard" beats any
 * pre-run heuristic, so the label wins over the fleet-wide --provider-model. Last well-formed
 * matching label wins; an empty or malformed value is ignored (and reported via `onInvalid`).
 */
export function modelFromLabels(labels: ReadonlyArray<string>, onInvalid?: (label: string) => void): string | undefined {
  let model: string | undefined;
  for (const label of labels) {
    const raw = labelValue(label, MODEL_LABEL_PREFIX);
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value === '') continue;
    if (!MODEL_NAME_RE.test(value)) {
      onInvalid?.(label);
      continue;
    }
    model = value;
  }
  return model;
}

/** Cap on implement-session resumes triggered by a failing conformance/verify gate, before falling back to a declared-partial PR. */
export const MAX_REPAIR_ITERATIONS = 2;

/** Stages that run on the primary agent's tier (the rest carry their own provider/model). */
export const REVIEW_TIER: ReadonlySet<string> = new Set([STAGE.REVIEWER, STAGE.CONFORMANCE]);

/** The flow a run uses: `--flow`, else `plan` for the `--plan` alias, else undefined (the tracker's own stages). */
export function flowOf(deps: Pick<RunIssueDeps, 'flow' | 'plan'>): string | undefined {
  return deps.flow ?? (deps.plan === true ? 'plan' : undefined);
}

/**
 * Resolve a flow name to its base stage array. 'default' (and no flow at all) means "this
 * tracker's own stages", NOT FLOWS.default.build. They are not the same: the Linear tracker's
 * stages() swaps in an implementer that reads the issue via the linear-cli skill, while
 * FLOWS.default.build is the generic implementReviewSimplifyStages. Selecting 'default' by name —
 * the natural thing for a name-driven UI — must not silently downgrade a Linear run to an
 * implementer that never reads the issue. Non-built-in names resolve from the repo's
 * `.taskcell/flows/*.hcl` (S5); unknown names throw listing both sets.
 */
export async function resolveBaseStages(
  flow: string | undefined,
  repoPath: string,
  tracker: Pick<Tracker, 'stages'>,
  customProviders?: readonly CustomProviderEntry[],
): Promise<PipelineStage[]> {
  if (flow === undefined || flow === 'default') return tracker.stages();
  if (Object.hasOwn(FLOWS, flow)) return FLOWS[flow]!.build();
  const stages = await resolveRepoFlow(flow, repoPath, customProviders);
  if (stages === undefined) throw await unknownFlowError(flow, repoPath);
  return stages;
}

/**
 * White-label branch id: the trailing issue number (e.g. `gh-…-904` → `904`), else a
 * Conventional-Branch-safe slug of the taskId. Used for `feat/<id>-<hash>` branches in white-label mode.
 */
export function branchIdFromTaskId(taskId: string): string {
  const trailingNumber = /(\d+)$/.exec(taskId)?.[1];
  if (trailingNumber !== undefined) return trailingNumber;
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug === '' ? 'task' : slug;
}

/** Whether a pool entry's provider is a built-in or a repo-configured custom one. */
function poolProviderCheck(customProviders: readonly CustomProviderEntry[] = []): (name: string) => boolean {
  return (name) => isProviderName(name) || customProviders.some((c) => c.name === name);
}

/** Pool entries a run must skip: a cool-down file's keys plus the entries that hit a limit earlier in this run. */
export interface PoolCooling {
  cooldowns: ReadonlyMap<string, unknown>;
  exhausted: ReadonlySet<string>;
}

/** Model pools resolved for one task: the run-level picks, and the flow stages' own pool picks. */
export interface PoolPlan {
  routing: PoolRouting<RunIssueDeps>;
  flowPools: ReturnType<typeof resolveFlowStagePools>;
}

/** Resolve every model pool of a run to one provider/model for this task, skipping cooling entries. */
export function routeIssuePools(
  configuredDeps: RunIssueDeps,
  baseStages: PipelineStage[],
  taskId: string,
  labelModel: string | undefined,
  cooling: PoolCooling,
): PoolPlan {
  const poolProvider = poolProviderCheck(configuredDeps.customProviders);
  const isCooling = (key: string): boolean => cooling.cooldowns.has(key) || cooling.exhausted.has(key);
  const routing = routeModelPools(configuredDeps, poolTaskKey(taskId), {
    isProvider: poolProvider,
    cooling: isCooling,
    ...(labelModel !== undefined ? { labelModel } : {}),
  });
  // A flow stage whose model is a pool (Workflow editor) resolves to one entry for this task; an entry on
  // another provider pins the stage to it, and that provider's credential joins the run's secrets.
  const flowPools = resolveFlowStagePools(baseStages, poolTaskKey(taskId), {
    runProvider: routing.options.provider ?? 'claude',
    isProvider: poolProvider,
    cooling: isCooling,
    ...(configuredDeps.customProviders !== undefined ? { customProviders: configuredDeps.customProviders } : {}),
  });
  return { routing, flowPools };
}

/** Everything a run decides before its sandbox starts. A value: building it starts nothing and writes nothing. */
export interface IssueRunPlan {
  /** The flow key as named (`--flow` / `--plan`); undefined = the tracker's own stages. */
  flow: string | undefined;
  /** The fetched task, with a `--spec-file` layered on as a virtual comment. */
  task: Task;
  /** The worktree/task id the tracker derives from the task. */
  runTaskId: string;
  /** `--commit-author`: a plain, human-looking PR with no Taskcell branding. */
  whiteLabel: boolean;
  /** The per-task `taskcell:model=` label, which beats `--provider-model`. */
  labelModel: string | undefined;
  /** The options with every model pool resolved to this task's provider/model. */
  deps: RunIssueDeps;
  /** The deps handed to agent selection: `deps` plus the providers flow stages are pinned to. */
  choice: RunIssueDeps;
  routing: PoolRouting<RunIssueDeps>;
  flowPools: ReturnType<typeof resolveFlowStagePools>;
  /** Run-level picks plus flow-pool picks, as the run record shows them. */
  recordedPicks: Record<string, StagePick>;
  /** The base flow's stages, before pool routing. */
  baseStages: PipelineStage[];
  /** Skills named by hand (`--skill` plus the body's `Skills:` line). */
  namedSkills: string[];
  skillsLine: ReturnType<typeof parseSkillsLine>;
  /** The ids of every installed skill. */
  skillIds: string[];
  /** The branch the run cuts from and the PR targets. */
  baseBranch: string;
  /** Log lines the decisions produced, in order. */
  logs: string[];
  /** Warnings the decisions produced (malformed labels). */
  warnings: string[];
  /** Resolve the pools again with more entries out: the escape from a pool entry that hit a limit. */
  reroute(exhausted: ReadonlySet<string>): PoolPlan;
}

export interface IssueRunPlanInput {
  /** The task as the tracker fetched it. */
  fetchedTask: Task;
  deps: RunIssueDeps;
  /** The flow's stages, from {@link resolveBaseStages}. */
  baseStages: PipelineStage[];
  tracker: Pick<Tracker, 'taskId'>;
  /** The installed skills' ids. */
  skillIds: readonly string[];
  /** The text of `--spec-file`, already read. */
  specFileText?: string;
  cooldowns: ReadonlyMap<string, unknown>;
  exhausted: ReadonlySet<string>;
}

/**
 * Decide a run: flow, task, white-label, model picks, skills and base branch. Reads only config (the
 * repo's allowed bases and default branch) — no sandbox, no provider, no tracker call.
 */
export async function planIssueRun(input: IssueRunPlanInput): Promise<IssueRunPlan> {
  const { fetchedTask, deps: configuredDeps, baseStages } = input;
  const logs: string[] = [];
  const warnings: string[] = [];
  const skillsLine = parseSkillsLine(fetchedTask.description);
  // `--skill` plus the task body's `Skills:` line. An unknown id stops the run before any model call.
  // A `Skills:` line that is not a list of skill ids (prose) selects nothing and leaves a note; it never refuses the run.
  const namedSkills = normalizeSkillNames([...(configuredDeps.namedSkills ?? []), ...(configuredDeps.namedSkillsOnly === true ? [] : skillsLine.skills)]);
  assertSkillsInstalled(namedSkills, input.skillIds);
  // --spec-file: layered onto the fetched task as a virtual comment, so the implementer prompt
  // ({{COMMENTS}}), triage and the conformance manifest read it like a posted spec. Copy, don't mutate.
  const task: Task =
    input.specFileText === undefined
      ? fetchedTask
      : { ...fetchedTask, comments: [...fetchedTask.comments, { author: 'spec-file', authorAssociation: 'OWNER', body: input.specFileText }] };
  const runTaskId = input.tracker.taskId(task);
  const labelModel = modelFromLabels(task.labels, (label) => warnings.push(`taskcell: ${task.id} ignoring malformed model label ${JSON.stringify(label)}`));
  const reroute = (exhausted: ReadonlySet<string>): PoolPlan =>
    routeIssuePools(configuredDeps, baseStages, task.id, labelModel, { cooldowns: input.cooldowns, exhausted });
  const { routing, flowPools } = reroute(input.exhausted);
  const deps = routing.options;
  for (const [tier, p] of Object.entries(routing.picks)) {
    logs.push(`taskcell: ${task.id} ${tier} → ${p.provider}${p.model !== undefined ? `/${p.model}` : ''} (${p.pick})`);
  }
  // Kept apart from routing.picks: flow stages are named like tiers (`implementer`), and the run-level picks must
  // stay what simplifier/repair/conformance draw on. Merged only into what the run record shows.
  const recordedPicks: Record<string, StagePick> = { ...routing.picks };
  for (const [name, p] of Object.entries(flowPools.picks)) {
    recordedPicks[name] = { ...p, pick: p.pick === 'rotation' ? 'flow' : p.pick };
    logs.push(`taskcell: ${task.id} ${name} → ${p.provider}/${p.model ?? ''} (flow pool, ${p.pick})`);
  }
  const stagePinned = [...new Set(Object.values(flowPools.picks).map((p) => p.provider))].filter((n) => n !== (deps.provider ?? 'claude'));
  const choice = { ...deps, ...(stagePinned.length > 0 ? { stageProviders: stagePinned } : {}) };
  // The target branch: --base, else the card's `taskcell:base=` label, else app.json's default. An unsafe
  // value is refused here, before the sandbox, so nothing runs against the wrong branch.
  const baseBranch = await resolveTargetBase(deps.repoPath, task.labels, deps.baseBranch);
  return {
    flow: flowOf(configuredDeps),
    task,
    runTaskId,
    whiteLabel: configuredDeps.commitAuthor !== undefined,
    labelModel,
    deps,
    choice,
    routing,
    flowPools,
    recordedPicks,
    baseStages,
    namedSkills,
    skillsLine,
    skillIds: [...input.skillIds],
    baseBranch,
    logs,
    warnings,
    reroute,
  };
}

/** The names of the providers a run's agent stages use. */
export interface AgentNames {
  agent: string;
  reviewAgent?: string;
  fallbackAgent?: string;
}

/**
 * What the run says about the hand-picked skills (run summary, run event, run record) instead of
 * dropping the list silently. `named` is what the implementer loaded: nothing on a provider that reads no skills.
 */
export function planIssueSkills(plan: Pick<IssueRunPlan, 'deps' | 'namedSkills' | 'skillsLine' | 'skillIds'>, agents: AgentNames): { notes: string[]; record: RunSkills } {
  const { namedSkills, skillsLine } = plan;
  const namedOnly = plan.deps.namedSkillsOnly === true;
  const lineReplaced = namedOnly && skillsLine.skills.some((id) => !namedSkills.includes(id));
  // Every provider an agent stage can run on: one whose CLI reads no skills cannot honour the list.
  const skillless = [...new Set([agents.agent, agents.reviewAgent, agents.fallbackAgent].flatMap((a) => (a !== undefined && !providerSupportsSkills(a) ? [a] : [])))];
  const notes = [
    ...(skillsLine.note !== undefined && !namedOnly ? [skillsLine.note] : []),
    ...(lineReplaced ? [`The issue's "Skills:" line (${skillsLine.skills.join(', ')}) was replaced by the list chosen in the hub (${namedSkills.join(', ') || 'none'}).`] : []),
    ...(namedSkills.length > 0 && skillless.length > 0 ? [`Skills (${namedSkills.join(', ')}) were named, but provider ${skillless.join(', ')} does not support skills; its stages run without them.`] : []),
  ];
  const loads = providerSupportsSkills(agents.agent);
  return {
    notes,
    record: {
      named: loads ? namedSkills : [],
      available: loads ? plan.skillIds.filter((id) => !namedSkills.includes(id)) : [],
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
}

/**
 * The stages the run executes: the flow's, with the named skills, turn cap, resume-until-complete, and the
 * per-stage models and providers applied, and the implementer fallback on every primary-provider stage.
 */
export function planIssuePipeline(
  plan: Pick<IssueRunPlan, 'deps' | 'flowPools' | 'namedSkills' | 'labelModel'>,
  agents: { agent: AgentProvider; reviewAgent?: AgentProvider; fallbackAgent?: AgentProvider },
): PipelineStage[] {
  const { deps, labelModel } = plan;
  // Appended here, not as a template placeholder, so every flow's implementer is told (repo .hcl flows included).
  const skillStages = withNamedSkills(plan.flowPools.stages, plan.namedSkills);
  const turnScoped = deps.maxTurns !== undefined ? withStageMaxTurns(skillStages, deps.maxTurns) : skillStages;
  // --max-repair-iterations also drives auto-resume of an incomplete implementer (not just the gate
  // loop): an under-budget stage that stopped without <promise>COMPLETE</promise> gets nudged to finish.
  const scopedStages = deps.maxRepairIterations !== undefined ? withStageResumeUntilComplete(turnScoped, deps.maxRepairIterations) : turnScoped;
  const providerForcedModel = forcedProviderModel(deps.provider ?? 'claude', deps.customProviders);
  const pipeline = assembleReviewPipeline(scopedStages, agents, {
    ...deps,
    ...(labelModel !== undefined ? { providerModel: labelModel, providerModelIsLabel: true } : {}),
    ...(providerForcedModel !== undefined ? { providerForcedModel } : {}),
  });
  // Implementer fallback: on an AgentError from the primary provider (outage, usage limit, revoked
  // credential) runStages retries the stage once on this provider — same as the reviewer's fallback.
  // Every stage on the primary gets it (simplifier, planner…): the provider that failed the
  // implementer fails them too, and a rescued implementer whose simplifier dies still loses the PR.
  return agents.fallbackAgent !== undefined
    ? withPrimaryFallback(pipeline, { provider: agents.fallbackAgent, ...(deps.fallbackModel !== undefined ? { model: deps.fallbackModel } : {}) })
    : pipeline;
}

/**
 * The pool entry a stage draws on: its flow-pool pick, the reviewer pick, else the implementer pick.
 * Undefined when that stage's tier has no pool (a stage pinned to its own provider, an unpooled reviewer).
 */
export function tierPick(
  plan: Pick<IssueRunPlan, 'deps' | 'routing' | 'flowPools'>,
  stage: string,
  primaryName: string,
): StagePick | undefined {
  const flowPick = plan.flowPools.picks[stage];
  if (flowPick !== undefined) return flowPick;
  if (REVIEW_TIER.has(stage)) {
    const ownReviewer = plan.deps.reviewProvider !== undefined && plan.deps.reviewProvider !== primaryName;
    return plan.routing.picks.reviewer ?? (ownReviewer ? undefined : plan.routing.picks.implementer);
  }
  return plan.flowPools.stages.some((s) => s.name === stage && s.provider !== undefined) ? undefined : plan.routing.picks.implementer;
}

/**
 * Credentials and consent for `--fork-scorer decision`. Checked by the CLI before anything runs and
 * again here as a backstop. A white-label run ships the CLIENT's diff to the decision model, so it
 * needs the same explicit consent as the difficulty probe (TASKCELL_DECISION_PROBE=all).
 */
export function resolveForkScorerConfig(whiteLabel: boolean, env: NodeJS.ProcessEnv = process.env): DecisionModelConfig {
  if (!decisionEgressAllowed(whiteLabel, env)) {
    throw new TaskcellError(
      '--fork-scorer decision on a white-label run (--commit-author) sends the client diff to the decision model; set TASKCELL_DECISION_PROBE=all to allow that.',
    );
  }
  const config = decisionModelConfig(env);
  if (config === undefined) {
    throw new TaskcellError(`--fork-scorer decision: ${decisionModelMissing(readEnv('TASKCELL_DECISION_MODEL', env) ?? DECISION_MODEL_DEFAULT, env)}`);
  }
  return config;
}

/** What a PR revision decides before its sandbox starts. The same model-pool and credential decisions as an issue run, keyed on the PR's source issue. */
export interface RevisionPlan {
  /** The options with every model pool resolved to this PR's provider/model. */
  deps: ReviseGithubPrDeps;
  /** Per tier: the pick the pool made (empty without a pool). */
  poolPicks: Record<string, StagePick>;
  /** The source issue's `taskcell:model=` label, else `--provider-model`. */
  effectiveModel: string | undefined;
}

export interface RevisionPlanInput {
  deps: ReviseGithubPrDeps;
  /** The model the PR's source issue pins by label. */
  labelModel: string | undefined;
  /** The task key the pools rotate on: the id the PR body names (`Closes #N`), else `<repo>#<pr>`. */
  taskKey: string;
  cooldowns: ReadonlyMap<string, unknown>;
}

/**
 * Plan a revision from a PR: keyed on the issue the PR implements, so the revision runs on the entry the
 * implement run picked. A test agent (`_agent`) skips pool routing.
 */
export function planRevision(input: RevisionPlanInput): RevisionPlan {
  const { deps, labelModel } = input;
  if (deps._agent !== undefined) return { deps, poolPicks: {}, effectiveModel: labelModel ?? deps.providerModel };
  const routing = routeModelPools(deps, poolTaskKey(input.taskKey), {
    isProvider: poolProviderCheck(deps.customProviders),
    cooling: (key) => input.cooldowns.has(key),
    ...(labelModel !== undefined ? { labelModel } : {}),
  });
  return { deps: routing.options, poolPicks: routing.picks, effectiveModel: labelModel ?? routing.options.providerModel };
}

/**
 * The revision's stages: implement → review → simplify, with the review on its own provider, the
 * effective model and the review model applied, and the fallbacks wired.
 */
export function planRevisionPipeline(
  deps: ReviseGithubPrDeps,
  agents: { agent: AgentProvider; reviewAgent?: AgentProvider; fallbackAgent?: AgentProvider },
  effectiveModel: string | undefined,
): PipelineStage[] {
  const allStages = implementReviewSimplifyStages();
  const base = deps.noSimplify === true ? allStages.filter((s) => s.name !== STAGE.SIMPLIFIER) : allStages;
  let pipeline = agents.reviewAgent !== undefined ? withStageProvider(base, agents.reviewAgent) : base;
  if (effectiveModel !== undefined) {
    const crossProviderReview = deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
    pipeline = crossProviderReview ? withStageModelExcept(pipeline, effectiveModel, STAGE.REVIEWER) : withStageModel(pipeline, effectiveModel);
  }
  if (deps.reviewModel !== undefined) pipeline = withStageModel(pipeline, deps.reviewModel, STAGE.REVIEWER);
  if (agents.reviewAgent !== undefined) {
    pipeline = withStageFallback(pipeline, { provider: agents.agent, ...(effectiveModel !== undefined ? { model: effectiveModel } : {}) });
  }
  // An explicit --review-model survives the fallback only when the fallback runs on the provider
  // the model was pinned for; a cross-provider fallback keeps --fallback-model / its own default.
  // Outside the fallback-provider branch: the reviewer's same-provider fallback above exists with
  // or without --fallback-provider, and withPrimaryFallback below never touches a stage that
  // already has one.
  if (deps.reviewModel !== undefined) pipeline = withStageFallbackModel(pipeline, deps.reviewModel, agents.agent);
  // Implementer fallback: on an AgentError from the primary provider (outage, usage limit, revoked
  // credential, rate limit) runStages retries the stage once on this provider — same contract as
  // the first delivery's implementer fallback. Every stage on the primary gets it (implementer,
  // simplifier): the provider that failed one fails the other too.
  if (agents.fallbackAgent !== undefined) {
    pipeline = withPrimaryFallback(pipeline, { provider: agents.fallbackAgent, ...(deps.fallbackModel !== undefined ? { model: deps.fallbackModel } : {}) });
  }
  return pipeline;
}
