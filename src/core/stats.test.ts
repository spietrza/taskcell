import { describe, it, expect } from 'vitest';
import { parseMetrics, parseProbes, aggregateMetrics, formatStats, modelKey, probeReport } from './stats.js';
import { modelPickReport, formatModelPicks, credentialReport, formatCredentials } from './stats.js';

const line = (o: Record<string, unknown>): string => JSON.stringify({ evt: 'run_complete', ...o });

describe('parseMetrics', () => {
  it('parses run_complete lines and skips blanks/malformed/non-run_complete', () => {
    const text = [
      line({ taskId: 'a', stage: 'implementer', costUsd: 0.1, inputTokens: 10, durationMs: 1000 }),
      '',
      'not json',
      JSON.stringify({ evt: 'something_else', taskId: 'a' }),
      line({ stage: 'x' }), // no taskId → skipped
      line({ taskId: 'b', costUsd: 0.2 }),
    ].join('\n');
    const recs = parseMetrics(text);
    expect(recs).toHaveLength(2);
    expect(recs[0]?.taskId).toBe('a');
    expect(recs[0]?.costUsd).toBe(0.1);
    expect(recs[1]?.taskId).toBe('b');
    expect(recs[1]?.outputTokens).toBe(0); // missing → 0
  });
});

describe('aggregateMetrics', () => {
  it('sums per task, per stage, and grand total', () => {
    const recs = parseMetrics(
      [
        line({ taskId: 'a', stage: 'implementer', costUsd: 0.30, inputTokens: 100, cacheReadInputTokens: 900, durationMs: 2000 }),
        line({ taskId: 'a', stage: 'reviewer', costUsd: 0.10, inputTokens: 50, cacheReadInputTokens: 50, durationMs: 1000 }),
        line({ taskId: 'b', stage: 'implementer', costUsd: 0.20, inputTokens: 100, cacheReadInputTokens: 0, durationMs: 500 }),
      ].join('\n'),
    );
    const report = aggregateMetrics(recs);

    const taskA = report.byTask.find((t) => t.key === 'a');
    expect(taskA?.entries).toBe(2);
    expect(taskA?.costUsd).toBeCloseTo(0.40);
    expect(taskA?.durationMs).toBe(3000);

    const impl = report.byStage.find((s) => s.key === 'implementer');
    expect(impl?.entries).toBe(2);
    expect(impl?.costUsd).toBeCloseTo(0.50);

    expect(report.total.entries).toBe(3);
    expect(report.byModel.map((m) => m.key)).toEqual(['(no model recorded)']);
    expect(report.total.costUsd).toBeCloseTo(0.60);
    expect(report.total.cacheReadInputTokens).toBe(950);
  });

  it('buckets by served model so a model swap can be compared', () => {
    const report = aggregateMetrics(
      parseMetrics(
        [
          line({ taskId: 'a', stage: 'implementer', model: 'claude-sonnet-5', costUsd: 0.3 }),
          line({ taskId: 'a', stage: 'reviewer', model: 'claude-fable-5', costUsd: 0.5 }),
          line({ taskId: 'b', stage: 'implementer', model: 'claude-sonnet-5', costUsd: 0.2 }),
        ].join('\n'),
      ),
    );
    const sonnet = report.byModel.find((m) => m.key === 'claude-sonnet-5');
    expect(sonnet?.entries).toBe(2);
    expect(sonnet?.costUsd).toBeCloseTo(0.5);
    expect(report.byModel.find((m) => m.key === 'claude-fable-5')?.costUsd).toBeCloseTo(0.5);
  });

  it('modelKey makes a gateway substitution its own row', () => {
    expect(modelKey({ model: 'claude-fable-5', requestedModel: 'claude-fable-5' })).toBe('claude-fable-5');
    expect(modelKey({ model: 'claude-sonnet-4-6', requestedModel: 'claude-fable-5' })).toBe('claude-sonnet-4-6 (requested claude-fable-5)');
    expect(modelKey({ model: 'claude-opus-4-8' })).toBe('claude-opus-4-8');
    // An alias resolving within its own family is not annotated; a cross-family swap still is.
    expect(modelKey({ model: 'claude-sonnet-5-5', requestedModel: 'sonnet' })).toBe('claude-sonnet-5-5');
    expect(modelKey({ model: 'claude-sonnet-4-6', requestedModel: 'opus' })).toBe('claude-sonnet-4-6 (requested opus)');
    expect(modelKey({ requestedModel: 'opus' })).toBe('opus');
    expect(modelKey({})).toBe('(no model recorded)');
  });

  it('empty input yields a zeroed report', () => {
    const report = aggregateMetrics(parseMetrics(''));
    expect(report.byTask).toEqual([]);
    expect(report.total.entries).toBe(0);
  });
});

