import { expect, test } from 'vitest';
import { fmtDuration, foldRunEvents, stageLabel, stagesFromRecords, toLogLines, transcriptLines, withGateSteps, type LoggedEvent } from './runStages';
import type { StageDetail } from '../../taskcell-output';

let id = 0;
const ev = (ts: string, event: Record<string, unknown>, runId = 'run-0'): LoggedEvent => ({ id: ++id, ts, event: 'api:event', data: { runId, event } });
const start = ev('2026-11-16T10:00:00.000Z', { type: 'run-start', taskId: 'gh-r-3', stages: ['implementer', 'reviewer', 'simplifier'] });

test('formats a duration as seconds, minutes or hours', () => {
  expect(fmtDuration(42_000)).toBe('42s');
  expect(fmtDuration(75_000)).toBe('1m 15s');
  expect(fmtDuration(3_720_000)).toBe('1h 02m');
  expect(fmtDuration(-5)).toBe('0s');
});

test('a run in flight: finished stages carry their duration, the running one its start, the rest are pending', () => {
  const t = foldRunEvents([
    start,
    ev('2026-11-16T10:00:05.000Z', { type: 'stage-start', name: 'implementer', index: 0, of: 3 }),
    ev('2026-11-16T10:00:35.000Z', { type: 'stage-end', name: 'implementer', index: 0, of: 3, outcome: 'completed' }),
    ev('2026-11-16T10:00:36.000Z', { type: 'stage-start', name: 'reviewer', index: 1, of: 3 }),
  ]);
  expect(t.runId).toBe('run-0');
  expect(t.terminal).toBeUndefined();
  expect(t.startedAt).toBe(Date.parse('2026-11-16T10:00:00.000Z'));
  expect(t.stages).toEqual([
    { name: 'implementer', phase: 'done', ms: 30_000 },
    { name: 'reviewer', phase: 'running', startedAt: Date.parse('2026-11-16T10:00:36.000Z') },
    { name: 'simplifier', phase: 'pending' },
  ]);
});

test('the stages are the ones the run names, and the outcome and terminal event are read', () => {
  const failed = foldRunEvents([
    ev('2026-11-16T10:00:00.000Z', { type: 'run-start', taskId: 't', stages: ['planner', 'implement'] }),
    ev('2026-11-16T10:00:01.000Z', { type: 'stage-start', name: 'planner', index: 0, of: 2 }),
    ev('2026-11-16T10:00:03.000Z', { type: 'stage-end', name: 'planner', index: 0, of: 2, outcome: 'error' }),
    ev('2026-11-16T10:00:04.000Z', { type: 'run-error', message: 'boom' }),
  ]);
  expect(failed.stages.map((s) => [s.name, s.phase])).toEqual([['planner', 'failed'], ['implement', 'pending']]);
  expect(failed.terminal).toBe('error');
  expect(failed.message).toBe('boom');
  expect(failed.endedAt).toBe(Date.parse('2026-11-16T10:00:04.000Z'));
  expect(foldRunEvents([start, ev('2026-11-16T10:01:00.000Z', { type: 'run-end', prUrl: 'https://x/pull/1' })]).terminal).toBe('success');
  expect(foldRunEvents([start, ev('2026-11-16T10:01:00.000Z', { type: 'run-cancelled' })]).terminal).toBe('cancelled');
  expect(foldRunEvents([])).toEqual({ stages: [] });
});

test('a finished run reads its stages from the records, with each stage\'s own duration', () => {
  const rec = (stage: string, completed: boolean, durationMs?: number): StageDetail => ({
    record: { taskId: 't', completed, exitReason: 'x', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '', timestamp: 't', stage, ...(durationMs !== undefined ? { durationMs } : {}) },
  });
  expect(stagesFromRecords([rec('implementer', true, 27_277), rec('reviewer', false)])).toEqual([
    { name: 'implementer', src: 0, phase: 'done', ms: 27_277 },
    { name: 'reviewer', src: 1, phase: 'failed' },
  ]);
});

test('log lines: tool calls and the agent\'s first line only (no results, no cost line), empties dropped, only the tail kept', () => {
  const lines = toLogLines([
    { role: 'tool', text: 'Bash · pnpm test' },
    { role: 'tool_result', text: '14 passed' },
    { role: 'assistant', text: '\nAll green.\nMore words' },
    { role: 'assistant', text: '   ' },
    { role: 'result', text: 'success · $0.32' },
  ]);
  expect(lines).toEqual([{ cmd: true, text: 'Bash · pnpm test' }, { cmd: false, text: 'All green.' }]);
  expect(toLogLines(Array.from({ length: 30 }, (_, i) => ({ role: 'tool', text: `c${i}` })), 5).map((l) => l.text)).toEqual(['c25', 'c26', 'c27', 'c28', 'c29']);
  expect(transcriptLines(undefined)).toEqual([]);
  expect(transcriptLines(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }))).toEqual([{ cmd: true, text: 'Bash · ls' }]);
});

test('stage headings are words: Code, Review, Simplify, Plan, anything else capitalized', () => {
  expect(['implementer', 'reviewer', 'simplifier', 'spec', 'planner', 'conformance'].map(stageLabel)).toEqual(['Code', 'Review', 'Simplify', 'Plan', 'Plan', 'Conformance']);
});

test('gate steps: Tests after the last implementing stage, PR last with its number; absent records add nothing', () => {
  const st = stagesFromRecords([
    { record: { taskId: 't', completed: true, exitReason: 'x', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '', timestamp: 't', stage: 'implementer' } },
    { record: { taskId: 't', completed: true, exitReason: 'x', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '', timestamp: 't', stage: 'reviewer' } },
  ]);
  const proof = { command: 'pnpm test', exitCode: 0, passed: true, sha256: 'x', outputTail: '' };
  expect(withGateSteps(st, undefined, undefined)).toEqual(st);
  const full = withGateSteps(st, proof, 'https://github.com/o/r/pull/5');
  expect(full.map((s) => s.name)).toEqual(['implementer', 'tests', 'reviewer', 'pr']);
  expect(full[1]).toMatchObject({ phase: 'done', note: 'Passed' });
  expect(full[1]).not.toHaveProperty('ms');
  expect(full[3]).toMatchObject({ phase: 'done', note: '#5', href: 'https://github.com/o/r/pull/5' });
  expect(withGateSteps(st, { ...proof, passed: false }, undefined)[1]).toMatchObject({ phase: 'failed', note: 'Failed' });
});
