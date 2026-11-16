import { cacheEfficiency } from '../agents/provider.js';
import { roundUsd } from './usd.js';
import { estimateOpenRouterCost } from './openrouter-pricing.js';
import { parseSkillsUsed, sanitizeSkillIds } from './skills-used.js';
import type { ExitReason, RunResult } from './types.js';

/** Flat, single-source metric shape consumed by metrics.jsonl, the run summary, and logs. */
export interface StageMetric {
  taskId: string;
  /** Stage name, present only when building a stage-scoped metric. */
  stage?: string;
  exitReason: ExitReason;
  completed: boolean;
  turns: number;
  costUsd: number;
  /** API-price estimate (OpenRouter rates) for a run that reported no cost; never mixed into `costUsd`. */
  estCostUsd?: number;
  cacheEfficiency: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
  /** Model actually used for the run, when known. */
  model?: string;
  /** Model the stage was configured to run on, when it was set explicitly (differs from `model` on a gateway swap). */
  requestedModel?: string;
  /** Agent calls folded into this stage (resumes/repairs/fork variants); present only when more than one. */
  attempts?: number;
  /** Exit reason of the first attempt; present only when attempts > 1. */
  firstExitReason?: ExitReason;
  /** Effective per-stage budget cap in USD; present only when a finite cap is in effect. */
  stageCapUsd?: number;
  /** Remaining global budget before this stage started; present only when the global budget is finite. */
  remainingBudgetUsd?: number;
  /** Typed reason this stage stopped, when it was not a change failure. */
  stoppedBy?: 'provider-limit';
}

export type StageBudgetInfo = Pick<StageMetric, 'stageCapUsd' | 'remainingBudgetUsd'>;
export type StageMetricExtras = StageBudgetInfo & Pick<StageMetric, 'requestedModel'>;

/** Estimate for a run with usage and a priced model but no provider-reported cost; undefined otherwise. */
export function estimatedCostUsd(result: RunResult): number | undefined {
  if (result.costUsd !== undefined || result.usage === undefined) return undefined;
  if (result.mergedEstCostUsd !== undefined) return result.mergedEstCostUsd ?? undefined;
  const est = estimateOpenRouterCost(result.usage, result.model, result.cachedInInput === true);
  return est === undefined ? undefined : roundUsd(est);
}

/**
 * Build the canonical flat metric for a run result. Numeric fields default to 0 when absent so the
 * metric shape is stable. `stage` is included only when `stageName` is provided.
 */
export function stageMetric(result: RunResult, stageName?: string, extras?: StageMetricExtras): StageMetric {
  const est = estimatedCostUsd(result);
  return {
    taskId: result.taskId,
    ...(stageName !== undefined ? { stage: stageName } : {}),
    exitReason: result.exitReason,
    completed: result.completed,
    turns: result.turns,
    costUsd: result.costUsd ?? 0,
    ...(est !== undefined ? { estCostUsd: est } : {}),
    cacheEfficiency: result.cacheEfficiency ?? 0,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
    durationMs: result.durationMs ?? 0,
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(extras?.requestedModel !== undefined ? { requestedModel: extras.requestedModel } : {}),
    ...(result.attempts !== undefined && result.attempts > 1
      ? { attempts: result.attempts, ...(result.firstExitReason !== undefined ? { firstExitReason: result.firstExitReason } : {}) }
      : {}),
    ...(extras?.stageCapUsd !== undefined ? { stageCapUsd: extras.stageCapUsd } : {}),
    ...(extras?.remainingBudgetUsd !== undefined ? { remainingBudgetUsd: extras.remainingBudgetUsd } : {}),
    ...(result.stoppedBy !== undefined ? { stoppedBy: result.stoppedBy } : {}),
  };
}

/** Sum two optional numbers; undefined only when both sides are absent. */
const sumOpt = (a?: number, b?: number): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/**
 * Fold a follow-up attempt (auto-resume, gate repair, losing fork variant) into a stage's result so
 * the persisted stage metric reflects what the stage actually cost. Identity fields (session,
 * completion, exit reason, final text, model) come from `next`; cost, turns, tokens and duration are
 * summed. Without this, metrics.jsonl recorded only the LAST attempt of a resumed/repaired stage.
 * The stage reads as its final state, but `attempts` and `firstExitReason` keep the truncation visible
 * (retrospective memory reports a repaired-after-maxTurns implementer, not a clean run).
 */
export function mergeAttempts(prior: RunResult, next: RunResult): RunResult {
  const usage =
    prior.usage !== undefined || next.usage !== undefined
      ? {
          inputTokens: sumOpt(prior.usage?.inputTokens, next.usage?.inputTokens) ?? 0,
          outputTokens: sumOpt(prior.usage?.outputTokens, next.usage?.outputTokens) ?? 0,
          cacheReadInputTokens: sumOpt(prior.usage?.cacheReadInputTokens, next.usage?.cacheReadInputTokens) ?? 0,
        }
      : undefined;
  const costUsd = sumOpt(prior.costUsd, next.costUsd);
  const durationMs = sumOpt(prior.durationMs, next.durationMs);
  // Attempts on different models (a cross-provider fallback) are priced each at its own rate.
  const mixedModels = prior.model !== next.model || prior.cachedInInput !== next.cachedInInput || prior.mergedEstCostUsd !== undefined || next.mergedEstCostUsd !== undefined;
  // An attempt without usage (it died before reporting any) adds nothing; it does not make the rest unpriceable.
  const attemptEst = (r: RunResult): number | undefined => (r.usage === undefined ? 0 : estimatedCostUsd(r));
  const priorEst = attemptEst(prior);
  const nextEst = attemptEst(next);
  const estCostUsd = costUsd !== undefined || !mixedModels ? undefined : priorEst !== undefined && nextEst !== undefined ? roundUsd(priorEst + nextEst) : null;
  const skillsUsed = sanitizeSkillIds([
    ...(prior.skillsUsed ?? parseSkillsUsed(prior.transcript)),
    ...(next.skillsUsed ?? parseSkillsUsed(next.transcript)),
  ]);
  return {
    ...next,
    ...(estCostUsd !== undefined ? { mergedEstCostUsd: estCostUsd } : {}),
    turns: prior.turns + next.turns,
    attempts: (prior.attempts ?? 1) + (next.attempts ?? 1),
    firstExitReason: prior.firstExitReason ?? prior.exitReason,
    ...(usage !== undefined ? { usage, cacheEfficiency: cacheEfficiency(usage) } : {}),
    ...(costUsd !== undefined ? { costUsd: roundUsd(costUsd) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    skillsUsed,
  };
}