describe('estimated cost', () => {
  const records = parseMetrics(
    [
      line({ taskId: 'a', model: 'claude-sonnet-5-5', costUsd: 1 }),
      line({ taskId: 'b', model: 'gpt-5', costUsd: 0, estCostUsd: 0.5 }),
      line({ taskId: 'c', model: 'unpriced', costUsd: 0 }),
    ].join('\n'),
  );
  it('keeps reported and estimated cost apart and marks the estimate', () => {
    const report = aggregateMetrics(records);
    expect(report.total).toMatchObject({ costUsd: 1, estCostUsd: 0.5 });
    expect(report.byModel.find((b) => b.key === 'gpt-5')).toMatchObject({ costUsd: 0, estCostUsd: 0.5 });
    const out = formatStats(report);
    expect(out).toContain('$est');
    expect(out).toContain('≈0.5000');
    expect(out).toContain('not billed per token');
  });
  it('drops a negative or non-numeric estimate, and one on a line that carries a reported cost', () => {
    const parsed = parseMetrics(
      [
        line({ taskId: 'neg', costUsd: 0, estCostUsd: -3 }),
        line({ taskId: 'str', costUsd: 0, estCostUsd: '0.5' }),
        line({ taskId: 'reported', costUsd: 1, estCostUsd: 0.5 }),
        line({ taskId: 'stamped', costUsd: 0, costKind: 'estimated', estCostUsd: 0.5 }),
        line({ taskId: 'ok', costUsd: 0, costUnknown: true, estCostUsd: 0.5 }),
      ].join('\n'),
    );
    expect(parsed.filter((r) => r.estCostUsd !== undefined).map((r) => r.taskId)).toEqual(['ok']);
    expect(aggregateMetrics(parsed).total).toMatchObject({ costUsd: 1, estCostUsd: 0.5, estEntries: 1 });
  });
  it('adds no estimate column when none exists', () => {
    expect(formatStats(aggregateMetrics(records.slice(0, 1)))).not.toContain('$est');
  });
});

describe('formatStats', () => {
  it('renders task, stage and total sections with numbers', () => {
    const report = aggregateMetrics(parseMetrics(line({ taskId: 'a', stage: 'implementer', costUsd: 0.25, inputTokens: 100, cacheReadInputTokens: 900, durationMs: 2000 })));
    const out = formatStats(report);
    expect(out).toContain('BY TASK');
    expect(out).toContain('BY STAGE');
    expect(out).toContain('BY MODEL');
    expect(out).toContain('TOTAL');
    expect(out).toContain('0.2500');
    expect(out).toContain('90%'); // 900/(100+900)
  });
});

describe('decision probe join', () => {
  const T = (n: number): string => `2026-10-07T10:${String(n).padStart(2, '0')}:00.000Z`;
  const probe = (taskId: string, difficulty: number, completesFirstTry: number, ts = T(0)): string =>
    JSON.stringify({ evt: 'decision_probe', ts, taskId, completesFirstTry, difficulty, specClear: 0.8 });
  const run = (taskId: string, ts: string, extra: Record<string, unknown> = {}): string =>
    line({ taskId, ts, stage: 'implementer', exitReason: 'completed', ...extra });

  it('buckets probes by predicted level and reports predicted vs observed first-try rate', () => {
    const text = [
      probe('a', 0.9, 0.9), run('a', T(1)),
      probe('b', 1.2, 0.8), run('b', T(1), { attempts: 2, firstExitReason: 'maxTurns' }),
      probe('c', 3.4, 0.2), run('c', T(1), { exitReason: 'incomplete' }),
      probe('d', 2.0, 0.5), // no implementer record → dropped
      run('e', T(1)), // no probe → not in the table
    ].join('\n');
    const report = probeReport(parseMetrics(text), parseProbes(text));
    expect(report).toEqual([
      { level: 'Routine', runs: 2, repaired: 1, predictedFirstTry: 0.85, observedFirstTry: 0.5 },
      { level: 'Hard', runs: 1, repaired: 1, predictedFirstTry: 0.2, observedFirstTry: 0 },
    ]);
    expect(formatStats(aggregateMetrics(parseMetrics(text), parseProbes(text)))).toContain('PROBE: predicted difficulty');
    expect(aggregateMetrics(parseMetrics(text))).not.toHaveProperty('probes');
  });

  it('leaves a provider-limit stop out of the observed first-try rate', () => {
    const text = [
      probe('a', 1.0, 0.9, T(0)), run('a', T(1), { exitReason: 'error', stoppedBy: 'provider-limit' }), // parked by the limit
      probe('a', 1.0, 0.9, T(2)), run('a', T(3)), // the retry, clean
    ].join('\n');
    expect(probeReport(parseMetrics(text), parseProbes(text))).toEqual([
      { level: 'Routine', runs: 1, repaired: 0, predictedFirstTry: 0.9, observedFirstTry: 1 },
    ]);
  });

  it('joins each probe to the run it preceded, so a re-run task yields one pair per run', () => {
    const text = [
      probe('a', 1.0, 0.9, T(0)), run('a', T(1), { attempts: 2 }), // 1st run: repaired
      probe('a', 1.0, 0.9, T(2)), run('a', T(3)), // 2nd run: clean
      probe('a', 1.0, 0.9, T(4)), // 3rd probe: run cancelled before the pipeline → no record → dropped
      run('a', '2026-10-07T09:59:00.000Z'), // an implementer line BEFORE the first probe never matches
    ].join('\n');
    expect(probeReport(parseMetrics(text), parseProbes(text))).toEqual([
      { level: 'Routine', runs: 2, repaired: 1, predictedFirstTry: 0.9, observedFirstTry: 0.5 },
    ]);
  });
});

