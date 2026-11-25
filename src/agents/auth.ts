import { CliUsageError } from '../core/errors.js';
import { KEYLESS_PLACEHOLDER_TOKEN } from './custom.js';
import { claudeCliKeyEnv, fallbackProviderNames, llmProxyNeedsNoPrimarySidecar, needsAnthropicAuth, requiresApiKey } from './registry.js';
import type { ProviderChoice } from './registry.js';

/** `token` is the one the run uses; `tokens` lists every subscription token (only when the secret held several, in order). */
export type AgentAuth = { mode: 'subscription'; token: string; tokens?: string[] } | { mode: 'api'; apiKey: string };

export const SUBSCRIPTION_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
export const API_ENV = 'ANTHROPIC_API_KEY';

/**
 * Map an auth choice to the single secret env var to inject into the sandbox. Returns exactly one
 * key so billing is unambiguous (subscription never leaks the API key and vice versa).
 */
export function authSecrets(auth: AgentAuth): Record<string, string> {
  if (auth.mode === 'subscription') return { [SUBSCRIPTION_ENV]: auth.token };
  return { [API_ENV]: auth.apiKey };
}

/**
 * The tokens a CLAUDE_CODE_OAUTH_TOKEN value holds: one per line, blank lines and surrounding whitespace dropped,
 * repeats removed. A single-line value is its own one-element list.
 */
export function subscriptionTokens(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/\r?\n/).map((t) => t.trim()).filter((t) => t !== ''))];
}

/**
 * A copy of `env` whose `CLAUDE_CODE_OAUTH_TOKEN` holds only its first token, for host-side children that hand
 * the variable straight to Claude (the `claude` CLI, the agent SDK); a multi-line value there fails every call.
 */
export function singleTokenEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const [first] = subscriptionTokens(env['CLAUDE_CODE_OAUTH_TOKEN']);
  if (first !== undefined) out['CLAUDE_CODE_OAUTH_TOKEN'] = first;
  return out;
}

/** Map an AgentAuth to the shape startLlmProxy wants (subscription token / api key; `more` = the further tokens to rotate onto). */
export function llmProxyAuth(auth: AgentAuth): { mode: 'subscription' | 'api'; secret: string; more?: string[] } {
  if (auth.mode === 'api') return { mode: 'api', secret: auth.apiKey };
  const [first = auth.token, ...more] = auth.tokens ?? [auth.token];
  return { mode: 'subscription', secret: first, ...(more.length > 0 ? { more } : {}) };
}

/** Resolve Anthropic auth from the environment, preferring the subscription token (Taskcell default). */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AgentAuth | undefined {
  const tokens = subscriptionTokens(env[SUBSCRIPTION_ENV]);
  const [token] = tokens;
  if (token !== undefined) return { mode: 'subscription', token, ...(tokens.length > 1 ? { tokens } : {}) };
  const apiKey = env[API_ENV];
  if (apiKey !== undefined && apiKey !== '') return { mode: 'api', apiKey };
  return undefined;
}

/**
 * Resolve the run's auth for the chosen provider choice. For primary providers that own the Anthropic
 * transport (Zai/OpenRouter), their key is carried as an api-mode AgentAuth — it is NOT an Anthropic
 * credential, but it flows through the same auth slot so the proxy sidecar and dep threading stay
 * uniform. When no used provider needs an Anthropic-family credential, returns undefined rather than
 * throwing. Throws if a required credential is missing.
 */
export function agentAuthFromEnv(
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuth | undefined {
  const hostEnv =
    choice.provider !== undefined ? claudeCliKeyEnv(choice.provider, choice.customProviders) : undefined;
  if (hostEnv?.length === 0) return { mode: 'api', apiKey: KEYLESS_PLACEHOLDER_TOKEN }; // keyless custom
  if (hostEnv !== undefined) {
    const key = hostEnv.map((k) => env[k]).find((v) => v !== undefined && v !== '');
    if (key === undefined) {
      throw new CliUsageError(`Set ${hostEnv.join(' or ')} before running with --provider ${choice.provider}.`);
    }
    return { mode: 'api', apiKey: key };
  }
  if (!needsAnthropicAuth(choice)) return undefined; // no used provider consumes an Anthropic credential (codex/cursor alone, or + zai review)
  const auth = authFromEnv(env);
  if (auth === undefined) {
    throw new CliUsageError(`Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running with ${anthropicConsumer(choice)}.`);
  }
  return auth;
}

/** The first used provider with no key wiring of its own (the one asking for the Anthropic credential), with its flag. */
function anthropicConsumer(choice: ProviderChoice): string {
  const primary: [string, string | undefined] = ['--provider', choice.provider ?? 'claude'];
  const roles: [string, string | undefined][] = [
    primary,
    ['--review-provider', choice.reviewProvider],
    ...fallbackProviderNames(choice.fallbackProvider).map((n): [string, string] => ['--fallback-provider', n]),
  ];
  const [flag, name] = roles.find(([, n]) => n !== undefined && !requiresApiKey(n, choice.customProviders)) ?? primary;
  return `${flag} ${name}`;
}

/**
 * run/watch/spec/revise-pr always start the primary sidecar under --llm-proxy; skipping it for a choice
 * that needs none (Codex-only) is wired through the review commands only so far. Refuse that combination
 * up front with an accurate message instead of the generic "no sidecar fronts it" one.
 */
export function refuseLlmProxyWithoutPrimarySidecar(
  llmProxy: boolean | undefined,
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (llmProxy !== true || !llmProxyNeedsNoPrimarySidecar(choice, env)) return;
  throw new CliUsageError(`--llm-proxy with --provider ${choice.provider ?? 'claude'} is supported on review commands only for now`);
}
