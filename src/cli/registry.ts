/**
 * The CLI's command table: for each command its parse step (flags -> its own command shape) and, by the
 * parsed command's `kind`, how it runs. Mirrors the hub's `defineCommands`. Module members are read at
 * call time (namespace imports), so a command's module is not evaluated for another command's flags.
 */
import type { Command } from './args.js';
import { resolveForkScorerConfig } from '../runners/source-adapter.js';
import { resumeRateLimited } from '../runners/resume-rate-limited.js';
import { migrateLabels } from '../runners/migrate-labels.js';
import type { ParseCtx } from './flags.js';
import * as stats from './stats.js';
import * as approve from './approve.js';
import * as metrics from './metrics.js';
import * as lessons from './lessons.js';
import * as skills from './skills.js';
import * as audit from './audit.js';
import * as history from './history.js';
import * as memory from './memory.js';
import * as evalCmd from './eval.js';
import * as migrateLabelsCli from './migrate-labels.js';
import * as resumeRateLimitedCli from './resume-rate-limited.js';
import * as gc from './gc.js';
import * as hub from './hub-flags.js';
import * as reviewPr from './review-pr.js';
import * as research from './research.js';
import * as spec from './spec.js';
import * as revisePr from './revise-pr.js';
import * as watchPrs from './watch-prs.js';
import * as doctorPrs from './doctor-prs.js';
import * as reviewMr from './review-mr.js';
import * as watchMrs from './watch-mrs.js';
import * as run from './run.js';
import * as watch from './watch.js';
import * as doctor from './doctor.js';

export interface Parser {
  /** False for commands that never pick a provider: they skip the provider-pair validation. */
  providerChoice: boolean;
  parse(ctx: ParseCtx): Command;
}

const parser = (providerChoice: boolean, parse: (ctx: ParseCtx) => Command): Parser => ({ providerChoice, parse });

/** By command word. */
export const PARSERS: Record<string, Parser> = {
  stats: parser(false, (c) => stats.parseStatsCommand(c)),
  approve: parser(false, (c) => approve.parseApproveCommand(c)),
  metrics: parser(false, (c) => metrics.parseMetricsCommand(c)),
  lessons: parser(false, (c) => lessons.parseLessonsCommand(c)),
  skills: parser(false, (c) => skills.parseSkillsCommand(c)),
  audit: parser(false, (c) => audit.parseAuditCommand(c)),
  history: parser(false, (c) => history.parseHistoryCommand(c)),
  memory: parser(false, (c) => memory.parseMemoryCommand(c)),
  eval: parser(false, (c) => evalCmd.parseEvalCommand(c)),
  'migrate-labels': parser(false, (c) => migrateLabelsCli.parseMigrateLabelsCommand(c)),
  'resume-rate-limited': parser(false, (c) => resumeRateLimitedCli.parseResumeRateLimitedCommand(c)),
  gc: parser(false, (c) => gc.parseGcCommand(c)),
  hub: parser(false, (c) => hub.parseHubCommand(c)),
  'review-pr': parser(true, (c) => reviewPr.parseReviewPrCommand(c)),
  research: parser(true, (c) => research.parseResearchCommand(c)),
  spec: parser(true, (c) => spec.parseSpecCommand(c)),
  'revise-pr': parser(true, (c) => revisePr.parseRevisePrCommand(c)),
  'watch-prs': parser(true, (c) => watchPrs.parseWatchPrsCommand(c)),
  'doctor-prs': parser(true, (c) => doctorPrs.parseDoctorPrsCommand(c)),
  'review-mr': parser(true, (c) => reviewMr.parseReviewMrCommand(c)),
  'watch-mrs': parser(true, (c) => watchMrs.parseWatchMrsCommand(c)),
  'doctor-mrs': parser(true, (c) => watchMrs.parseWatchMrsCommand(c)),
  run: parser(true, (c) => run.parseRunCommand(c)),
  watch: parser(true, (c) => watch.parseWatchCommand(c)),
  doctor: parser(true, (c) => watch.parseWatchCommand(c)),
};

type Runner = (command: Command) => Promise<void>;

/** A runner for one command kind; the parsed command is narrowed to that kind. */
function runner<K extends Command['kind']>(fn: (command: Extract<Command, { kind: K }>) => Promise<void>): Runner {
  return (command) => fn(command as Extract<Command, { kind: K }>);
}

