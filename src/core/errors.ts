import { redactForPublish } from './secret-scan.js';

export class VanguardError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class SandboxError extends VanguardError {}
export class WorktreeError extends VanguardError {}
export class AgentError extends VanguardError {}
export class NotImplementedError extends VanguardError {}
export class StructuredOutputError extends VanguardError {}
export class WorkflowGuardError extends VanguardError {}
/** A host write/delete under `.vanguard` refused because a path component is a symlink (or not a directory). */
export class StatePathError extends VanguardError {}

/** Cap on stack lines carried into an issue comment: enough to name the failing site, short enough to skim. */
const FAILURE_STACK_LINES = 25;

/**
 * Failure text for an issue comment. `String(error)` alone drops the stack, so a bare
 * `TypeError: Cannot read properties of undefined` reaches the reader with no throwing site — the
 * diagnosis then costs a manual hunt through the engine. Carry a trimmed stack in a collapsed
 * block instead. Non-Error throws (strings, rejected non-errors) keep the old one-line shape.
 * Both parts are masked: agent errors embed raw provider stdout/stderr, where a credential can ride along.
 */
export function formatFailureComment(prefix: string, error: unknown): string {
  const headline = redactForPublish(`${prefix}: ${String(error)}`);
  const stack = error instanceof Error ? error.stack : undefined;
  if (stack === undefined || stack.trim() === '') return headline;
  const trimmed = redactForPublish(stack.split('\n').slice(0, FAILURE_STACK_LINES).join('\n'));
  return `${headline}\n\n<details><summary>stack</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n</details>`;
}

/** Cap on the error excerpt carried in a one-line operator log entry. */
const FAILURE_REASON_MAX_CHARS = 200;

/**
 * One-line, redacted excerpt of an error for operator logs — those land in CI job output, which is
 * world-readable on a public repo, and agent errors embed raw provider stdout/stderr (codex, cursor)
 * where a key could ride along. Injected credentials and token shapes masked, then whitespace collapsed and capped.
 */
export function failureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = redactForPublish(raw).replace(/\s+/g, ' ').trim();
  return line.length > FAILURE_REASON_MAX_CHARS ? `${line.slice(0, FAILURE_REASON_MAX_CHARS)}…` : line;
}

/**
 * Normalise a raw thrown value into a user-visible VanguardError: an existing VanguardError passes
 * through untouched; anything else is wrapped with the first non-empty line of its message — where
 * CLIs like gh/glab/git put the actionable text. Shared by the board and repo-file read paths.
 */
