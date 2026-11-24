import { describe, expect, test } from 'vitest';
import { liveStage, liveStations, repairAttempts, stageLine, stepsAt } from './stageLine';
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

describe('a place the hub sent, on the line', () => {
  const status = (place: Parameters<typeof stepsAt>[0]): string => stepsAt(place).map((s) => s.status[0]).join('');
  test('past the line: every station done; at the PR station: it is current', () => {
    expect(status({ at: 6, failed: false })).toBe('dddddd');
    expect(status({ at: 5, failed: false })).toBe('dddddc');
  });
  test('a failed place marks its station', () => {
    expect(status({ at: 3, failed: true })).toBe('dddfww');
    expect(status({ at: 4, failed: true })).toBe('ddddfw');
    expect(status({ at: 2, failed: true })).toBe('ddfwww');
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
