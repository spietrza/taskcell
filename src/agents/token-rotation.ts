import type { AgentAuth } from './auth.js';

/**
 * Per-run rotation across several CLAUDE_CODE_OAUTH_TOKEN subscription tokens when no LLM proxy holds them
 * (the proxy rotates by itself). In memory only: on CI nothing outlives the run. Names carry the 1-based
 * index, never a token.
 */
export interface TokenRotation {
  readonly provider: 'claude';
  /** The auth the next attempt runs with. */
  auth(): AgentAuth;
  /** Run-record name of the token in use: its index, and why the run switched to it. */
  name(): string;
  /** Another token that has not hit a limit in this run exists. */
  hasNext(): boolean;
  /** The current token hit a limit until `until`: move to the next. False when every token is out. */
  limited(until: Date): boolean;
  /** The current token is out but a stage fallback rescued the stage (nothing to switch to). */
  cool(until: Date): void;
}

/** A rotation for an auth holding several subscription tokens; undefined for anything else (single token, API key). */
export function tokenRotationFor(auth: AgentAuth | undefined): TokenRotation | undefined {
  if (auth?.mode !== 'subscription' || auth.tokens === undefined || auth.tokens.length < 2) return undefined;
  const tokens = auth.tokens;
  const out = new Map<number, Date>();
  let current = 0;
  let switched: string | undefined;
  const nextFree = (): number | undefined => {
    const i = tokens.findIndex((_, n) => n !== current && !out.has(n));
    return i >= 0 ? i : undefined;
  };
  return {
    provider: 'claude',
    auth: () => ({ mode: 'subscription', token: tokens[current] as string, tokens }),
    name: () => `token ${current + 1} of ${tokens.length}${switched !== undefined ? ` (${switched})` : ''}`,
    hasNext: () => nextFree() !== undefined,
    limited(until) {
      out.set(current, until);
      const next = nextFree();
      if (next === undefined) return false;
      switched = `token ${current + 1} hit a plan limit until ${until.toISOString()}`;
      current = next;
      return true;
    },
    cool: (until) => void out.set(current, until),
  };
}
