import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMetrics, parseProbes, aggregateMetrics, formatStats } from '../core/stats.js';
import { readBranchFile, readBranchMetrics, METRICS_BRANCH_DEFAULT } from '../core/metrics-branch.js';
import { DECISIONS_FILE } from '../approver/ledger.js';
import { parseDecisions, formatApproverScorecard } from '../approver/scorecard.js';
import { collectApproverScorecard } from '../approver/outcome.js';
import { leadTimeRollupForPrUrls } from '../core/lead-time-github.js';
import { formatLeadTime } from '../core/lead-time.js';
import type { Command } from './args.js';

type StatsCommand = Extract<Command, { kind: 'stats' }>;

/**
 * `--approver`: read decisions.jsonl from the metrics branch, fetch each factory PR's outcome and the
 * repo's revert history from GitHub, and print the shadow-verdict-vs-human scorecard per risk class.
 */
async function approverScorecardCommand(cmd: StatsCommand): Promise<void> {
  const text = await readBranchFile(cmd.repoPath, { file: DECISIONS_FILE, ...(cmd.branch !== undefined ? { branch: cmd.branch } : {}) });
  const decisions = parseDecisions(text);
  if (decisions.length === 0) {
    console.log(`No approver decisions on branch ${cmd.branch ?? METRICS_BRANCH_DEFAULT} — has \`taskcell approve\` run yet?`);
    return;
  }
  const report = await collectApproverScorecard(decisions);
  if (cmd.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatApproverScorecard(report));
}

/**
 * Read metrics.jsonl — the local .vanguard/runs copy, or with --branch the durable copy `metrics push`
 * keeps on the metrics branch — and print an aggregated cost/token/time rollup. `--approver` prints the
 * shadow approver scorecard instead.
 */
export async function statsCommand(cmd: StatsCommand): Promise<void> {
  if (cmd.approver) {
    await approverScorecardCommand(cmd);
    return;
  }
  let text: string;
  if (cmd.branch !== undefined) {
    text = await readBranchMetrics(cmd.repoPath, { branch: cmd.branch });
    if (text === '') {
      console.log(`No metrics on branch ${cmd.branch} — has \`taskcell metrics push\` run yet?`);
      return;
    }
  } else {
    const file = join(cmd.repoPath, '.vanguard', 'runs', 'metrics.jsonl');
    try {
      text = await readFile(file, 'utf8');
    } catch {
      console.log(`No metrics found at ${file} — run a task first.`);
      return;
    }
  }
  const records = parseMetrics(text);
  const report = aggregateMetrics(records, parseProbes(text));
  const leadTime =
    cmd.githubRepo !== undefined
      ? await leadTimeRollupForPrUrls(cmd.githubRepo, records.flatMap((r) => (r.prUrl !== undefined ? [r.prUrl] : [])))
      : undefined;
  if (cmd.json) {
    console.log(JSON.stringify(leadTime !== undefined ? { ...report, leadTime } : report, null, 2));
    return;
  }
  if (records.length === 0) {
    console.log('No run_complete metrics yet.');
    return;
  }
  console.log(formatStats(report));
  if (leadTime !== undefined) console.log(`\n${formatLeadTime(leadTime)}`);
}
