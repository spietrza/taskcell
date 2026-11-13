// A project's CI factory runs, read from its metrics branch (`taskcell metrics push`; the data
// `taskcell stats --branch` reads). Cached per repository; never a model call.
import { readBranchMetrics, METRICS_BRANCH_DEFAULT } from '../core/metrics-branch.js';
import { aggregateMetrics, modelKey, parseJsonlLines, parseMetrics, type Bucket, type MetricRecord } from '../core/stats.js';
import type { CostBreakdown, CostPeriod, CostRow, RunSummary } from '../wire.js';

/** A `git fetch` per Home/Runs refresh would be slow: the branch is re-read at most this often. */
const TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const NO_BRANCH_HINT = 'Run `taskcell metrics push` from your CI workflow (it writes the taskcell-metrics branch) and CI runs will show up here.';

interface CiRecord {
  record: MetricRecord;
  /** The line carried a numeric `costUsd` (the parsed record reads a missing one as 0). */
  costKnown: boolean;
  costKind?: 'estimated' | 'billed';
}

const cache = new Map<string, { at: number; read: Promise<CiRecord[] | undefined> }>();

export function clearCiMetricsCache(): void {
  cache.clear();
}

function parseCiRecords(text: string): CiRecord[] {
  return parseJsonlLines(text).flatMap((line) => {
    const [record] = parseMetrics(JSON.stringify(line));
    if (record === undefined) return [];
    return [{
      record,
      costKnown: typeof line.costUsd === 'number' && Number.isFinite(line.costUsd),
      ...(line.costKind === 'billed' || line.costKind === 'estimated' ? { costKind: line.costKind } : {}),
    }];
  });
}

/** The branch's run_complete records; undefined when the repo has no metrics branch (or it holds none). */
export async function readCiRecords(repoPath: string, now: number = Date.now()): Promise<CiRecord[] | undefined> {
  const hit = cache.get(repoPath);
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.read;
  const read = readBranchMetrics(repoPath).then(
    (text) => (text === '' ? undefined : parseCiRecords(text)),
    () => undefined,
  );
  cache.set(repoPath, { at: now, read });
  return read;
}

/** One summary per task on the branch; its cost is unknown when no record of it carries one. */
export function ciRunSummaries(records: ReadonlyArray<CiRecord>): RunSummary[] {
  const byTask = new Map<string, CiRecord[]>();
  for (const r of records) {
    const group = byTask.get(r.record.taskId);
    if (group === undefined) byTask.set(r.record.taskId, [r]);
    else group.push(r);
  }
  return [...byTask.entries()].map(([taskId, rs]) => {
    const stamps = rs.flatMap((r) => (r.record.ts !== undefined ? [r.record.ts] : [])).sort();
    const prUrl = rs.find((r) => r.record.prUrl !== undefined)?.record.prUrl;
    const known = rs.some((r) => r.costKnown);
    return {
      taskId,
      timestamp: stamps[stamps.length - 1] ?? new Date(0).toISOString(),
      stages: [...new Set(rs.flatMap((r) => (r.record.stage !== undefined ? [r.record.stage] : [])))],
      totalCostUsd: rs.reduce((n, r) => n + r.record.costUsd, 0),
      anyFailed: rs.some((r) => r.record.exitReason !== undefined && r.record.exitReason !== 'completed'),
      ...(prUrl !== undefined ? { prUrl } : {}),
      source: 'ci' as const,
      ...(known ? {} : { costUnknown: true as const }),
    };
  });
}

/**
 * The repo's local run summaries plus the CI runs only the metrics branch knows. A task present in
 * both is the local record (the same run is never counted twice).
 */
export async function withCiRuns(repoPath: string, local: RunSummary[]): Promise<RunSummary[]> {
  const records = await readCiRecords(repoPath);
  if (records === undefined) return local;
  const localTasks = new Set(local.map((r) => r.taskId));
  const ci = ciRunSummaries(records).filter((r) => !localTasks.has(r.taskId));
  return ci.length === 0 ? local : [...local, ...ci].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

const rows = (report: Array<{ key: string } & Bucket>, unknown: Map<string, number>): CostRow[] =>
  report.map((b) => ({ key: b.key, entries: b.entries, costUsd: b.costUsd, unknownEntries: unknown.get(b.key) ?? 0 }));

/** The cost breakdown by model and stage for a period; the rows are `taskcell stats --branch`'s buckets. */
export async function costBreakdown(repoPath: string, period: CostPeriod, now: number = Date.now()): Promise<CostBreakdown> {
  const all = await readCiRecords(repoPath, now);
  const base = { branch: METRICS_BRANCH_DEFAULT, period };
  if (all === undefined) {
    return { ...base, status: 'no-branch', hint: NO_BRANCH_HINT, costKind: 'unknown', runs: 0, totalCostUsd: 0, unknownEntries: 0, byModel: [], byStage: [] };
  }
  const since = period === 'all' ? undefined : now - (period === '7d' ? 7 : 30) * DAY_MS;
  // A record without a timestamp cannot be placed in a window: it counts only under "all".
  const inPeriod = since === undefined ? all : all.filter((r) => r.record.ts !== undefined && Date.parse(r.record.ts) >= since);
  const report = aggregateMetrics(inPeriod.map((r) => r.record));
  const unknownBy = (key: (r: MetricRecord) => string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of inPeriod) {
      if (r.costKnown) continue;
      const k = key(r.record);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const costed = inPeriod.filter((r) => r.costKnown);
  const kinds = new Set(costed.map((r) => r.costKind ?? 'estimated'));
  const costKind = costed.length === 0 ? 'unknown' : kinds.size > 1 ? 'mixed' : kinds.has('billed') ? 'billed' : 'estimated';
  return {
    ...base,
    status: 'ok',
    costKind,
    runs: report.byTask.length,
    totalCostUsd: report.total.costUsd,
    unknownEntries: inPeriod.length - costed.length,
    byModel: rows(report.byModel, unknownBy(modelKey)),
    byStage: rows(report.byStage, unknownBy((r) => r.stage ?? '(none)')),
  };
}
