import { parseFeedbackAuthors, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMetrics, parseProbes, aggregateMetrics, formatStats, modelPickReport, formatModelPicks } from '../core/stats.js';
import { parseBaseMerges, aggregateConflicts, formatConflictStats } from '../core/conflict-stats.js';
import { readBranchFile, readBranchMetrics, METRICS_BRANCH_DEFAULT } from '../core/metrics-branch.js';
import { DECISIONS_FILE } from '../approver/ledger.js';
import { parseDecisions, formatApproverScorecard } from '../approver/scorecard.js';
import { collectApproverScorecard } from '../approver/outcome.js';
import { defaultGhRunner } from '../tasks/github.js';
import { leadTimeRollupForPrUrls, memoizePrView } from '../core/lead-time-github.js';
import { aggregateLessons, fetchFirstPass, formatLessonsStats } from '../core/lessons-stats.js';
import { formatLeadTime } from '../core/lead-time.js';
import { aggregateSkills, formatSkillStats, parseSince, withinWindow } from '../core/skill-stats.js';
import type { Command } from './args.js';
import { stateDir } from '../core/state-path.js';

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
 * Read metrics.jsonl — the local .taskcell/runs copy, or with --branch the durable copy `metrics push`
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
    const file = join(stateDir(cmd.repoPath), 'runs', 'metrics.jsonl');
    try {
      text = await readFile(file, 'utf8');
    } catch {
      console.log(`No metrics found at ${file} — run a task first.`);
      return;
    }
  }
  const records = parseMetrics(text);
  if (cmd.skills) {
    const windowMs = cmd.since !== undefined ? parseSince(cmd.since) : undefined;
    const rows = aggregateSkills(withinWindow(records, windowMs));
    console.log(cmd.json ? JSON.stringify(rows, null, 2) : formatSkillStats(rows));
    return;
  }
  const report = aggregateMetrics(records, parseProbes(text));
  const prUrls = records.flatMap((r) => (r.prUrl !== undefined ? [r.prUrl] : []));
  const gh = memoizePrView(defaultGhRunner);
  const leadTime = cmd.githubRepo !== undefined ? await leadTimeRollupForPrUrls(cmd.githubRepo, prUrls, {}, gh) : undefined;
  const firstPass = cmd.githubRepo !== undefined ? await fetchFirstPass(cmd.githubRepo, prUrls, gh, cmd.feedbackAuthors) : undefined;
  const lessons = aggregateLessons(records, firstPass?.firstPass, firstPass?.failed);
  const merges = parseBaseMerges(text);
  const conflicts = merges.length > 0 ? aggregateConflicts(merges) : undefined;
  if (cmd.json) {
    console.log(JSON.stringify({ ...report, modelPicks: modelPickReport(text), lessons, ...(leadTime !== undefined ? { leadTime } : {}), ...(conflicts !== undefined ? { conflicts } : {}) }, null, 2));
    return;
  }
  if (records.length === 0) {
    // Base merges can exist before any run completed: show them alone.
    console.log(conflicts !== undefined ? formatConflictStats(conflicts) : 'No run_complete metrics yet.');
    return;
  }
  console.log(formatStats(report));
  const picks = formatModelPicks(modelPickReport(text));
  if (picks !== '') console.log(`\n${picks}`);
  console.log(`\n${formatLessonsStats(lessons)}`);
  if (conflicts !== undefined) console.log(`\n${formatConflictStats(conflicts)}`);
  if (leadTime !== undefined) console.log(`\n${formatLeadTime(leadTime)}`);
}

/** Parse `stats`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseStatsCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const statsRepo = values['github-repo'];
  // The slug lands in a `gh api repos/<slug>/...` path, so `..` segments or extra slashes are refused.
  if (typeof statsRepo === 'string' && (!/^[\w.-]+\/[\w.-]+$/.test(statsRepo) || statsRepo.split('/').some((p) => p === '.' || p === '..'))) {
    return fail(`stats --github-repo must be owner/repo, got '${statsRepo}'.`);
  }
  const statsFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  if (values.skills === true && positionals.length > 1) return fail('stats --skills takes no value.');
  if (values.skills === true && (values.approver === true || statsRepo !== undefined || statsFeedbackAuthors !== undefined)) {
    return fail('stats --skills cannot be combined with --approver, --github-repo or --feedback-authors.');
  }
  if (values.skills === true && typeof values.since === 'string' && parseSince(values.since) === undefined) {
    return fail(`stats --since must look like 30d or 12h, got '${values.since}'.`);
  }
  return {
    kind: 'stats',
    repoPath,
    json: values.json === true,
    approver: values.approver === true,
    ...(values.skills === true ? { skills: true } : {}),
    // Without --skills, --since is accepted and ignored, as it always was on stats.
    ...(values.skills === true && typeof values.since === 'string' ? { since: values.since } : {}),
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    ...(typeof values['github-repo'] === 'string' ? { githubRepo: values['github-repo'] } : {}),
    ...(statsFeedbackAuthors !== undefined ? { feedbackAuthors: statsFeedbackAuthors } : {}),
  };
}
