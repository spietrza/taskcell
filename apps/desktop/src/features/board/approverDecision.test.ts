import { expect, test } from 'vitest';
import { decisionForTask, decisionWords, prNumberOf } from './approverDecision';
import type { RunSummary } from '../../wire';

const run = (taskId: string, prUrl: string, timestamp = '2026-11-01T00:00:00Z'): RunSummary =>
  ({ taskId, prUrl, timestamp, stages: [], totalCostUsd: 0, anyFailed: false }) as RunSummary;

test('a task maps to its PR through its run, and the decision reads in plain words', () => {
  expect(prNumberOf('https://github.com/a/b/pull/12')).toBe(12);
  expect(prNumberOf(undefined)).toBeUndefined();
  const decisions = [{ prNumber: 12, outcome: 'left' as const, reasons: ['size-lines', 'size-files'] }, { prNumber: 13, outcome: 'merged' as const, reasons: [] }];
  const d = decisionForTask('gh-5', [run('gh-owner-repo-5', 'https://github.com/a/b/pull/12')], decisions);
  expect(decisionWords(d!)).toBe('Left for you: size-lines, size-files');
  expect(decisionWords(decisions[1]!)).toBe('Merged automatically');
  expect(decisionForTask('gh-6', [run('gh-6', 'https://github.com/a/b/pull/99')], decisions)).toBeUndefined();
});
