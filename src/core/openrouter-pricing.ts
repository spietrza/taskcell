/** USD per 1M tokens on OpenRouter; cacheRead stored explicitly (never derived from input). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  /** OpenRouter slug this row was priced from (documentation/traceability). */
  openRouterModel: string;
}

// Prices as of 2026-07-01, source openrouter.ai/api/v1/models; refresh by hand on model updates.
// Base routes only — do NOT map to premium `-fast` routes.
// Aliases (opus/sonnet/haiku) point to the current-generation base route; refresh together with dated rows.
export const PRICED_MODELS = {
  // Claude 5.5 generation + Fable 5.1 — fetched 2026-10-07. The `sonnet`/`opus`/`haiku` CLI aliases
  // resolve to these on the subscription (verified via the served `model` field in the stream).
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, openRouterModel: 'anthropic/claude-sonnet-5.5' },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, openRouterModel: 'anthropic/claude-opus-5.5' },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, openRouterModel: 'anthropic/claude-haiku-5.5' },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, openRouterModel: 'anthropic/claude-fable-5.1' },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, openRouterModel: 'anthropic/claude-fable-5' },
  // Previous generation, still served when pinned by full id.
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, openRouterModel: 'anthropic/claude-opus-4.8' },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, openRouterModel: 'anthropic/claude-sonnet-4.6' },
  // Still $2/$10 live on 2026-10-07 (the introductory rate was announced to end 2026-08-31; it did not).
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, openRouterModel: 'anthropic/claude-sonnet-5' },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, openRouterModel: 'anthropic/claude-haiku-4.5' },
  'glm-5.2': { input: 0.93, output: 3, cacheRead: 0.18, openRouterModel: 'z-ai/glm-5.2' },
} satisfies Record<string, ModelPricing>;

// OpenAI models Codex runs on — checked 2026-11-15 against openrouter.ai/api/v1/models. A Codex run
// reports tokens but no cost; these price them as an estimate (never written to `costUsd`). Kept out
// of OPENROUTER_PRICING: that table is also the bare-name map of `--provider openrouter`, which
// runs the Claude CLI and must keep rejecting a bare `gpt-*` name.
export const CODEX_PRICED_MODELS = {
  // The review model the docs recommend (checked 2026-11-24); gpt-5.6-sol is being retired.
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, openRouterModel: 'openai/gpt-6-sol' },
  'gpt-5.6-sol': { input: 4.4, output: 22, cacheRead: 0.44, openRouterModel: 'openai/gpt-5.6-sol' },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, openRouterModel: 'openai/gpt-6.1-sol' },
  'gpt-6.1-terra': { input: 1, output: 5, cacheRead: 0.05, openRouterModel: 'openai/gpt-6.1-terra' },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, openRouterModel: 'openai/gpt-5' },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, openRouterModel: 'openai/gpt-5.5' },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, openRouterModel: 'openai/gpt-5.4' },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, openRouterModel: 'openai/gpt-5.3-codex' },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, openRouterModel: 'openai/gpt-5.2-codex' },
  // cacheRead 0.13 and 0.03 (codex, codex-mini) are what the live API returns (checked 2026-11-15), not 0.125 / 0.025 rounded.
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.13, openRouterModel: 'openai/gpt-5.1-codex' },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheRead: 0.125, openRouterModel: 'openai/gpt-5.1-codex-max' },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.03, openRouterModel: 'openai/gpt-5.1-codex-mini' },
} satisfies Record<string, ModelPricing>;

export const OPENROUTER_PRICING: Record<string, ModelPricing> = {
  ...PRICED_MODELS,
  // CLI aliases used by the pipeline (src/pipeline/pipeline.ts); map to the current-generation base
  // route. Re-point these when the served alias moves (check: `claude -p ok --model sonnet --verbose
  // --output-format stream-json | grep -o '"model":"[^"]*"'`).
  opus: PRICED_MODELS['claude-opus-5-5'],
  sonnet: PRICED_MODELS['claude-sonnet-5-5'],
  haiku: PRICED_MODELS['claude-haiku-5-5'],
  // OpenRouter slug keys (the `--provider openrouter` model string, e.g. from OPENROUTER_DEFAULT_MODEL),
  // derived from each row's own openRouterModel field so they can't drift out of sync with it.
  ...Object.fromEntries(Object.values(PRICED_MODELS).map((p) => [p.openRouterModel, p])),
};

export interface EstimateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * OpenRouter-priced estimate in USD, or undefined for an unknown/unmapped model. `cachedInInput` is set by
 * the provider (Codex) that counts cached tokens inside `inputTokens`; they are split out for pricing only.
 */
export function estimateOpenRouterCost(usage: EstimateUsage, model: string | undefined, cachedInInput = false): number | undefined {
  if (model === undefined) return undefined;
  const codex = cachedInInput && Object.hasOwn(CODEX_PRICED_MODELS, model);
  const table: Record<string, ModelPricing> = codex ? CODEX_PRICED_MODELS : OPENROUTER_PRICING;
  const p = Object.hasOwn(table, model) ? table[model] : undefined; // own keys only: `constructor` is not a model
  if (p === undefined) return undefined;
  const input = cachedInInput ? Math.max(0, usage.inputTokens - usage.cacheReadInputTokens) : usage.inputTokens;
  return (input * p.input + usage.outputTokens * p.output + usage.cacheReadInputTokens * p.cacheRead) / 1_000_000;
}
