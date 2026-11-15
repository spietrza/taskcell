import { describe, it, expect } from 'vitest';
import { stageMetric, mergeAttempts } from './run-metric.js';
import type { RunResult } from './types.js';

const baseResult: RunResult = {
  taskId: 'task-1',
  completed: true,
  exitReason: 'completed',
  turns: 3,
  worktreePath: '/tmp/wt',
  worktreePreserved: false,
  finalText: 'done',
};

describe('stageMetric', () => {
  it('builds a flat metric from usage/cost/duration', () => {
    const result: RunResult = {
      ...baseResult,
      costUsd: 1.23,
      cacheEfficiency: 0.5,
      durationMs: 4200,
      model: 'claude-sonnet-4',
      usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 50 },
    };
    expect(stageMetric(result)).toEqual({
      taskId: 'task-1',
      exitReason: 'completed',
      completed: true,
      turns: 3,
      costUsd: 1.23,
      cacheEfficiency: 0.5,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 50,
      durationMs: 4200,
      model: 'claude-sonnet-4',
    });
  });

  it('defaults numbers to zero when usage/cost/duration are absent', () => {
    expect(stageMetric(baseResult)).toEqual({
      taskId: 'task-1',
      exitReason: 'completed',
      completed: true,
      turns: 3,
      costUsd: 0,
      cacheEfficiency: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 0,
    });
  });

  it('omits the stage key when stageName is not given', () => {
    expect(stageMetric(baseResult)).not.toHaveProperty('stage');
  });

  it('includes the stage key when stageName is given', () => {
    expect(stageMetric(baseResult, 'plan').stage).toBe('plan');
  });

  it('includes attempts/firstExitReason only for multi-attempt results, and requestedModel when given', () => {
    expect(stageMetric(baseResult)).not.toHaveProperty('attempts');
    const repaired: RunResult = { ...baseResult, attempts: 3, firstExitReason: 'maxTurns' };
    expect(stageMetric(repaired, 'implementer', { requestedModel: 'opus' })).toMatchObject({
      attempts: 3,
      firstExitReason: 'maxTurns',
      requestedModel: 'opus',
    });
    expect(stageMetric({ ...baseResult, attempts: 1 })).not.toHaveProperty('attempts');
  });

  it('includes budget fields only when provided', () => {
    expect(stageMetric(baseResult, 'plan', { stageCapUsd: 0.5, remainingBudgetUsd: 1 })).toMatchObject({
      stageCapUsd: 0.5,
      remainingBudgetUsd: 1,
    });
    expect(stageMetric(baseResult, 'plan', {})).not.toHaveProperty('stageCapUsd');
  });

  it('carries the structured provider-limit stop into metrics', () => {
    expect(stageMetric({ ...baseResult, completed: false, exitReason: 'error', stoppedBy: 'provider-limit' })).toMatchObject({
      stoppedBy: 'provider-limit',
    });
  });
});

describe('mergeAttempts', () => {
  it('sums cost/turns/tokens/duration and keeps the follow-up attempt identity', () => {
    const prior: RunResult = {
      ...baseResult, completed: false, exitReason: 'incomplete', turns: 4, sessionId: 's1', costUsd: 0.3,
      durationMs: 1000, usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900 },
    };
    const next: RunResult = {
      ...baseResult, turns: 2, sessionId: 's2', costUsd: 0.1, durationMs: 500, finalText: 'fixed',
      usage: { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 50 }, model: 'claude-sonnet-5',
    };
    const merged = mergeAttempts(prior, next);
    expect(merged).toMatchObject({
      completed: true, exitReason: 'completed', sessionId: 's2', finalText: 'fixed', model: 'claude-sonnet-5',
      turns: 6, costUsd: 0.4, durationMs: 1500,
      usage: { inputTokens: 150, outputTokens: 15, cacheReadInputTokens: 950 },
    });
    expect(merged.cacheEfficiency).toBeCloseTo(950 / 1100);
    // The truncation stays visible: two attempts, first ended 'incomplete'.
    expect(merged.attempts).toBe(2);
    expect(merged.firstExitReason).toBe('incomplete');
    const third = mergeAttempts(merged, { ...baseResult, turns: 1 });
    expect(third.attempts).toBe(3);
    expect(third.firstExitReason).toBe('incomplete');
  });

  it('keeps the reporting side when only one attempt carries cost/usage/duration', () => {
    const prior: RunResult = {
      ...baseResult, costUsd: 0.3, durationMs: 1000, usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0 },
    };
    const merged = mergeAttempts(prior, { ...baseResult, turns: 1 });
    expect(merged).toMatchObject({ turns: 4, costUsd: 0.3, durationMs: 1000, usage: prior.usage, cacheEfficiency: 0 });
  });

  it('leaves cost/usage/duration absent when neither attempt reports them', () => {
    const merged = mergeAttempts(baseResult, { ...baseResult, turns: 1 });
    expect(merged.turns).toBe(4);
    expect(merged).not.toHaveProperty('costUsd');
    expect(merged).not.toHaveProperty('usage');
    expect(merged).not.toHaveProperty('durationMs');
  });

  it('unions skills used across repaired and resumed attempts', () => {
    const skill = (id: string): string => JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: id } }] },
    });
    const merged = mergeAttempts(
      { ...baseResult, transcript: skill('first') },
      { ...baseResult, transcript: skill('second') },
    );
    expect(merged.skillsUsed).toEqual(['first', 'second']);
    expect(mergeAttempts(merged, { ...baseResult, transcript: 'unknown' }).skillsUsed).toEqual(['first', 'second']);
  });
});

