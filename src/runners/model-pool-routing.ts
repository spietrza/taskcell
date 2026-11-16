import { validateProviderChoice, makeProvider, claudeCliKeyEnv } from '../agents/registry.js';
import type { CustomProviderEntry } from '../agents/registry.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { ProviderChoice } from '../agents/registry.js';
import { orderCandidates, parseFallbackList, poolOf, entryKey, pickIndex, isPoolSyntax, parseModelPool } from '../core/model-pool.js';
import type { ModelPick, PoolCandidate, PoolEntry } from '../core/model-pool.js';

/** The run-level model settings a pool resolves into (the RunOptions subset). */
export interface PoolRoutedOptions extends ProviderChoice {
  providerModel?: string;
  reviewModel?: string;
  escalateModel?: string;
  fallbackModel?: string;
}

/** What a stage tier ran on and why: written to the run record (`modelPicks`) and the metric line. */
export interface StagePick {
  provider: string;
  model?: string;
  pick: ModelPick;
}

export interface PoolRouting<T extends PoolRoutedOptions> {
  /** The options with every pool replaced by the concrete provider/model this task runs on. */
  options: T;
  /** Per tier (`implementer`, `fallback`, `reviewer`, `escalate`): the pick. Empty when no pool or list is configured. */
  picks: Record<string, StagePick>;
  /** True when a pool or a fallback list is configured: limits are then recorded as cool-downs. */
  pooled: boolean;
}

/** True when one sandbox can host `choice` (validateProviderChoice accepts it). */
function hostable(choice: ProviderChoice): boolean {
  try {
    validateProviderChoice(choice);
    return true;
  } catch {
    return false;
  }
}

/** The fallback candidate one sandbox can host next to `provider`/`reviewProvider` (distinct transport); undefined when none. */
function compatibleFallback(base: ProviderChoice, candidates: readonly PoolCandidate[]): PoolCandidate | undefined {
  return candidates.find((c) => c.provider !== base.provider && hostable({ ...base, fallbackProvider: c.provider }));
}

/**
 * Resolve the implementer, reviewer and escalate pools for one task. A value that is not pool syntax
 * and a single `--fallback-provider` leave the options untouched (today's behaviour exactly). A
 * `taskcell:model=` label beats the implementer pool's model (its provider is the rotation pick's).
 * The implementer's in-run fallback is the first later candidate (rest of the pool, then the
 * fallback list) on a transport the sandbox can host; entries cooling down after a limit go last.
 */
