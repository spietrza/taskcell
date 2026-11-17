import { describe, expect, test } from 'vitest';
import { STATIONS, STATION_SHORT, stationOf } from './stations';

const at = (column: Parameters<typeof stationOf>[0]['column'], stage?: string, opts?: Parameters<typeof stationOf>[1]): number =>
  stationOf({ column, ...(stage !== undefined ? { stage } : {}) }, opts).at;

describe('stationOf', () => {
  test('columns map to stations', () => {
    expect(at('queued')).toBe(0);
    expect(at('claimed')).toBe(1);
    expect(at('running')).toBe(2);
    expect(at('done')).toBe(STATIONS.length);
  });

  test('a running card follows its stage marker; unknown markers (planner, sandbox) stay in the cell', () => {
    expect(at('running', 'spec')).toBe(1);
    expect(at('running', 'conformance')).toBe(3);
    expect(at('running', 'adversary')).toBe(4);
    expect(at('running', 'planner')).toBe(2);
    expect(at('running', 'implementer')).toBe(2);
  });

  test('repairs lift a running card to Gates, never back', () => {
    expect(at('running', 'implementer', { repairs: 1 })).toBe(3);
    expect(at('running', 'review', { repairs: 1 })).toBe(4);
  });

  test('verify-failed marks Gates failed; review moves on to the PR once one exists', () => {
    expect(stationOf({ column: 'verify-failed' })).toEqual({ at: 3, failed: true });
    expect(at('review')).toBe(4);
    expect(at('review', undefined, { prExists: true })).toBe(5);
  });

  test('strip labels shorten only the cell and the pull request', () => {
    expect(STATIONS.map((s) => STATION_SHORT[s])).toEqual(['Card', 'Spec', 'Cell', 'Gates', 'Review', 'PR']);
  });
});