describe('modelPickReport', () => {
  it('compares models per stage and pick on cost, gate pass, review verdict and revise rounds', () => {
    const lines = [
      { evt: 'run_complete', taskId: 'a', ts: 't1', stage: 'implementer', requestedModel: 'sonnet', provider: 'claude', pick: 'rotation', costUsd: 1 },
      { evt: 'verify', taskId: 'a', ts: 't1', passed: true },
      { evt: 'run_complete', taskId: 'a', ts: 't1', stage: 'reviewer', verdict: 'pass', costUsd: 0.1 },
      { evt: 'run_complete', taskId: 'a', ts: 't2', stage: 'revise', costUsd: 0.2 },
      { evt: 'run_complete', taskId: 'b', ts: 't3', stage: 'implementer', requestedModel: 'qwen', provider: 'openrouter', pick: 'rotation', costUsd: 0.1 },
      { evt: 'verify', taskId: 'b', ts: 't3', passed: false },
      { evt: 'run_complete', taskId: 'c', ts: 't4', stage: 'implementer', model: 'x', costUsd: 1 },
    ];
    const rows = modelPickReport(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(rows).toEqual([
      { stage: 'implementer', model: 'claude/sonnet', pick: 'rotation', runs: 1, costUsd: 1, gateRuns: 1, gatePassed: 1, reviewed: 1, reviewPassed: 1, reviseRounds: 1 },
      { stage: 'implementer', model: 'openrouter/qwen', pick: 'rotation', runs: 1, costUsd: 0.1, gateRuns: 1, gatePassed: 0, reviewed: 0, reviewPassed: 0, reviseRounds: 0 },
    ]);
    const out = formatModelPicks(rows);
    expect(out).toContain('BY MODEL PER STAGE');
    expect(out).toContain('100% (1/1)');
    expect(formatModelPicks([])).toBe('');
  });
});

describe('credentialReport', () => {
  it('groups by credential name, counts limit stops and skips lines without a credential', () => {
    const lines = [
      { evt: 'run_complete', taskId: 'a', ts: 't1', stage: 'implementer', credential: 'Key B', costUsd: 1, inputTokens: 10, outputTokens: 5 },
      { evt: 'run_complete', taskId: 'a', ts: 't1', stage: 'reviewer', credential: 'Key B', costUsd: 0.5, inputTokens: 1, outputTokens: 2, stoppedBy: 'provider-limit' },
      { evt: 'run_complete', taskId: 'b', ts: 't2', stage: 'implementer', credential: 'Key A', costUsd: 2, inputTokens: 3, outputTokens: 4 },
      { evt: 'run_complete', taskId: 'c', ts: 't3', stage: 'implementer', costUsd: 9 },
    ];
    const rows = credentialReport(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(rows).toEqual([
      { credential: 'Key A', runs: 1, costUsd: 2, inputTokens: 3, outputTokens: 4, limitStops: 0 },
      { credential: 'Key B', runs: 2, costUsd: 1.5, inputTokens: 11, outputTokens: 7, limitStops: 1 },
    ]);
    expect(formatCredentials(rows)).toContain('BY CREDENTIAL');
    expect(formatCredentials([])).toBe('');
  });
});
