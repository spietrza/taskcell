import { describe, expect, it } from 'vitest';
import { boardCountLabels, boardCounts } from './counts';
import type { BoardTask } from '../../wire';

function task(column: BoardTask['column'], waiting?: boolean, asked?: boolean): BoardTask {
  return { id: 'x', title: 't', column, state: '', ...(waiting ? { waiting: true } : {}), ...(asked ? { asked: true as const } : {}) };
}

describe('boardCounts', () => {
  it('counts claimed + running as running, waiting-flagged tasks as queued, and asked cards as needs you', () => {
    const tasks: BoardTask[] = [
      task('claimed'),
      task('running'),
      task('queued', true),
      task('queued', true),
      task('verify-failed'),
      task('verify-failed', false, true),
      task('review'),
      task('done'),
    ];
    expect(boardCounts(tasks)).toEqual({ running: 2, queued: 2, needsYou: 1 });
    expect(boardCounts([task('running', true)])).toEqual({ running: 1, queued: 1, needsYou: 0 });
  });

  it('empty/undefined input yields zero counts', () => {
    expect(boardCounts(undefined)).toEqual({ running: 0, queued: 0, needsYou: 0 });
    expect(boardCounts(null)).toEqual({ running: 0, queued: 0, needsYou: 0 });
    expect(boardCounts([])).toEqual({ running: 0, queued: 0, needsYou: 0 });
  });
});

describe('boardCountLabels', () => {
  const tasks: BoardTask[] = [task('running'), task('queued', true), task('queued', true)];

  it('an uncapped list is exact; a capped one is a lower bound', () => {
    expect(boardCountLabels({ tasks, capped: false })).toEqual({ running: '1', queued: '2', needsYou: '0' });
    expect(boardCountLabels({ tasks, capped: true })).toEqual({ running: '1+', queued: '2+', needsYou: '0+' });
    expect(boardCountLabels({ tasks: [], capped: false })).toEqual({ running: '0', queued: '0', needsYou: '0' });
  });

  it('an unknown list has no labels at all — never `0`', () => {
    expect(boardCountLabels(null)).toBeNull();
    expect(boardCountLabels(undefined)).toBeNull();
  });
});
