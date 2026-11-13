import { describe, it, expect } from 'vitest';
import { isRateLimitError, rateLimitResetDelayMs, failureReason, formatFailureComment, visibleError, TaskcellError, AgentError, FallbackFailedError } from './errors.js';

describe('failureReason', () => {
  it('masks credentials and collapses the message to one line, since it lands in a public CI log', () => {
    const key = `sk-${'A1b2'.repeat(12)}`;
    const reason = failureReason(new Error(`codex exec failed\n\n  OPENAI_API_KEY=${key} rejected\n  Authorization: Bearer ${'x'.repeat(40)}`));
    expect(reason).toBe('codex exec failed OPENAI_API_KEY=[REDACTED-KEY] rejected Authorization: Bearer [REDACTED]');
    expect(reason).not.toContain(key);
  });

  it('strips credentials from a git remote URL, the shape a failed push or fetch prints', () => {
    const reason = failureReason(new Error(`fatal: unable to access 'https://oauth2:glpat-${'Ab1'.repeat(8)}@gitlab.com/g/p.git/'`));
    expect(reason).toBe("fatal: unable to access 'https://[REDACTED]@gitlab.com/g/p.git/'");
  });

  it('caps a multi-kilobyte provider dump to a short excerpt', () => {
    const reason = failureReason('x'.repeat(2000));
    expect(reason.length).toBeLessThanOrEqual(201);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('handles a non-Error throw', () => {
    expect(failureReason('plain string')).toBe('plain string');
  });
});

describe('formatFailureComment', () => {
  it('carries the throwing site, so a bare TypeError is diagnosable from the comment alone', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'split')");

    const comment = formatFailureComment('Vanguard run failed', error);

    expect(comment).toContain("Vanguard run failed: TypeError: Cannot read properties of undefined (reading 'split')");
    expect(comment).toContain('<details><summary>stack</summary>');
    expect(comment).toContain('errors.test.ts');
  });

  it('trims the stack to 25 lines so a deep async trace cannot flood the comment', () => {
    const error = new Error('boom');
    error.stack = ['Error: boom', ...Array.from({ length: 200 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`)].join(
      '\n',
    );

    const fenced = formatFailureComment('Vanguard run failed', error).split('```')[1] ?? '';

    expect(fenced.trim().split('\n')).toHaveLength(25);
    expect(fenced).toContain('at frame23');
    expect(fenced).not.toContain('at frame24');
  });

  it('falls back to the one-line shape for a non-Error throw', () => {
    expect(formatFailureComment('Vanguard spec failed', 'plain string')).toBe('Vanguard spec failed: plain string');
  });

  it('falls back to the one-line shape when an Error carries no stack', () => {
    const error = new Error('no stack here');
    error.stack = '';

    expect(formatFailureComment('Vanguard run failed', error)).toBe('Vanguard run failed: Error: no stack here');
  });
});

describe('visibleError', () => {
  it('passes a TaskcellError through untouched', () => {
    const error = new TaskcellError('already visible');

    expect(visibleError(error)).toBe(error);
  });

  it('wraps a foreign error with the first non-empty message line', () => {
    expect(visibleError(new Error('\n\ngh: not found\nusage: gh issue view')).message).toBe('gh: not found');
  });
});

describe('isRateLimitError', () => {
  it.each(['Fable', 'Opus', 'Sonnet'])('treats the per-model limit for %s as a rate limit', (model) => {
    expect(isRateLimitError(new AgentError(`You've reached your ${model} limit. Switch to another model to continue.`))).toBe(true);
  });

  it.each([
    'HTTP 429',
    'status code 429',
    'API Error: 429',
    '{"code":429}',
    '429 Too Many Requests',
    'rate_limit_error',
    'rate_limit_exceeded',
    'Rate limit reached for gpt-5',
    'Claude usage limit reached. Your limit will reset at 9pm (UTC).',
    "You've hit your session limit · resets 9pm (UTC)",
    'API Error: overloaded',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  ])('recognizes %s', (message) => {
    expect(isRateLimitError(new AgentError(message))).toBe(true);
  });
  it.each(['API rate limit exceeded for user alice', 'gh failed: API rate limit exceeded', 'line 429', 'implement rate limiting', 'invalid API key', 'the usage limit reached in this benchmark is documented below'])('rejects %s', (message) => {
    expect(isRateLimitError(new Error(message))).toBe(false);
  });
});

describe('rateLimitResetDelayMs', () => {
  const at = (h: number, m = 0): number => Date.UTC(2026, 10, 8, h, m);
  const session = "You've hit your session limit · resets 9pm (UTC)";

  it('reads the reset named on the refusal line', () => {
    expect(rateLimitResetDelayMs(new AgentError(session), at(20, 58))).toBe(2 * 60_000);
    expect(rateLimitResetDelayMs(new AgentError('Claude usage limit reached. Your limit will reset at 10:30pm (UTC).'), at(22))).toBe(30 * 60_000);
  });

  it('reads the epoch reset of the plan-cap wording', () => {
    const resetAt = at(21) / 1000;
    expect(rateLimitResetDelayMs(new AgentError(`Claude AI usage limit reached|${resetAt}`), at(20, 58))).toBe(2 * 60_000);
  });

  it('reads a reset that has just passed as "retry now"', () => {
    expect(rateLimitResetDelayMs(new AgentError(session), at(21, 4))).toBe(0);
  });

  it('rolls a reset long past to the next day', () => {
    expect(rateLimitResetDelayMs(new AgentError("You've hit your session limit · resets 9am (UTC)"), at(20))).toBe(13 * 60 * 60_000);
  });

  it('ignores a reset clause outside the refusal line', () => {
    expect(rateLimitResetDelayMs(new AgentError(`the cache resets 3am (UTC)\n${"You've hit your session limit"}`), at(20))).toBeUndefined();
  });

  it('rejects zones other than UTC and impossible clock times', () => {
    expect(rateLimitResetDelayMs(new AgentError("You've hit your session limit · resets 9pm (PST)"), at(20))).toBeUndefined();
    expect(rateLimitResetDelayMs(new AgentError("You've hit your session limit · resets 0pm (UTC)"), at(20))).toBeUndefined();
    expect(rateLimitResetDelayMs(new AgentError("You've hit your session limit · resets 13pm (UTC)"), at(20))).toBeUndefined();
    expect(rateLimitResetDelayMs(new AgentError("You've hit your session limit · resets 9:75pm (UTC)"), at(20))).toBeUndefined();
  });

  it('ignores a reset time with no zone marker', () => {
    expect(rateLimitResetDelayMs(new AgentError("You've hit your session limit · resets 9pm"), at(20))).toBeUndefined();
  });

  it('does not treat prose that names the error tokens as a refusal', () => {
    expect(isRateLimitError(new AgentError('handle the overloaded_error envelope in errors.ts'))).toBe(false);
    expect(isRateLimitError(new AgentError('match "Claude usage limit reached" in the CLI output'))).toBe(false);
    expect(isRateLimitError(new AgentError('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'))).toBe(true);
    expect(isRateLimitError(new AgentError('Claude usage limit reached. Your limit will reset at 9pm (UTC).'))).toBe(true);
  });

  it('only counts the documented limit kinds as transient', () => {
    expect(isRateLimitError(new AgentError("You've hit your session limit"))).toBe(true);
    expect(isRateLimitError(new AgentError("You've hit your context limit"))).toBe(false);
    expect(isRateLimitError(new AgentError("You've hit your turn limit"))).toBe(false);
  });
});

describe('formatFailureComment for a failed fallback', () => {
  it('says the fallback failed and why, not only the primary rate limit', () => {
    const error = new FallbackFailedError('claude', 'codex', "You've hit your session limit", 'failed to spawn code-mode host: Resource temporarily unavailable (os error 11)');

    const comment = formatFailureComment('Vanguard run failed', error);

    expect(comment).toContain('fallback provider codex failed (not a rate limit)');
    expect(comment).toContain('Resource temporarily unavailable (os error 11)');
    expect(comment).not.toContain('the AI provider hit a usage/rate limit');
    expect(isRateLimitError(error)).toBe(true);
  });
});
