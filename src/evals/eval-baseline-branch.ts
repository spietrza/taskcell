import { execa } from 'execa';
import { appendBranchLines, readBranchFile } from '../core/metrics-branch.js';
import { parseJsonlLines } from '../core/stats.js';
import type { EvalRunReport } from './types.js';

/**
 * Baselines live on the same orphan `taskcell-metrics` branch as run metrics and approver decisions
 * (metrics-branch.ts), in their own file so the three never conflict. One record per main commit;
 * `--baseline main` reads the most recently pushed one.
 */
export const EVAL_BASELINES_FILE = 'eval-baselines.jsonl';

export interface EvalBaselineRecord {
  commit: string;
  timestamp: string;
  report: EvalRunReport;
}

export interface EvalBaselineBranchOptions {
  branch?: string;
  remote?: string;
}

/** The commit `--save-baseline` keys its record on, when the caller does not pass one explicitly. */
export async function currentCommit(repoPath: string): Promise<string> {
  const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
  return result.stdout.trim();
}

const baselineKey = (record: Record<string, unknown>): string | undefined =>
  typeof record.commit === 'string' && record.commit !== '' ? record.commit : undefined;

/** Append one eval-baseline record (keyed by commit) to the metrics branch. A re-run for the same commit is a no-op. */
export async function saveEvalBaseline(
  repoPath: string,
  report: EvalRunReport,
  opts: EvalBaselineBranchOptions & { commit?: string; timestamp?: string } = {},
): Promise<EvalBaselineRecord> {
  const commit = opts.commit ?? (await currentCommit(repoPath));
  const record: EvalBaselineRecord = { commit, timestamp: opts.timestamp ?? new Date().toISOString(), report };
  await appendBranchLines(repoPath, [JSON.stringify(record)], {
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    ...(opts.remote !== undefined ? { remote: opts.remote } : {}),
    file: EVAL_BASELINES_FILE,
    key: baselineKey,
  });
  return record;
}

/** The most recently pushed eval-baseline report on the metrics branch, or undefined when none exists yet. */
export async function readLatestEvalBaseline(
  repoPath: string,
  opts: EvalBaselineBranchOptions = {},
): Promise<EvalRunReport | undefined> {
  const text = await readBranchFile(repoPath, { ...opts, file: EVAL_BASELINES_FILE });
  const records = parseJsonlLines(text);
  const last = records[records.length - 1];
  return last !== undefined ? (last as unknown as EvalBaselineRecord).report : undefined;
}
