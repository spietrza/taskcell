import { describe, it, expect } from 'vitest';
import { parseProviderRateLimitReset, rateLimitedMarker, parseRateLimitedMarker, latestRateLimitedMarker, rateLimitedComment } from './rate-limit-marker.js';

describe('parseProviderRateLimitReset', () => {
  it('parses a "resets 9pm (UTC)" wall-clock reset later the same day', () => {
    const now = new Date('2026-11-08T18:00:00.000Z');
    const until = parseProviderRateLimitReset("You've hit your session limit · resets 9pm (UTC)", now);
    expect(until.toISOString()).toBe('2026-11-08T21:00:00.000Z');
  });

  it('rolls over to tomorrow when the named clock time has already passed today', () => {
    const now = new Date('2026-11-08T22:00:00.000Z');
    const until = parseProviderRateLimitReset('resets 9pm (UTC)', now);
    expect(until.toISOString()).toBe('2026-11-09T21:00:00.000Z');
  });

  it('parses a 12-hour clock with minutes and am/pm', () => {
    const now = new Date('2026-11-08T00:00:00.000Z');
    const until = parseProviderRateLimitReset('resets 9:30am (UTC)', now);
    expect(until.toISOString()).toBe('2026-11-08T09:30:00.000Z');
  });

  it('parses a relative "try again in 2h" duration', () => {
    const now = new Date('2026-11-08T18:00:00.000Z');
    const until = parseProviderRateLimitReset('Rate limit reached for gpt-5, try again in 2h', now);
    expect(until.toISOString()).toBe('2026-11-08T20:00:00.000Z');
  });

  it('parses a relative duration in minutes', () => {
    const now = new Date('2026-11-08T18:00:00.000Z');
    const until = parseProviderRateLimitReset('try again in 45m', now);
    expect(until.toISOString()).toBe('2026-11-08T18:45:00.000Z');
  });

  it('falls back to now + 1h when the message names no reset time', () => {
    const now = new Date('2026-11-08T18:00:00.000Z');
    const until = parseProviderRateLimitReset('rate_limit_error', now);
    expect(until.toISOString()).toBe('2026-11-08T19:00:00.000Z');
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