describe('estCostUsd', () => {
  const base = { taskId: 't', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '' } as const;
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0 };
  it('estimates a priced model without touching costUsd', () => {
    const m = stageMetric({ ...base, model: 'gpt-5', usage });
    expect(m.estCostUsd).toBe(1.25);
    expect(m.costUsd).toBe(0);
  });
  it('leaves an unpriced model and a reported cost without an estimate', () => {
    expect(stageMetric({ ...base, model: 'mystery', usage }).estCostUsd).toBeUndefined();
    expect(stageMetric({ ...base, model: 'gpt-5', usage, costUsd: 2 }).estCostUsd).toBeUndefined();
  });
});

describe('estCostUsd cache and merge semantics', () => {
  const base = { taskId: 't', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '' } as const;
  it('prices cache reads at the cache rate and only the rest of the input at the input rate, recording the tokens as reported', () => {
    // gpt-5: $1.25 in, $0.125 cache read per 1M; Codex's 1M input includes the 0.9M cached
    const m = stageMetric({ ...base, model: 'gpt-5', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 900_000 } });
    expect(m.estCostUsd).toBe(0.2375);
    expect(m).toMatchObject({ inputTokens: 1_000_000, cacheReadInputTokens: 900_000, costUsd: 0 });
  });
  it('keeps the estimate when one attempt has no usage', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0 };
    expect(stageMetric(mergeAttempts({ ...base, model: 'mystery' }, { ...base, model: 'gpt-5', usage })).estCostUsd).toBe(1.25);
    expect(stageMetric(mergeAttempts({ ...base, model: 'gpt-5', usage }, { ...base })).estCostUsd).toBe(1.25);
    // ...and a third attempt on another model still adds its own.
    const merged = mergeAttempts(mergeAttempts({ ...base }, { ...base, model: 'gpt-5', usage }), { ...base, model: 'gpt-5.5', usage });
    expect(stageMetric(merged).estCostUsd).toBe(6.25);
    // A reported cost on either side still means no estimate at all.
    expect(stageMetric(mergeAttempts({ ...base, costUsd: 1 }, { ...base, model: 'gpt-5', usage })).estCostUsd).toBeUndefined();
  });
  it('prices merged attempts on different models each at their own rate, and not at all when one is unpriced', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0 };
    const priced = mergeAttempts({ ...base, model: 'gpt-5', usage }, { ...base, model: 'gpt-5.5', usage });
    expect(stageMetric(priced).estCostUsd).toBe(6.25);
    expect(stageMetric(mergeAttempts(priced, { ...base, model: 'gpt-5.5', usage })).estCostUsd).toBe(11.25);
    expect(stageMetric(mergeAttempts({ ...base, model: 'gpt-5', usage }, { ...base, model: 'mystery', usage })).estCostUsd).toBeUndefined();
    expect(stageMetric(mergeAttempts({ ...base, model: 'gpt-5', usage }, { ...base, model: 'gpt-5', usage })).estCostUsd).toBe(2.5);
  });
});
