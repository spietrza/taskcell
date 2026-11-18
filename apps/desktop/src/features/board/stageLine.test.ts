import { describe, expect, test } from 'vitest';
import { liveStage, liveStations, repairAttempts, stageLine, stepsAt } from './stageLine';
import { detailOutcome, runStationOf } from '../../stations';
import type { RunDetail } from '../../wire';

const statuses = (column: Parameters<typeof stageLine>[0]['column'], stage?: string, opts?: Parameters<typeof stageLine>[1]): string =>
  stageLine({ column, stage }, opts).map((s) => s.status[0]).join('');

describe('stageLine', () => {
  test('always the six stages in order', () => {
    expect(stageLine({ column: 'queued' }).map((s) => s.label)).toEqual(['Card', 'Spec', 'Sealed cell', 'Gates', 'Review', 'Pull request']);
  });

  test.each([
    ['queued', undefined, 'cwwwww'],
    ['claimed', undefined, 'dcwwww'],
    ['running', undefined, 'ddcwww'],
    ['running', 'implementer', 'ddcwww'],
    ['running', 'conformance', 'dddcww'],
    ['running', 'reviewer', 'ddddcw'],
    ['verify-failed', undefined, 'dddfww'],
    ['review', undefined, 'ddddcw'],
    ['done', undefined, 'dddddd'],
  ] as const)('%s / %s → %s', (column, stage, expected) => {
    expect(statuses(column, stage)).toBe(expected);
  });

  test('a review card with a pull request is on the pull request stage', () => {
    expect(statuses('review', undefined, { prExists: true })).toBe('dddddc');
  });

  test('a repair puts a running card on Gates as "repair 1 of 2"', () => {
    const gates = stageLine({ column: 'running', stage: 'implementer' }, { repairs: 1 })[3];
    expect(gates).toMatchObject({ status: 'current', note: 'repair 1 of 2' });
  });

  test('reads the repair cap from the run', () => {
    expect(stageLine({ column: 'running', stage: 'implementer' }, { repairs: 4, maxRepairs: 5 })[3]?.note).toBe('repair 4 of 5');
  });

  test('no repair, no note', () => {
    expect(stageLine({ column: 'running', stage: 'conformance' })[3]).not.toHaveProperty('note');
  });
});

describe('repairAttempts', () => {
  const run = (attempts?: number): Pick<RunDetail, 'stages'> => ({ stages: [{ record: { stage: 'implementer', ...(attempts !== undefined ? { attempts } : {}) } as never }] });
  test('extra implementer attempts are repairs', () => {
    expect(repairAttempts(run(2))).toBe(1);
    expect(repairAttempts(run(1))).toBe(0);
    expect(repairAttempts(run())).toBe(0);
    expect(repairAttempts(undefined)).toBe(0);
  });
});

describe('a finished run on the line (runStationOf, the one mapping)', () => {
  const rec = (stage: string, completed = true) => ({ record: { stage, completed } as never });
  const status = (run: Parameters<typeof detailOutcome>[0], card?: Parameters<typeof detailOutcome>[1]): string =>
    stepsAt(runStationOf(detailOutcome(run, card))).map((s) => s.status[0]).join('');
  test('merged, or done without a PR: every station done', () => {
    expect(status({ stages: [rec('implementer')], prUrl: 'u' }, { prState: 'merged' })).toBe('dddddd');
    expect(status({ stages: [rec('implementer')] }, { cardDone: true })).toBe('dddddd');
  });
  test('a pass waits on the PR station, with or without a PR', () => {
    expect(status({ stages: [rec('implementer')], prUrl: 'u' })).toBe('dddddc');
    expect(status({ stages: [rec('implementer')] })).toBe('dddddc');
  });
  test('a failed gate or stage marks its station, even with a PR or a done card', () => {
    expect(status({ stages: [rec('implementer')], proof: { passed: false } as never })).toBe('dddfww');
    expect(status({ stages: [rec('implementer'), rec('reviewer', false)], prUrl: 'u' })).toBe('ddddfw');
    expect(status({ stages: [rec('implementer', false)] }, { cardDone: true })).toBe('ddfwww');
  });
});

describe('liveStations', () => {
  const status = (steps: { status: string }[]): string => steps.map((s) => s.status[0]).join('');
  test('follows the running stage; the gate step sits on Gates; an error marks it red', () => {
    expect(liveStage([{ name: 'sandbox', phase: 'done' }, { name: 'implementer', phase: 'running' }])).toBe('implementer');
    expect(liveStage([{ name: 'implementer', phase: 'done' }, { name: 'tests', phase: 'running' }])).toBe('gates');
    expect(liveStage([{ name: 'implementer', phase: 'pending' }])).toBeUndefined();
    expect(status(liveStations('implementer'))).toBe('ddcwww');
    expect(status(liveStations('gates'))).toBe('dddcww');
    expect(status(liveStations('reviewer', true))).toBe('ddddfw');
    expect(status(liveStations(undefined))).toBe('dcwwww');
  });
});