export function routeModelPools<T extends PoolRoutedOptions>(
  opts: T,
  taskId: string,
  ctx: { isProvider: (name: string) => boolean; cooling: (key: string) => boolean; labelModel?: string },
): PoolRouting<T> {
  const implPool = poolOf(opts.providerModel, ctx.isProvider, '--provider-model');
  const reviewPool = poolOf(opts.reviewModel, ctx.isProvider, '--review-model');
  const escalatePool = poolOf(opts.escalateModel, ctx.isProvider, '--escalate-model');
  const fallbackList = parseFallbackList(opts.fallbackProvider, opts.fallbackModel);
  const pooled = implPool !== undefined || reviewPool !== undefined || escalatePool !== undefined || fallbackList.length > 1;
  if (!pooled) return { options: opts, picks: {}, pooled: false };

  const picks: Record<string, StagePick> = {};
  const next: T = { ...opts };
  delete next.fallbackProvider;
  delete next.fallbackModel;

  // Implementer tier.
  const primaryPool: PoolEntry[] = implPool ?? [{ provider: opts.provider ?? 'claude', model: opts.providerModel ?? '', weight: 1 }];
  const candidates = orderCandidates(primaryPool, taskId, fallbackList, ctx.cooling).map((c) => (c.model === '' ? { provider: c.provider, pick: c.pick } : c));
  const primary = candidates[0]!;
  next.provider = primary.provider;
  if (ctx.labelModel !== undefined) {
    next.providerModel = ctx.labelModel;
    picks.implementer = { provider: primary.provider, model: ctx.labelModel, pick: 'label' };
  } else {
    if (primary.model !== undefined) next.providerModel = primary.model;
    else delete next.providerModel;
    picks.implementer = { ...primary, pick: implPool !== undefined ? primary.pick : 'config' };
  }

  // Reviewer tier: its own rotation (keyed on the task id too, but salted so it does not mirror the implementer's).
  if (reviewPool !== undefined) {
    const order = orderCandidates(reviewPool, `${taskId}#reviewer`, [], ctx.cooling);
    const fits = order.find(
      (c) => c.provider === primary.provider || hostable({ provider: primary.provider, reviewProvider: c.provider, ...(next.customProviders !== undefined ? { customProviders: next.customProviders } : {}) }),
    ) ?? order[0]!;
    if (fits.provider === next.provider) delete next.reviewProvider;
    else next.reviewProvider = fits.provider;
    next.reviewModel = fits.model!;
    picks.reviewer = { provider: fits.provider, model: fits.model!, pick: fits.pick };
  }

  // Escalate tier: --escalate-model names a model of the implementer's provider, so only those entries qualify.
  if (escalatePool !== undefined) {
    const own = escalatePool.filter((e) => e.provider === next.provider && !ctx.cooling(entryKey(e)));
    const usable = own.length > 0 ? own : escalatePool.filter((e) => e.provider === next.provider);
    if (usable.length === 0) {
      delete next.escalateModel;
    } else {
      const entry = usable[pickIndex(usable, `${taskId}#escalate`)]!;
      next.escalateModel = entry.model;
      picks.escalate = { provider: entry.provider, model: entry.model, pick: 'rotation' };
    }
  }

  const fallback = compatibleFallback(
    {
      provider: primary.provider,
      ...(next.reviewProvider !== undefined ? { reviewProvider: next.reviewProvider } : {}),
      ...(next.customProviders !== undefined ? { customProviders: next.customProviders } : {}),
    },
    candidates.slice(1),
  );
  if (fallback !== undefined) {
    next.fallbackProvider = fallback.provider;
    if (fallback.model !== undefined) next.fallbackModel = fallback.model;
    picks.fallback = fallback;
  }
  return { options: next, picks, pooled: true };
}

/**
 * A flow stage whose `model` is a pool (the Hub Workflow editor's per-stage pool): pick its entry by
 * weight for this task (salted with the stage name), skipping entries cooling down. An entry on the
 * run's provider sets only the model; one on another provider also pins the stage to it, under the
 * same rule as a flow `provider` pin (no provider that owns the Claude CLI transport). Returns the
 * stages plus each pooled stage's pick.
 */
export function resolveFlowStagePools(
  stages: readonly PipelineStage[],
  taskKey: string,
  ctx: { runProvider: string; isProvider: (name: string) => boolean; cooling: (key: string) => boolean; customProviders?: readonly CustomProviderEntry[] },
): { stages: PipelineStage[]; picks: Record<string, StagePick> } {
  const picks: Record<string, StagePick> = {};
  const out = stages.map((stage) => {
    if (stage.model === undefined || !isPoolSyntax(stage.model)) return stage;
    const pool = parseModelPool(stage.model, ctx.isProvider, `stage "${stage.name}" model`).filter(
      (e) => e.provider === ctx.runProvider || claudeCliKeyEnv(e.provider, ctx.customProviders) === undefined,
    );
    if (pool.length === 0) throw new Error(`stage "${stage.name}" model pool has no entry this run can serve (another provider on the Claude CLI transport); set it as the run's --provider instead`);
    const order = orderCandidates(pool, `${taskKey}#${stage.name}`, [], ctx.cooling);
    const entry = order[0]!;
    picks[stage.name] = { provider: entry.provider, model: entry.model!, pick: entry.pick };
    const { provider: _pinned, ...rest } = stage;
    return {
      ...rest,
      model: entry.model!,
      ...(entry.provider !== ctx.runProvider ? { provider: makeProvider(entry.provider, ctx.customProviders) } : {}),
    };
  });
  return { stages: out, picks };
}