/** By the parsed command's `kind`. A kind absent here (gc) is the fallthrough in index.ts. */
export const RUNNERS: Partial<Record<Command['kind'], Runner>> = {
  hub: runner<'hub'>(async (c) => {
    const { hubCommand } = await import('./hub.js');
    await hubCommand(c);
  }),
  'hub-rotate-token': runner<'hub-rotate-token'>(async (c) => {
    const { hubRotateTokenCommand } = await import('./hub.js');
    await hubRotateTokenCommand(c);
  }),
  run: runner<'run'>(async (c) => {
    // Validate decision-model credentials/consent ONCE, before the tracker fetch, sidecars and sandbox
    // (a `run --parent` fan-out would otherwise fail every child the same way).
    if (c.forkScorer === 'decision') resolveForkScorerConfig(c.commitAuthor !== undefined);
    await run.runCommand(c);
  }),
  watch: runner<'watch'>((c) => watch.watchCommand(c)),
  doctor: runner<'doctor'>((c) => doctor.doctorCommand(c)),
  'doctor-prs': runner<'doctor-prs'>((c) => doctorPrs.doctorPrsCommand(c)),
  'review-pr': runner<'review-pr'>((c) => reviewPr.reviewPrCommand(c)),
  research: runner<'research'>((c) => research.researchCommand(c)),
  spec: runner<'spec'>((c) => spec.specCommand(c)),
  'revise-pr': runner<'revise-pr'>((c) => revisePr.revisePrCommand(c)),
  'migrate-labels': runner<'migrate-labels'>(async (c) => {
    const report = await migrateLabels({ repoSlug: c.repoSlug, apply: c.apply });
    console.log(`migrate-labels: ${report.renamed.length} ${report.dryRun ? 'to rename (dry-run; pass --apply)' : 'renamed'}, ${report.skipped.length} skipped, ${report.failed.length} failed`);
    if (report.failed.length > 0) process.exitCode = 1;
  }),
  'resume-rate-limited': runner<'resume-rate-limited'>(async (c) => {
    const report = await resumeRateLimited({ repoSlug: c.repoSlug, dryRun: c.dryRun, ...(c.ciWatch === false ? { ciWatch: false } : {}), ...(c.triggerLabels !== undefined ? { triggerLabels: c.triggerLabels } : {}), ...(c.dependencyRepos !== undefined ? { dependencyRepos: c.dependencyRepos } : {}), ...(c.startedLabels !== undefined ? { startedLabels: c.startedLabels } : {}) });
    console.log(`resume-rate-limited: ${report.resumed.length} resumed, ${report.waiting.length} waiting, ${report.skipped.length} skipped, ${report.failed.length} failed, ${report.ciFailed.length} ci-failed`);
    if (report.failed.length > 0) process.exitCode = 1;
  }),
  'watch-prs': runner<'watch-prs'>((c) => watchPrs.watchPrsCommand(c)),
  'review-mr': runner<'review-mr'>((c) => reviewMr.reviewMrCommand(c)),
  'watch-mrs': runner<'watch-mrs'>((c) => watchMrs.watchMrsCommand(c)),
  'doctor-mrs': runner<'doctor-mrs'>(async (c) => (await import('./doctor-mrs.js')).doctorMrsCommand(c)),
  eval: runner<'eval'>((c) => evalCmd.evalCommand(c)),
  metrics: runner<'metrics'>((c) => metrics.metricsCommand(c)),
  approve: runner<'approve'>((c) => approve.approveCommand(c)),
  stats: runner<'stats'>((c) => stats.statsCommand(c)),
  lessons: runner<'lessons'>((c) => lessons.lessonsCommand(c)),
  skills: runner<'skills'>(async (c) => {
    process.exitCode = await skills.skillsCommand(c);
  }),
  audit: runner<'audit'>(async (c) => {
    process.exitCode = await audit.auditCommand(c);
  }),
  history: runner<'history'>((c) => history.historyCommand(c)),
  memory: runner<'memory'>((c) => memory.memoryCommand(c)),
  sidecar: runner<'sidecar'>(async () => {
    // The JSON protocol owns stdout. Route everything else to stderr so a stray log line can't
    // corrupt the stream the desktop parses: pino via TASKCELL_SIDECAR (see logger.ts), and the
    // runner's console.log/info (e.g. summarizeOutcomes, gate messages) redirected here.
    process.env.TASKCELL_SIDECAR = '1';
    console.log = (...args: unknown[]): void => console.error(...args);
    console.info = (...args: unknown[]): void => console.error(...args);
    const { runSidecar } = await import('../sidecar/sidecar.js');
    const { productionDeps } = await import('../sidecar/deps.js');
    const { installCancelHandler } = await import('../sidecar/cancel.js');
    const { createInterface } = await import('node:readline');
    installCancelHandler();
    const rl = createInterface({ input: process.stdin });
    await runSidecar(rl, (l: string) => void process.stdout.write(l + '\n'), productionDeps());
  }),
  complete: runner<'complete'>(async () => {
    // Same stdout discipline as the sidecar: the single JSON response line owns stdout, so a stray
    // log can't corrupt it. Set the gate BEFORE importing the SDK.
    process.env.TASKCELL_SIDECAR = '1';
    console.log = (...args: unknown[]): void => console.error(...args);
    console.info = (...args: unknown[]): void => console.error(...args);
    console.debug = (...args: unknown[]): void => console.error(...args);
    const [{ runComplete }, { query }, { createInterface: mkRl }] = await Promise.all([
      import('../api/complete.js'),
      import('@anthropic-ai/claude-agent-sdk'),
      import('node:readline'),
    ]);
    const rlc = mkRl({ input: process.stdin });
    const input = await new Promise<string>((resolve) => {
      rlc.once('line', (l: string) => {
        rlc.close();
        resolve(l);
      });
    });
    let req: unknown;
    try {
      req = JSON.parse(input);
    } catch {
      process.stdout.write(JSON.stringify({ error: { message: 'invalid request JSON' } }) + '\n');
      return;
    }
    const res = await runComplete(req, {
      query: (params) => query(params as Parameters<typeof query>[0]),
    });
    process.stdout.write(JSON.stringify(res) + '\n');
  }),
};
