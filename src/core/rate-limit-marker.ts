/**
 * Marker and reset-time parsing for a run that ended on a provider rate or session limit. The marker
 * is the only durable record of when a stage may safely retry: `vanguard resume-rate-limited` reads
 * it back up to hours later, long after the run's own process and logs are gone.
 */

const RESET_CLOCK_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(UTC\)/i;
const RESET_RELATIVE_RE = /try again in\s+(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/i;

const RELATIVE_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
};

/** Fallback reset delay when the provider message names neither a clock time nor a relative duration. */
const FALLBACK_RESET_MS = 60 * 60 * 1000;

/**
 * Parse the reset time out of a provider rate/session-limit message: a wall-clock reset
 * ("resets 9pm (UTC)") or a relative duration ("try again in 2h"). Falls back to `now + 1h` when
 * neither form is present, so a run always leaves a concrete `until` even on an unfamiliar wording.
 */
export function parseProviderRateLimitReset(message: string, now: Date = new Date()): Date {
  const relative = RESET_RELATIVE_RE.exec(message);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unitMs = RELATIVE_UNIT_MS[relative[2]!.toLowerCase()] ?? 0;
    return new Date(now.getTime() + amount * unitMs);
  }
  const clock = RESET_CLOCK_RE.exec(message);
  if (clock !== null) {
    let hour = Number(clock[1]);
    const minute = clock[2] !== undefined ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
    // A reset clock time not already in the future (the message named today's reset, now past) means tomorrow's.
    if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
    return reset;
  }
  return new Date(now.getTime() + FALLBACK_RESET_MS);
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
    `Vanguard will not retry automatically until ${until.toISOString()}. Once that time has passed, \`vanguard resume-rate-limited\` (scheduled every 30 minutes) removes \`vanguard:rate-limited\` and re-applies \`${trigger}\` to retry.`,
    `To retry sooner, remove \`vanguard:rate-limited\` and re-apply \`${trigger}\` yourself.`,
    '',
    rateLimitedMarker(until, trigger),
  ].join('\n\n');
}
