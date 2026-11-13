import { describe, expect, it } from 'vitest';
import { aggregateConflicts, formatConflictStats, parseBaseMerges } from './conflict-stats.js';

const line = (o: Record<string, unknown>): string => JSON.stringify({ evt: 'base_merge', repo: 'o/r', pr: 1, base: 'main', round: 'mixed', ...o });

describe('conflict stats', () => {
  const text = [
    line({ ts: '2026-11-10T10:00:00Z', outcome: 'conflicted', conflictedFiles: ['a.ts', 'b.ts'], resolvedBy: 'agent' }),
    line({ ts: '2026-11-12T10:00:00Z', outcome: 'conflicted', conflictedFiles: ['a.ts'], resolvedBy: 'human' }),
    line({ ts: '2026-11-12T11:00:00Z', outcome: 'clean', conflictedFiles: [], round: 'merge-only' }),
    line({ ts: '2026-11-03T11:00:00Z', outcome: 'clean', conflictedFiles: [] }),
    JSON.stringify({ evt: 'run_complete', taskId: 't' }),
    'not json',
  ].join('\n');

  it('does not count a conflict with no recorded resolution as left for a human', () => {
    const stats = aggregateConflicts(parseBaseMerges(line({ ts: '2026-11-10T10:00:00Z', outcome: 'conflicted', conflictedFiles: ['a.ts'] })));
    expect(stats.total).toEqual({ merges: 1, conflicts: 1, autoResolved: 0, leftForHuman: 0 });
  });

  it('parses only base_merge lines', () => {
    expect(parseBaseMerges(text)).toHaveLength(4);
  });

  it('rolls up per UTC week, with totals and top files', () => {
    const stats = aggregateConflicts(parseBaseMerges(text));
    expect(stats.weeks).toEqual([
      { week: '2026-11-02', merges: 1, conflicts: 0, autoResolved: 0, leftForHuman: 0 },
      { week: '2026-11-09', merges: 3, conflicts: 2, autoResolved: 1, leftForHuman: 1 },
    ]);
    expect(stats.total).toEqual({ merges: 4, conflicts: 2, autoResolved: 1, leftForHuman: 1 });
    expect(stats.topFiles).toEqual([{ file: 'a.ts', conflicts: 2 }, { file: 'b.ts', conflicts: 1 }]);
    expect(formatConflictStats(stats)).toContain('TOP CONFLICTED FILES');
  });
});
