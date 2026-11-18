import { describe, expect, test } from 'vitest';
import { STATIONS, STATION_SHORT, cardStationOf, detailOutcome, runStationOf, stationOf } from './stations';

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

describe('runStationOf', () => {
  const run = { anyFailed: false };
  test('merged, or a card done without a PR, is past the line; any other pass waits on the PR station', () => {
    expect(runStationOf({ ...run, prState: 'merged', prUrl: 'u' }).at).toBe(STATIONS.length);
    expect(runStationOf({ ...run, cardDone: true }).at).toBe(STATIONS.length);
    expect(runStationOf({ ...run, prUrl: 'u' })).toEqual({ at: 5, failed: false });
    expect(runStationOf(run)).toEqual({ at: 5, failed: false });
  });
  test('a failure marks the station of its failed stage, PR or not; a provider-limit stop is not a failure', () => {
    expect(runStationOf({ ...run, anyFailed: true, failedStage: 'implementer', prUrl: 'u' })).toEqual({ at: 2, failed: true });
    expect(runStationOf({ ...run, anyFailed: true, failedStage: 'tech-spec' })).toEqual({ at: 1, failed: true });
    expect(runStationOf({ ...run, anyFailed: true, failedStage: 'reviewer', stoppedBy: 'provider-limit' })).toEqual({ at: 4, failed: false });
    expect(runStationOf({ ...run, verifyFailed: true, prUrl: 'u' })).toEqual({ at: 3, failed: true });
    expect(runStationOf({ ...run, anyFailed: true, failedStage: 'implementer', cardDone: true })).toEqual({ at: 2, failed: true });
  });
});

describe('cardStationOf', () => {
  test('a card in Review or failed follows its newest run; a Done card is done; a live or waiting card its column', () => {
    const failed = { anyFailed: true, failedStage: 'implementer' };
    expect(cardStationOf({ column: 'verify-failed' }, failed)).toEqual({ at: 2, failed: true });
    // The store says done (a delivered run may carry a failed stage): past the line, as the Board's Done column.
    expect(cardStationOf({ column: 'done' }, failed)).toEqual({ at: STATIONS.length, failed: false });
    expect(cardStationOf({ column: 'done' }, undefined)).toEqual({ at: STATIONS.length, failed: false });
    expect(cardStationOf({ column: 'queued' }, failed)).toEqual({ at: 0, failed: false });
    expect(cardStationOf({ column: 'running', stage: 'reviewer' }, failed)).toEqual({ at: 4, failed: false });
  });
  test('a failed hub card with a stage sits on that stage\'s station; one that asked waits there, not failed', () => {
    expect(stationOf({ column: 'verify-failed', stage: 'implementer' })).toEqual({ at: 2, failed: true });
    expect(stationOf({ column: 'verify-failed', stage: 'implementer', asked: true })).toEqual({ at: 2, failed: false });
  });
  test('a run that stopped to ask waits in the Cell; its gates read passed when its proof passed (the receipt\'s source)', () => {
    const asked = { anyFailed: true, failedStage: 'implementer', asked: 'Which file?' };
    expect(cardStationOf({ column: 'verify-failed', stage: 'implementer', asked: true }, asked)).toEqual({ at: 2, failed: false });
    const record = (r: Record<string, unknown>) => ({ record: { taskId: 'hub-4', timestamp: 't', turns: 1, worktreePath: '', worktreePreserved: false, ...r } }) as never;
    const outcome = detailOutcome({ stages: [record({ stage: 'implementer', completed: false, exitReason: 'incomplete', finalText: 'Which file?' })], proof: { passed: true } as never });
    expect(outcome).toMatchObject({ asked: 'Which file?', verifyPassed: true, failedStage: 'implementer' });
    expect(runStationOf(outcome)).toEqual({ at: 2, failed: false, passed: [3] });
    // A turn cap is not a question: the Cell stays failed.
    expect(runStationOf(detailOutcome({ stages: [record({ stage: 'implementer', completed: false, exitReason: 'maxTurns', finalText: '' })] }))).toEqual({ at: 2, failed: true });
  });
});
