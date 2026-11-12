/**
 * Marker and reset-time parsing for a run that ended on a provider rate or session limit. The marker
 * is the only durable record of when a stage may safely retry: `taskcell resume-rate-limited` reads
 * it back up to hours later, long after the run's own process and logs are gone.
 */

import { AgentError, isRateLimitError, rateLimitResetDelayMs } from './errors.js';
import { UsageCapError, usageCapMessage } from './usage-cap.js';

const RESET_RELATIVE_RE = /try again in\s+(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/i;

const RELATIVE_UNIT_MS: Record<string, number> = {
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
};

/** Fallback reset delay when the provider message names no reset we can trust. */
const FALLBACK_RESET_MS = 60 * 60 * 1000;
/** Ceiling on any parsed delay: a garbled number must not park work for weeks or yield an Invalid Date. */
const MAX_RESET_MS = 24 * 60 * 60 * 1000;

/**
 * When a parked stage may retry. The wall-clock and epoch forms go through rateLimitResetDelayMs
 * (refusal line only, UTC only, impossible clocks rejected); otherwise a relative "try again in 2h" on
 * a line that is a recognised refusal; otherwise `now + 1h`. Always a valid Date, at most 24h out.
 */
export function parseProviderRateLimitReset(message: string, now: Date = new Date()): Date {
  const clamp = (ms: number): Date => new Date(now.getTime() + Math.min(Math.max(0, ms), MAX_RESET_MS));
  const error = new Error(message);
  const named = rateLimitResetDelayMs(error, now.getTime());
  if (named !== undefined) return clamp(named);
  const refusal = message.split(/\r?\n/).find((line) => isRateLimitError(new Error(line)));
  const relative = refusal !== undefined ? RESET_RELATIVE_RE.exec(refusal) : null;
  if (relative !== null) return clamp(Number(relative[1]) * (RELATIVE_UNIT_MS[relative[2]!.toLowerCase()] ?? 0));
  return clamp(FALLBACK_RESET_MS);
}

export interface RateLimitedMarker {
  until: Date;
  trigger: string;
}

/** Hidden marker recording when a stage may retry and which label starts it again. */
export function rateLimitedMarker(until: Date, trigger: string): string {
  return `<!-- vanguard-rate-limited until=${until.toISOString()} trigger="${trigger}" -->`;
}

const RATE_LIMITED_MARKER_RE = /<!--\s*vanguard-rate-limited\s+until=(\S+)\s+trigger="([^"]*)"\s*-->/;

/** Parse a single rate-limited marker out of a comment body, or undefined when absent or malformed. */
export function parseRateLimitedMarker(body: string): RateLimitedMarker | undefined {
  const match = RATE_LIMITED_MARKER_RE.exec(body);
  if (match === null) return undefined;
  const until = new Date(match[1]!);
  if (Number.isNaN(until.getTime())) return undefined;
  return { until, trigger: match[2]! };
}

/** The newest marker among comment bodies in chronological (oldest-first) order, as `gh` lists them. */
export function latestRateLimitedMarker(bodies: readonly string[]): RateLimitedMarker | undefined {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const marker = parseRateLimitedMarker(bodies[i]!);
    if (marker !== undefined) return marker;
  }
  return undefined;
}

/** Comment posted when a stage is marked rate-limited: a human-readable notice plus the hidden marker. */
export function rateLimitedComment(until: Date, trigger: string): string {
  return [
    "This run ended because the AI provider hit a rate limit or session limit — a temporary condition, not a problem with this change.",
    `Vanguard will not retry automatically until ${until.toISOString()}. Once that time has passed, \`taskcell resume-rate-limited\` (scheduled every 30 minutes) removes \`vanguard:rate-limited\` and re-applies \`${trigger}\` to retry.`,
    `To retry sooner, remove \`vanguard:rate-limited\` and re-apply \`${trigger}\` yourself.`,
    '',
    rateLimitedMarker(until, trigger),
  ].join('\n\n');
}

/** True for a failure that parks the task for `resume-rate-limited`: a provider 429 or our own usage cap. */
export function isRateLimitHold(error: unknown): error is AgentError {
  return error instanceof AgentError && (error instanceof UsageCapError || isRateLimitError(error));
}

/** Comment posted when a stage was not started because its provider is at the user's usage cap. */
export function usageCapComment(error: UsageCapError, trigger: string): string {
  return [
    `Vanguard ${usageCapMessage(error.pct, error.cap, error.until)} (\`VANGUARD_USAGE_CAP_PCT\`). This is the configured reserve, not a provider rate limit and not a problem with this change; no running stage was interrupted.`,
    `\`taskcell resume-rate-limited\` removes \`vanguard:rate-limited\` and re-applies \`${trigger}\` once ${error.until.toISOString()} has passed.`,
    '',
    rateLimitedMarker(error.until, trigger),
  ].join('\n\n');
}

/** Reset time and comment for a rate-limit hold: usage-cap wording for the cap, the generic 429 notice otherwise. */
export function rateLimitHold(error: Error, trigger: string): { until: Date; comment: string } {
  if (error instanceof UsageCapError) return { until: error.until, comment: usageCapComment(error, trigger) };
  const until = parseProviderRateLimitReset(error.message);
  return { until, comment: rateLimitedComment(until, trigger) };
}
