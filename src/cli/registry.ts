/**
 * How each parsed command runs, by its `kind`: a full map, so a new command kind without a runner is a type
 * error. Only the CLI entry (index.ts) imports this module; the parse step (parsers.ts) never reaches a runner.
 * Module members are read at call time (namespace imports), so a command's module is not evaluated for
 * another command's run.
 */
import type { Command } from './args.js';
import { resolveForkScorerConfig } from '../runners/source-adapter.js';
import { resumeRateLimited } from '../runners/resume-rate-limited.js';
import { migrateLabels } from '../runners/migrate-labels.js';
import * as stats from './stats.js';
import * as approve from './approve.js';
import * as metrics from './metrics.js';
import * as lessons from './lessons.js';
import * as skills from './skills.js';
import * as audit from './audit.js';
import * as history from './history.js';
import * as memory from './memory.js';
import * as evalCmd from './eval.js';
import * as gc from './gc.js';
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

/** Every kind parseCli returns that runs something (help and error are answered by the entry itself). */
export type RunnableKind = Exclude<Command['kind'], 'help' | 'error'>;
/** The parsed command of each runnable kind. */
export type RunnableCommand = { [K in RunnableKind]: Extract<Command, { kind: K }> };

/** By the parsed command's `kind`. */
export const RUNNERS: { readonly [K in RunnableKind]: (command: RunnableCommand[K]) => Promise<void> } = {
  hub: async (c) => {
    const { hubCommand } = await import('./hub.js');
    await hubCommand(c);
  },
  'hub-rotate-token': async (c) => {
    const { hubRotateTokenCommand } = await import('./hub.js');
    await hubRotateTokenCommand(c);
  },
  run: async (c) => {
    // Validate decision-model credentials/consent ONCE, before the tracker fetch, sidecars and sandbox
    // (a `run --parent` fan-out would otherwise fail every child the same way).
    if (c.forkScorer === 'decision') resolveForkScorerConfig(c.commitAuthor !== undefined);
    await run.runCommand(c);
  },
  watch: (c) => watch.watchCommand(c),
  doctor: (c) => doctor.doctorCommand(c),
  'doctor-prs': (c) => doctorPrs.doctorPrsCommand(c),
  'review-pr': (c) => reviewPr.reviewPrCommand(c),
  research: (c) => research.researchCommand(c),
  spec: (c) => spec.specCommand(c),
  'revise-pr': (c) => revisePr.revisePrCommand(c),
  'migrate-labels': async (c) => {
    const report = await migrateLabels({ repoSlug: c.repoSlug, apply: c.apply });
    console.log(`migrate-labels: ${report.renamed.length} ${report.dryRun ? 'to rename (dry-run; pass --apply)' : 'renamed'}, ${report.skipped.length} skipped, ${report.failed.length} failed`);
    if (report.failed.length > 0) process.exitCode = 1;
  },
  'resume-rate-limited': async (c) => {
    const report = await resumeRateLimited({ repoSlug: c.repoSlug, dryRun: c.dryRun, ...(c.ciWatch === false ? { ciWatch: false } : {}), ...(c.triggerLabels !== undefined ? { triggerLabels: c.triggerLabels } : {}), ...(c.dependencyRepos !== undefined ? { dependencyRepos: c.dependencyRepos } : {}), ...(c.startedLabels !== undefined ? { startedLabels: c.startedLabels } : {}) });
    console.log(`resume-rate-limited: ${report.resumed.length} resumed, ${report.waiting.length} waiting, ${report.skipped.length} skipped, ${report.failed.length} failed, ${report.ciFailed.length} ci-failed`);
    if (report.failed.length > 0) process.exitCode = 1;
  },
  'watch-prs': (c) => watchPrs.watchPrsCommand(c),
  'review-mr': (c) => reviewMr.reviewMrCommand(c),
  'watch-mrs': (c) => watchMrs.watchMrsCommand(c),
  'doctor-mrs': async (c) => (await import('./doctor-mrs.js')).doctorMrsCommand(c),
  eval: (c) => evalCmd.evalCommand(c),
  metrics: (c) => metrics.metricsCommand(c),
  approve: (c) => approve.approveCommand(c),
  stats: (c) => stats.statsCommand(c),
  lessons: (c) => lessons.lessonsCommand(c),
  skills: async (c) => {
    process.exitCode = await skills.skillsCommand(c);
  },
  audit: async (c) => {
    process.exitCode = await audit.auditCommand(c);
  },
  history: (c) => history.historyCommand(c),
  memory: (c) => memory.memoryCommand(c),
  gc: async (c) => {
    const report = await gc.runGc(c);
    const tag = c.dryRun ? ' (dry-run)' : '';
    const remote = c.remoteRepo !== undefined ? `, ${report.branches.length} merged remote branch(es)` : '';
    console.log(`Reaped ${report.containers.length} container(s), ${report.networks.length} egress network(s)${remote}${tag}.`);
    if (report.containers.length > 0) console.log(`  containers: ${report.containers.join(', ')}`);
    if (report.networks.length > 0) console.log(`  networks: ${report.networks.join(', ')}`);
    if (report.branches.length > 0) console.log(`  branches: ${report.branches.join(', ')}`);
  },
  sidecar: async () => {
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
  },
  complete: async () => {
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
  },
};

/** Run a parsed command on its kind's runner (the kind and the command are passed together so they stay paired). */
export function dispatch<K extends RunnableKind>(kind: K, command: RunnableCommand[K]): Promise<void> {
  return RUNNERS[kind](command);
}
