/**
 * User-set usage cap: stop starting work once a provider's own plan window (e.g. Claude's 5-hour
 * window) is at or above `VANGUARD_USAGE_CAP_PCT`, leaving the rest as the user's reserve. Utilization
 * is only what the provider CLI already reports during a run — no extra API calls. A stage in flight
 * always finishes; the cap is checked before a stage starts.
 */

import { AgentError } from './errors.js';

/** What the last run of a provider reported about its plan window. */
export interface Utilization {
  /** Percent of the window used, 0..100. */
  pct: number;
  /** When the window resets, when the CLI said. */
  resetsAt?: Date;
}

interface Observation extends Utilization {
  observedAt: Date;
}

/** Longest window a provider reports on (Codex's weekly one) plus slack: a later reset is clamped to it. */
const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
/** An observation that named no reset expires after this long, so a capped provider cannot stay capped forever. */
const OBSERVATION_TTL_MS = 60 * 60 * 1000;
/** How deep parseCodexUtilization looks for `rate_limits` under `msg`/`payload`. */
const MAX_CODEX_NESTING = 3;

const observed = new Map<string, Observation>();

const clampPct = (pct: number): number => Math.min(100, Math.max(0, pct));

/**
 * Remember the latest utilization a provider reported. The stream is agent-controlled (a sandboxed tool
 * can write to it), so the value is bounded here: pct to 0..100, a reset to (now, now + 8 days]; a
 * non-finite pct is dropped and a past or invalid reset is treated as none.
 */
export function recordUtilization(provider: string, utilization: Utilization, now: Date = new Date()): void {
  if (!Number.isFinite(utilization.pct)) return;
  const reset = utilization.resetsAt?.getTime();
  const resetsAt =
    reset === undefined || !Number.isFinite(reset) || reset <= now.getTime()
      ? undefined
      : new Date(Math.min(reset, now.getTime() + MAX_RESET_HORIZON_MS));
  observed.set(provider, { pct: clampPct(utilization.pct), ...(resetsAt !== undefined ? { resetsAt } : {}), observedAt: now });
}

/** Forget every observation (tests). */
export function resetUtilization(): void {
  observed.clear();
}

function withReset(pct: number, resetsAtEpochSec: unknown): Utilization {
  // A non-finite or out-of-range epoch yields an Invalid Date: dropped as no reset.
  const resetsAt = typeof resetsAtEpochSec === 'number' ? new Date(resetsAtEpochSec * 1000) : undefined;
  return resetsAt === undefined || Number.isNaN(resetsAt.getTime()) ? { pct: clampPct(pct) } : { pct: clampPct(pct), resetsAt };
}

/**
 * Claude Code (verified against 2.1.322): stream-json carries
 * `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":<epoch s>,
 * "rateLimitType":"five_hour","utilization":0.82}}`. `utilization` is a 0..1 fraction (above 1 in
 * overage, read as 100%) and is absent until the plan is near a threshold, so it can be missing.
 */
export function parseClaudeUtilization(event: unknown): Utilization | undefined {
  const e = event as { type?: unknown; rate_limit_info?: { utilization?: unknown; resetsAt?: unknown } } | null;
  if (e?.type !== 'rate_limit_event') return undefined;
  const info = e.rate_limit_info;
  if (typeof info?.utilization !== 'number' || !Number.isFinite(info.utilization) || info.utilization < 0) return undefined;
  return withReset(info.utilization * 100, info.resetsAt);
}

/**
 * Codex (verified against codex-cli 0.167.0): the `token_count` event carries
 * `rate_limits: {primary: {used_percent, window_minutes, resets_at}, secondary: {...}}`, `used_percent`
 * 0..100 and `resets_at` epoch seconds (older builds: `resets_in_seconds`). The event may sit at the top
 * level of the `--json` stream or nested under `msg`/`payload` (searched MAX_CODEX_NESTING levels deep).
 * The primary window is the short (5h) one; the most-used of primary/secondary wins so a nearly spent
 * weekly window also trips the cap.
 */
