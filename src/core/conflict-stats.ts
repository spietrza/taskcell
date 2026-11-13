import { parseJsonlLines } from './stats.js';
import { alignTable } from './table.js';

/** One `base_merge` line: the reviser checked a PR branch against its base (see persistBaseMerge). */
export interface BaseMergeEvent {
  ts: string;
  repo: string;
  pr: number;
  base: string;
  outcome: 'clean' | 'conflicted';
  conflictedFiles: string[];
  /** Conflicted merges only: the agent resolved the markers, or the conflict was left for a human. */
  resolvedBy?: 'agent' | 'human';
  /** The round addressed nothing but the merge, or also had findings. */
  round: 'merge-only' | 'mixed';
}

interface ConflictCounts {
  merges: number;
  conflicts: number;
  autoResolved: number;
  leftForHuman: number;
}

export interface ConflictWeek extends ConflictCounts {
  /** ISO date (UTC) of the Monday the week starts on. */
  week: string;
}

export interface ConflictStats {
  weeks: ConflictWeek[];
  total: ConflictCounts;
  topFiles: Array<{ file: string; conflicts: number }>;
}

const TOP_FILES = 5;

/** Parse `base_merge` lines, tolerating blank, malformed and unrelated lines. */
export function parseBaseMerges(text: string): BaseMergeEvent[] {
  const events: BaseMergeEvent[] = [];
  for (const p of parseJsonlLines(text)) {
    if (p.evt !== 'base_merge' || typeof p.ts !== 'string' || typeof p.repo !== 'string' || typeof p.pr !== 'number') continue;
    if (p.outcome !== 'clean' && p.outcome !== 'conflicted') continue;
    const files = Array.isArray(p.conflictedFiles) ? p.conflictedFiles.filter((f): f is string => typeof f === 'string') : [];
    events.push({
      ts: p.ts, repo: p.repo, pr: p.pr, base: typeof p.base === 'string' ? p.base : '',
      outcome: p.outcome, conflictedFiles: files,
      ...(p.resolvedBy === 'agent' || p.resolvedBy === 'human' ? { resolvedBy: p.resolvedBy } : {}),
      round: p.round === 'merge-only' ? 'merge-only' : 'mixed',
    });
  }
  return events;
}

/** The UTC Monday (YYYY-MM-DD) of the week `ts` falls in; '' for an unparseable timestamp. */
function weekOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Conflicts per week (total, auto-resolved, left for a human) and the most-conflicted files. */
export function aggregateConflicts(events: readonly BaseMergeEvent[]): ConflictStats {
  const weeks = new Map<string, ConflictWeek>();
  const files = new Map<string, number>();
  const total: ConflictCounts = { merges: 0, conflicts: 0, autoResolved: 0, leftForHuman: 0 };
  for (const e of events) {
    const week = weekOf(e.ts);
    const w = weeks.get(week) ?? { week, merges: 0, conflicts: 0, autoResolved: 0, leftForHuman: 0 };
    weeks.set(week, w);
    for (const t of [w, total]) t.merges += 1;
    if (e.outcome !== 'conflicted') continue;
    for (const t of [w, total]) {
      t.conflicts += 1;
      if (e.resolvedBy === 'agent') t.autoResolved += 1;
      else if (e.resolvedBy === 'human') t.leftForHuman += 1;
    }
    for (const f of new Set(e.conflictedFiles)) files.set(f, (files.get(f) ?? 0) + 1);
  }
  return {
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    total,
    topFiles: [...files.entries()].map(([file, conflicts]) => ({ file, conflicts })).sort((a, b) => b.conflicts - a.conflicts || a.file.localeCompare(b.file)).slice(0, TOP_FILES),
  };
}

/** Render the conflicts-per-week table and the top conflicted files. */
export function formatConflictStats(stats: ConflictStats): string {
  const table = alignTable([
    ['BASE MERGES (week of)', 'merges', 'conflicts', 'auto-resolved', 'left for human'],
    ...stats.weeks.map((w) => [w.week || '(unknown)', String(w.merges), String(w.conflicts), String(w.autoResolved), String(w.leftForHuman)]),
    ['TOTAL', String(stats.total.merges), String(stats.total.conflicts), String(stats.total.autoResolved), String(stats.total.leftForHuman)],
  ]);
  if (stats.topFiles.length === 0) return table;
  return [table, '', alignTable([['TOP CONFLICTED FILES', 'conflicts'], ...stats.topFiles.map((f) => [f.file, String(f.conflicts)])])].join('\n');
}
