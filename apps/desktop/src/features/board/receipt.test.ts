import { describe, expect, test } from 'vitest';
import { receipt } from './receipt';
import type { RunDetail } from '../../wire';

const run = (over: Partial<RunDetail> = {}): RunDetail => ({ taskId: 't', timestamp: 'x', stages: [], ...over });
const values = (r: ReturnType<typeof receipt>): Record<string, string> => Object.fromEntries(r.map((f) => [f.key, f.value]));
const stage = (record: Record<string, unknown>, diff?: string): RunDetail['stages'][number] => ({ record: record as never, ...(diff !== undefined ? { diff } : {}) });

describe('receipt', () => {
  test('no run: all four facts are "not available"', () => {
    expect(receipt(undefined).map((f) => f.value)).toEqual(Array(4).fill('not available'));
  });

  test('a run without facts never guesses', () => {
    expect(receipt(run()).map((f) => f.value)).toEqual(Array(4).fill('not available'));
  });

  test('known facts shown, missing ones stay "not available"', () => {
    const facts = receipt(
      run({ proof: { command: 'pnpm test', exitCode: 0, passed: true } as RunDetail['proof'], stages: [stage({ stage: 'reviewer', verdict: 'pass' })] }),
      0.75,
    );
    expect(values(facts)).toEqual({ tests: 'passed', review: 'passed', secrets: 'not available', cost: '$0.75' });
  });

  test('failing tests and review verdicts', () => {
    const facts = receipt(run({ proof: { passed: false } as RunDetail['proof'], stages: [stage({ stage: 'reviewer', verdict: 'changes' })] }));
    expect(values(facts)).toMatchObject({ tests: 'failed', review: 'changes requested' });
    expect(values(receipt(run({ stages: [stage({ stage: 'reviewer', verdict: 'incomplete' })] }))).review).toBe('incomplete');
  });

  test('secret scan: clean only with a kept implementer diff; found on a scan-withheld diff; blocked is ambiguous', () => {
    expect(values(receipt(run({ stages: [stage({ stage: 'implementer' }, 'diff')] }))).secrets).toBe('clean');
    expect(values(receipt(run({ stages: [stage({ stage: 'reviewer' }, 'diff')] }))).secrets).toBe('not available');
    expect(values(receipt(run({ stages: [stage({ stage: 'implementer', diffOmitted: 'secret-scan' })] }))).secrets).toBe('secret found');
    expect(values(receipt(run({ stages: [stage({ stage: 'implementer', diffOmitted: 'secret-blocked' }, 'diff')] }))).secrets).toBe('not available');
  });

  test('zero cost is not a fact', () => {
    expect(values(receipt(run(), 0)).cost).toBe('not available');
  });
});