export function visibleError(error: unknown): VanguardError {
  if (error instanceof VanguardError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new VanguardError(message.split('\n').find((l) => l.trim() !== '') ?? message);
}

/**
 * Provider rate-limit refusals as the providers themselves word them. Deliberately NOT a bare `429`
 * or a bare "rate limit": an AgentError's message embeds the provider CLI's raw stderr, the tail of
 * its stdout transcript, or its final assistant text (see claude-stream.ts / cursor.ts), so
 * agent-authored prose — a diff that discusses rate limiting, a stack frame holding the number 429 —
 * would otherwise classify a hard failure (crash, bad auth, malformed output) as transient.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  // HTTP 429 in a status/error position: `HTTP 429`, `status code 429`, `API Error: 429`, `"code":429`.
  /\b(?:http|status(?:[ _-]?code)?|code|error)\b["'\s:=,]{0,4}429\b/i,
  // The status line with no label in front of it: `429 Too Many Requests`.
  /\b429\b[\s:-]{0,3}too many requests/i,
  // The vendors' own refusal strings: Anthropic's `rate_limit_error`, OpenAI's `rate_limit_exceeded`
  // and "Rate limit reached for <model>".
  /\b(?:rate_limit_(?:error|exceeded)|rate limit reached for)\b/i,
  // Claude subscription stalls (the case #615 was about), both wordings the CLI prints: `Claude usage
  // limit reached. Your limit will reset at 9pm (UTC).` for a plan cap and `You've hit your session
  // limit · resets 9pm (UTC)` for a session cap. Both keep the vendor's framing — a bare "usage limit
  // reached" is prose an agent can write about its own work, and would classify a hard failure as transient.
  /\bclaude(?: ai)? usage limit reached(?:\|\d+|\.?\s+your limit will reset)/i,
  /\byou(?:'ve|’ve| have) hit your (?:session|usage|weekly|5-hour) limit\b/i,
  // Anthropic's overload refusal: the CLI's short form (`API Error: overloaded`) and the raw envelope
  // it relays, `API Error: 529 {"type":"error","error":{"type":"overloaded_error",...}}`.
  /\bapi error:\s*(?:overloaded\b|529\b[^\n]*"type"\s*:\s*"overloaded_error")/i,
];

/** The text the rate-limit matchers read: an Error's message, or a non-Error throw rendered as one. */
const rawMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** True when `error` is a provider rate-limit refusal, not some other agent failure. */
export function isRateLimitError(error: unknown): boolean {
  const message = rawMessage(error);
  return RATE_LIMIT_PATTERNS.some((re) => re.test(message));
}

/**
 * The reset clause the subscription wordings carry after the refusal itself: `· resets 9pm (UTC)`,
 * `Your limit will reset at 10:30pm (UTC)`, `resets 21:00`. The zone marker is optional and only
 * `UTC` is honoured (see rateLimitResetDelayMs).
 */
const RATE_LIMIT_RESET_CLAUSE = /\breset(?:s)?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]{1,12})\))?/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseconds from `now` until the reset instant a provider rate-limit refusal names, or undefined
 * when it names none, the clause is unparseable, or it carries no explicit UTC marker — guessing the
 * zone would mean waiting for the wrong hour, which is worse than not waiting at all. A time already
 * past rolls to the next day, the way the provider's own window does.
 */
export function rateLimitResetDelayMs(error: unknown, now: number = Date.now()): number | undefined {
  // Only the line that carries the refusal itself: agent-authored text elsewhere in the message
  // ("the cache resets at 3am") must not set how long the run waits.
  const refusal = rawMessage(error).split(/\r?\n/).find((line) => RATE_LIMIT_PATTERNS.some((re) => re.test(line)));
  if (refusal === undefined) return undefined;
  const match = RATE_LIMIT_RESET_CLAUSE.exec(refusal);
  if (match === null) return undefined;
  const [, rawHour, rawMinute, rawMeridiem, zone] = match;
  // Only an explicit UTC: the CLI prints inside the sandbox, whose zone need not be the host's, so a
  // zone-less time could be off by hours.
  if (zone === undefined || zone.trim().toLowerCase() !== 'utc') return undefined;
  const meridiem = rawMeridiem?.toLowerCase();
  const clockHour = Number(rawHour);
  const minute = rawMinute !== undefined ? Number(rawMinute) : 0;
  if (minute > 59 || clockHour > (meridiem !== undefined ? 12 : 23) || (meridiem !== undefined && clockHour < 1)) return undefined;
  const hour = meridiem === undefined ? clockHour : (clockHour % 12) + (meridiem === 'pm' ? 12 : 0);
  const base = new Date(now);
  const target = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute);
  return (target > now ? target : target + DAY_MS) - now;
}

/**
 * PR notice posted when a run ends on a provider rate limit with no fallback to rescue it: nothing
 * retries automatically, so re-labeling is the only way to pick the work back up. Unbranded — a
 * white-label run shows it too, same as any other hand-back notice.
 */
export function rateLimitRetryNotice(label: string): string {
  return `This run ended because the AI provider hit a rate limit or was overloaded — a temporary condition, not a problem with this change. Remove and re-apply the \`${label}\` label to retry once the limit clears.`;
}