export function parseCodexUtilization(event: unknown, now: Date = new Date(), depth = 0): Utilization | undefined {
  type Window = { used_percent?: unknown; resets_at?: unknown; resets_in_seconds?: unknown };
  const e = event as { rate_limits?: Record<string, Window | null>; msg?: unknown; payload?: unknown } | null;
  if (e === null || typeof e !== 'object') return undefined;
  const limits = e.rate_limits;
  if (limits === undefined || limits === null || typeof limits !== 'object') {
    if (depth >= MAX_CODEX_NESTING) return undefined;
    return parseCodexUtilization(e.msg, now, depth + 1) ?? parseCodexUtilization(e.payload, now, depth + 1);
  }
  let best: Utilization | undefined;
  for (const w of [limits['primary'], limits['secondary']]) {
    if (typeof w?.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
    const resets =
      typeof w.resets_at === 'number'
        ? w.resets_at
        : typeof w.resets_in_seconds === 'number'
          ? now.getTime() / 1000 + w.resets_in_seconds
          : undefined;
    const u = withReset(w.used_percent, resets);
    if (best === undefined || u.pct > best.pct) best = u;
  }
  return best;
}

/** The configured cap (1–100) from `VANGUARD_USAGE_CAP_PCT`, or undefined when unset/invalid. */
export function usageCapPct(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['VANGUARD_USAGE_CAP_PCT']?.trim();
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : undefined;
}

/** Parse a `--usage-cap` value: a number 1–100, else undefined. */
export function parseUsageCap(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : usageCapPct({ VANGUARD_USAGE_CAP_PCT: raw });
}

export type UsageCapStatus =
  | { state: 'uncapped' }
  | { state: 'unknown' }
  | { state: 'under'; pct: number; cap: number }
  | { state: 'capped'; pct: number; cap: number; until: Date };

/**
 * Where a provider stands against the cap. An observation whose window already reset, or that named no
 * reset and is older than OBSERVATION_TTL_MS, is stale → unknown (the next run reports afresh).
 */
export function usageCapStatus(provider: string, now: Date = new Date(), cap: number | undefined = usageCapPct()): UsageCapStatus {
  if (cap === undefined) return { state: 'uncapped' };
  const u = observed.get(provider);
  if (u === undefined) return { state: 'unknown' };
  const until = u.resetsAt ?? new Date(u.observedAt.getTime() + OBSERVATION_TTL_MS);
  if (until.getTime() <= now.getTime()) return { state: 'unknown' };
  if (u.pct < cap) return { state: 'under', pct: u.pct, cap };
  return { state: 'capped', pct: u.pct, cap, until };
}

/** Human text for a pause at the cap, distinct from a hard provider 429. */
export function usageCapMessage(pct: number, cap: number, until: Date): string {
  return `paused at the usage cap (${Math.round(pct)}% of ${cap}%), resumes after ${until.toISOString()}`;
}

/** A stage was not started because its provider is at the user's usage cap. Never a provider 429. */
export class UsageCapError extends AgentError {
  constructor(
    readonly provider: string,
    readonly pct: number,
    readonly cap: number,
    readonly until: Date,
  ) {
    super(`${provider} ${usageCapMessage(pct, cap, until)}`);
  }
}

const loggedUnknown = new Set<string>();

/**
 * Gate before a stage starts on `provider`. Throws UsageCapError when at/over the cap; logs one line
 * per provider when utilization is unknown (the cap does not block then). Returns the status.
 */
export function enforceUsageCap(provider: string, log?: { info: (o: object, m: string) => void }): UsageCapStatus {
  const status = usageCapStatus(provider);
  if (status.state === 'capped') throw new UsageCapError(provider, status.pct, status.cap, status.until);
  if (status.state === 'unknown' && !loggedUnknown.has(provider)) {
    loggedUnknown.add(provider);
    log?.info({ provider }, `usage cap set but ${provider} utilization is not known yet — not blocking`);
  }
  return status;
}

/** Forget which providers had their unknown-utilization line logged (tests). */
export function resetUsageCapLog(): void {
  loggedUnknown.clear();
}
