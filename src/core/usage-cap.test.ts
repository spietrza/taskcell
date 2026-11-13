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
  delete process.env['TASKCELL_USAGE_CAP_PCT'];
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
    recordUtilization('claude-code', { pct: 99, resetsAt: FUTURE }, NOW);
    expect(usageCapStatus('claude-code', NOW, undefined)).toEqual({ state: 'uncapped' });
  });

  it('runs under the cap', () => {
    recordUtilization('claude-code', { pct: 50, resetsAt: FUTURE }, NOW);
    expect(usageCapStatus('claude-code', NOW, 80)).toEqual({ state: 'under', pct: 50, cap: 80 });
  });

  it('pauses at and over the cap with the provider reset as until', () => {
    for (const pct of [80, 82]) {
      recordUtilization('claude-code', { pct, resetsAt: FUTURE }, NOW);
      expect(usageCapStatus('claude-code', NOW, 80)).toEqual({ state: 'capped', pct, cap: 80, until: FUTURE });
    }
  });

  it('does not block on unknown or stale utilization, and logs once', () => {
    process.env['TASKCELL_USAGE_CAP_PCT'] = '80';
    const lines: string[] = [];
    const log = { info: (_o: object, m: string): void => void lines.push(m) };
    enforceUsageCap('codex', log);
    enforceUsageCap('codex', log);
    expect(lines).toHaveLength(1);
    recordUtilization('codex', { pct: 99, resetsAt: new Date(NOW.getTime() + 1) }, NOW);
    expect(usageCapStatus('codex', new Date(NOW.getTime() + 1), 80)).toEqual({ state: 'unknown' });
  });

  it('enforceUsageCap throws UsageCapError carrying the reset', () => {
    process.env['TASKCELL_USAGE_CAP_PCT'] = '80';
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

describe('agent-controlled stream values are bounded', () => {
  const DAY = 24 * 3_600_000;

  it('reads Claude utilization as a fraction only, so overage above 1.0 is 100%, not ~1%', () => {
    expect(parseClaudeUtilization({ type: 'rate_limit_event', rate_limit_info: { utilization: 1.02 } })).toEqual({ pct: 100 });
    expect(parseClaudeUtilization({ type: 'rate_limit_event', rate_limit_info: { utilization: 1 } })).toEqual({ pct: 100 });
  });

  it('drops an Invalid Date reset instead of crashing the cap error', () => {
    const u = parseClaudeUtilization({ type: 'rate_limit_event', rate_limit_info: { utilization: 1, resetsAt: 1e20 } });
    expect(u).toEqual({ pct: 100 });
    process.env['TASKCELL_USAGE_CAP_PCT'] = '80';
    recordUtilization('claude-code', { pct: 100, resetsAt: new Date(NaN) });
    const err = (() => {
      try {
        enforceUsageCap('claude-code');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(UsageCapError);
    expect(Number.isNaN((err as UsageCapError).until.getTime())).toBe(false);
  });

  it('clamps pct to 0..100 and a far-future reset to now + 8 days', () => {
    expect(parseCodexUtilization({ rate_limits: { primary: { used_percent: 500 } } })).toEqual({ pct: 100 });
    expect(parseCodexUtilization({ rate_limits: { primary: { used_percent: -5 } } })).toEqual({ pct: 0 });
    recordUtilization('codex', { pct: 99, resetsAt: new Date('9999-01-01T00:00:00Z') }, NOW);
    const status = usageCapStatus('codex', NOW, 80);
    expect(status).toEqual({ state: 'capped', pct: 99, cap: 80, until: new Date(NOW.getTime() + 8 * DAY) });
    expect(usageCapStatus('codex', new Date(NOW.getTime() + 8 * DAY), 80)).toEqual({ state: 'unknown' });
  });

  it('expires a reading with no reset after an hour instead of capping forever', () => {
    recordUtilization('codex', { pct: 95 }, NOW);
    expect(usageCapStatus('codex', NOW, 80)).toEqual({ state: 'capped', pct: 95, cap: 80, until: FUTURE });
    expect(usageCapStatus('codex', new Date(NOW.getTime() + 30 * 60_000), 80)).toMatchObject({ state: 'capped', until: FUTURE });
    expect(usageCapStatus('codex', FUTURE, 80)).toEqual({ state: 'unknown' });
  });

  it('limits how deep the Codex parser recurses', () => {
    let deep: unknown = { rate_limits: { primary: { used_percent: 90 } } };
    for (let i = 0; i < 100_000; i++) deep = { msg: deep };
    expect(parseCodexUtilization(deep)).toBeUndefined();
    expect(parseCodexUtilization({ payload: { msg: { rate_limits: { primary: { used_percent: 90 } } } } })).toEqual({ pct: 90 });
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
