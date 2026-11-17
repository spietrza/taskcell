import { describe, expect, test } from 'vitest';
import { receipt, receiptRows } from './receipt';
import type { RunDetail } from '../../wire';

const run = (over: Partial<RunDetail> = {}): RunDetail => ({ taskId: 't', timestamp: 'x', stages: [], ...over });
const values = (r: ReturnType<typeof receipt>): Record<string, string> => Object.fromEntries(r.map((f) => [f.key, f.value]));
const stage = (record: Record<string, unknown>, diff?: string): RunDetail['stages'][number] => ({ record: record as never, ...(diff !== undefined ? { diff } : {}) });

describe('receipt', () => {
  test('no run: all four facts are "not yet"', () => {
    expect(receipt(undefined).map((f) => f.value)).toEqual(Array(4).fill('not yet'));
  });

  test('a run without facts never guesses', () => {
    expect(receipt(run()).map((f) => f.value)).toEqual(Array(4).fill('not recorded'));
  });

  test('known facts shown, missing ones stay "not recorded"', () => {
    const facts = receipt(
      run({ proof: { command: 'pnpm test', exitCode: 0, passed: true } as RunDetail['proof'], stages: [stage({ stage: 'reviewer', verdict: 'pass' })] }),
      0.75,
    );
    expect(values(facts)).toEqual({ tests: 'passed', review: 'passed', secrets: 'not recorded', cost: '$0.75' });
  });

  test('failing tests and review verdicts', () => {
    const facts = receipt(run({ proof: { passed: false } as RunDetail['proof'], stages: [stage({ stage: 'reviewer', verdict: 'changes' })] }));
    expect(values(facts)).toMatchObject({ tests: 'failed', review: 'changes requested' });
    expect(values(receipt(run({ stages: [stage({ stage: 'reviewer', verdict: 'incomplete' })] }))).review).toBe('incomplete');
  });

  test('secret scan: clean only with a kept implementer diff; found on a scan-withheld diff; blocked is ambiguous', () => {
    expect(values(receipt(run({ stages: [stage({ stage: 'implementer' }, 'diff')] }))).secrets).toBe('clean');
    expect(values(receipt(run({ stages: [stage({ stage: 'reviewer' }, 'diff')] }))).secrets).toBe('not recorded');
    expect(values(receipt(run({ stages: [stage({ stage: 'implementer', diffOmitted: 'secret-scan' })] }))).secrets).toBe('secret found');
    expect(values(receipt(run({ stages: [stage({ stage: 'implementer', diffOmitted: 'secret-blocked' }, 'diff')] }))).secrets).toBe('not recorded');
  });

  test('zero cost is not a fact', () => {
    expect(values(receipt(run(), 0)).cost).toBe('not recorded');
  });
});

describe('receiptRows', () => {
  const rows = (r: RunDetail, cost?: string): Record<string, string> => Object.fromEntries(receiptRows(r, cost).map((x) => [x.label, x.value]));
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n-y\n';

  test('a finished empty record: "not recorded", Spec "from the issue", no Skills used row; a live one: all "not yet"', () => {
    expect(rows(run())).toEqual({ Spec: 'from the issue', Author: 'not recorded', Reviewer: 'not recorded', Gates: 'not recorded', 'Secret scan': 'not recorded', 'CI config': 'not recorded', Diff: 'not recorded', Cost: 'not recorded' });
    expect(new Set(receiptRows(run(), undefined, true).map((x) => x.value))).toEqual(new Set(['not yet']));
  });

  test('fills rows from the records', () => {
    const r = rows(
      run({
        proof: { command: 'pnpm test', passed: true } as RunDetail['proof'],
        stages: [stage({ stage: 'implementer', model: 'sonnet', skillsUsed: [] }, 'diff --git a/src/a.ts b/src/a.ts\n+x\n'), stage({ stage: 'reviewer', model: 'opus', verdict: 'pass', skillsUsed: ['review'] })],
      }),
      '$0.50',
    );
    expect(r).toMatchObject({ Author: 'sonnet', Reviewer: 'opus · passed', Gates: 'passed · pnpm test', 'Secret scan': 'clean', 'CI config': 'untouched', Diff: '1 file · +1 −0', 'Skills used': 'review', Cost: '$0.50' });
  });

  test('skills used: "none" for recorded empty lists; CI config edits are named', () => {
    const r = rows(run({ stages: [stage({ stage: 'implementer', skillsUsed: [] }, diff)] }));
    expect(r['Skills used']).toBe('none');
    expect(r['CI config']).toBe('changed: .github/workflows/ci.yml');
  });
});
