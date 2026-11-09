import { describe, it, expect } from 'vitest';
import { parseProviderRateLimitReset, rateLimitedMarker, parseRateLimitedMarker, latestRateLimitedMarker, rateLimitedComment } from './rate-limit-marker.js';

describe('parseProviderRateLimitReset', () => {
  const now = new Date('2026-11-08T18:00:00.000Z');

  it('reads the session-limit wall-clock reset', () => {
    expect(parseProviderRateLimitReset("You've hit your session limit · resets 9pm (UTC)", now).toISOString()).toBe('2026-11-08T21:00:00.000Z');
  });

  it('reads the plan-cap wording and its epoch form', () => {
    expect(parseProviderRateLimitReset('Claude usage limit reached. Your limit will reset at 9pm (UTC).', now).toISOString()).toBe('2026-11-08T21:00:00.000Z');
    const epoch = Date.UTC(2026, 10, 8, 20) / 1000;
    expect(parseProviderRateLimitReset(`Claude AI usage limit reached|${epoch}`, now).toISOString()).toBe('2026-11-08T20:00:00.000Z');
  });

  it('parses a relative "try again in 2h" on a refusal line', () => {
    expect(parseProviderRateLimitReset('Rate limit reached for gpt-5, try again in 2h', now).toISOString()).toBe('2026-11-08T20:00:00.000Z');
  });

  it('ignores a reset in agent prose and falls back to now + 1h', () => {
    expect(parseProviderRateLimitReset('rate_limit_error\nthe cache resets 3am (UTC), try again in 9h', now).toISOString()).toBe('2026-11-08T19:00:00.000Z');
  });

  it('clamps a garbled relative duration to 24h instead of an Invalid Date', () => {
    expect(parseProviderRateLimitReset('Rate limit reached for x, try again in 99999999999999h', now).toISOString()).toBe('2026-11-09T18:00:00.000Z');
  });
});

describe('rateLimitedMarker / parseRateLimitedMarker', () => {
  it('round-trips the until timestamp and trigger label', () => {
    const until = new Date('2026-11-08T21:00:00.000Z');
    const marker = rateLimitedMarker(until, 'ready for agent');
    expect(marker).toBe('<!-- vanguard-rate-limited until=2026-11-08T21:00:00.000Z trigger="ready for agent" -->');
    expect(parseRateLimitedMarker(marker)).toEqual({ until, trigger: 'ready for agent' });
  });

  it('finds the marker embedded in a longer comment body', () => {
    const until = new Date('2026-11-08T21:00:00.000Z');
    const body = rateLimitedComment(until, 'needs revision');
    expect(parseRateLimitedMarker(body)).toEqual({ until, trigger: 'needs revision' });
    expect(body).toContain('needs revision');
  });

  it('returns undefined for a body with no marker', () => {
    expect(parseRateLimitedMarker('just a normal comment')).toBeUndefined();
  });
});

describe('latestRateLimitedMarker', () => {
  it('picks the newest marker among several comment bodies in chronological order', () => {
    const older = rateLimitedMarker(new Date('2026-11-08T21:00:00.000Z'), 'ready for agent');
    const newer = rateLimitedMarker(new Date('2026-11-09T09:00:00.000Z'), 'ready for agent');
    expect(latestRateLimitedMarker([older, 'unrelated comment', newer])).toEqual({
      until: new Date('2026-11-09T09:00:00.000Z'),
      trigger: 'ready for agent',
    });
  });

  it('returns undefined when no body carries a marker', () => {
    expect(latestRateLimitedMarker(['hi', 'no marker here'])).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(latestRateLimitedMarker([])).toBeUndefined();
  });
});
