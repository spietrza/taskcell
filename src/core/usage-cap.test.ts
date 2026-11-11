import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  enforceUsageCap,
  parseClaudeUtilization,
  parseCodexUtilization,
  parseUsageCap,
  recordUtilization,
  resetUsageCapLog,
  resetUtilization,
  UsageCapError,
  usageCapStatus,
} from './usage-cap.js';
import { rateLimitHold, parseRateLimitedMarker } from './rate-limit-marker.js';

const fixture = (name: string): unknown[] =>
  readFileSync(new URL(`./usage-cap.${name}.fixture.ndjson`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);

const RESET = new Date(1893456000 * 1000);
const NOW = new Date('2030-01-01T00:00:00Z');
const FUTURE = new Date(NOW.getTime() + 3_600_000);

beforeEach(() => {
  resetUtilization();
  resetUsageCapLog();
  delete process.env['VANGUARD_USAGE_CAP_PCT'];
});

describe('utilization parsing (recorded fixtures)', () => {
  it('reads Claude Code rate_limit_event utilization and reset', () => {
    const found = fixture('claude').map(parseClaudeUtilization).filter((u) => u !== undefined);
    expect(found).toHaveLength(1); // the second event reports no utilization
    expect(found[0]?.pct).toBeCloseTo(82);
    expect(found[0]?.resetsAt).toEqual(RESET);
  });

  it("reads Codex rate_limits and takes the most-used window", () => {
    const found = fixture('codex').map((e) => parseCodexUtilization(e)).filter((u) => u !== undefined);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ pct: 82, resetsAt: RESET });
  });

  it('finds Codex rate_limits nested under msg', () => {
    expect(parseCodexUtilization({ msg: { rate_limits: { primary: { used_percent: 5 } } } })).toEqual({ pct: 5 });
  });
});

describe('usage cap status', () => {
  it('is uncapped when no cap is set', () => {
    recordUtilization('claude-code', { pct: 99, resetsAt: FUTURE });
    expect(usageCapStatus('claude-code', NOW, undefined)).toEqual({ state: 'uncapped' });
  });

  it('runs under the cap', () => {
    recordUtilization('claude-code', { pct: 50, resetsAt: FUTURE });
    expect(usageCapStatus('claude-code', NOW, 80)).toEqual({ state: 'under', pct: 50, cap: 80 });
  });

  it('pauses at and over the cap with the provider reset as until', () => {
    for (const pct of [80, 82]) {
      recordUtilization('claude-code', { pct, resetsAt: FUTURE });
      expect(usageCapStatus('claude-code', NOW, 80)).toEqual({ state: 'capped', pct, cap: 80, until: FUTURE });
    }
  });

  it('does not block on unknown or stale utilization, and logs once', () => {
    process.env['VANGUARD_USAGE_CAP_PCT'] = '80';
    const lines: string[] = [];
    const log = { info: (_o: object, m: string): void => void lines.push(m) };
    enforceUsageCap('codex', log);
    enforceUsageCap('codex', log);
    expect(lines).toHaveLength(1);
    recordUtilization('codex', { pct: 99, resetsAt: new Date(NOW.getTime() - 1) });
    expect(usageCapStatus('codex', NOW, 80)).toEqual({ state: 'unknown' });
  });

  it('enforceUsageCap throws UsageCapError carrying the reset', () => {
    process.env['VANGUARD_USAGE_CAP_PCT'] = '80';
    recordUtilization('claude-code', { pct: 82, resetsAt: new Date(Date.now() + 3_600_000) });
    expect(() => enforceUsageCap('claude-code')).toThrow(UsageCapError);
  });

  it('validates the cap range', () => {
    expect(parseUsageCap('80')).toBe(80);
    expect(parseUsageCap('0')).toBeUndefined();
    expect(parseUsageCap('101')).toBeUndefined();
    expect(parseUsageCap('abc')).toBeUndefined();
  });
});

describe('usage cap hold comment', () => {
  it('names the cap, is distinct from a 429, and carries a resumable marker', () => {
    const error = new UsageCapError('claude-code', 82, 80, FUTURE);
    const { until, comment } = rateLimitHold(error, 'ready for agent');
    expect(until).toEqual(FUTURE);
    expect(comment).toContain('paused at the usage cap (82% of 80%), resumes after');
    expect(comment).not.toContain('hit a rate limit');
    expect(parseRateLimitedMarker(comment)?.until).toEqual(FUTURE);
  });
});
