import { describe, expect, test } from 'vitest';
import { diffStat, stationNote, stationState } from './stationNotes';
import { stageLine } from './stageLine';
import type { RunDetail } from '../../wire';

const detail: RunDetail = {
  taskId: 'gh-1',
  timestamp: 't',
  proof: { passed: true } as never,
  stages: [
    { record: { stage: 'implementer', model: 'sonnet', durationMs: 75000 } as never },
    { record: { stage: 'reviewer', model: 'codex', verdict: 'pass', durationMs: 30000 } as never },
  ],
};

describe('stationNote', () => {
  test('done stations say what the record shows; the PR its number', () => {
    const notes = stageLine({ column: 'done' }).map((s) => stationNote(s, { task: { column: 'done' }, detail, prUrl: 'https://github.com/o/r/pull/9' }));
    expect(notes).toEqual(['picked up', '', 'sonnet · 1m 15s', 'tests passed', 'passed · codex · 30s', 'merged · #9']);
  });

  test('waiting stations say what the Line config will do; nothing before it loads', () => {
    const cfg = { verifyCmd: 'pnpm verify', provider: 'claude' };
    const steps = stageLine({ column: 'queued' });
    expect(stationNote(steps[3]!, { task: { column: 'queued' }, cfg })).toBe('pnpm verify · secret scan');
    expect(stationNote(steps[3]!, { task: { column: 'queued' } })).toBe('');
    expect(stationNote(steps[0]!, { task: { column: 'queued', waiting: true }, cfg })).toBe('waiting for a cell');
  });

  test('a running card never reads an older run record', () => {
    const steps = stageLine({ column: 'running', stage: 'reviewer' });
    expect(stationNote(steps[2]!, { task: { column: 'running', stage: 'reviewer' }, detail })).toBe('');
    expect(stationState(steps[4]!, 'running')).toBe('running');
    expect(stationState(stageLine({ column: 'queued' })[0]!, 'queued')).toBe('waiting');
  });
});

test('diffStat counts files and lines, not headers', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@', '-old', '+new', '+more', 'diff --git a/y b/y', '+++ b/y', '+y'].join('\n');
  expect(diffStat(diff)).toBe('2 files · +3 −1');
  expect(diffStat(undefined)).toBeUndefined();
});
