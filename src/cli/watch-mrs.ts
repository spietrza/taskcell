import { DEFAULT_CONCURRENCY, DEFAULT_GITLAB_MR_REVIEWING_LABEL, DEFAULT_GITLAB_MR_REVIEWED_LABEL } from './flags.js';
import type { ParseCtx } from './flags.js';
import { gitlabMergeRequestWatchPrimitives, watchMergeRequests } from '../runners/mr-watch.js';
import { reviewMrCommand } from './review-mr.js';
import { formatPreflightReport, preflightFailed, runPreflight } from './preflight.js';
import type { Command } from './args.js';
import type { MergeRequestWatchPrimitives, MergeRequestWatchTick, WatchMergeRequestsLoopOptions } from '../runners/mr-watch.js';

type WatchMrsCommand = Extract<Command, { kind: 'watch-mrs' }>;
type ReviewMrCommand = Extract<Command, { kind: 'review-mr' }>;

export type ReviewMrCommandRunner = (cmd: ReviewMrCommand) => Promise<void>;
export type WatchMergeRequestsRunner = (
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions,
) => Promise<MergeRequestWatchTick | undefined>;

export interface WatchMrsCommandDeps {
  reviewMr?: ReviewMrCommandRunner;
  watchMergeRequests?: WatchMergeRequestsRunner;
  log?: (line: string) => void;
}

/** Poll GitLab MRs by label and run Taskcell's non-blocking review on each claimed MR. */
export async function watchMrsCommand(cmd: WatchMrsCommand, deps: WatchMrsCommandDeps = {}): Promise<void> {
  const report = await runPreflight(cmd);
  for (const line of formatPreflightReport(report)) console.log(line);
  if (!report.ok) throw preflightFailed();

  const log = deps.log ?? console.log;
  const runReviewMr = deps.reviewMr ?? ((reviewCmd: ReviewMrCommand) => reviewMrCommand(reviewCmd, { headDedupe: false }));
  const runWatchMrs = deps.watchMergeRequests ?? watchMergeRequests;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const primitives = gitlabMergeRequestWatchPrimitives({
    project: cmd.project,
    label: cmd.label,
    reviewingLabel: cmd.reviewingLabel,
    reviewedLabel: cmd.reviewedLabel,
    ...(cmd.author !== undefined ? { author: cmd.author } : {}),
    log,
    reviewOne: (item) =>
      runReviewMr({
        kind: 'review-mr',
        iid: item.iid,
        project: item.project,
        repoPath: cmd.repoPath,
        egress: cmd.egress,
        ...(cmd.llmProxy === true ? { llmProxy: true } : {}),
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
        ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
        ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
      }),
  });

  log(`watch-mrs[gitlab]: polling every ${cmd.intervalMs / 1000}s for MRs labeled "${cmd.label}". Ctrl-C to stop.`);
  try {
    const tick = await runWatchMrs(primitives, {
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal: controller.signal,
      log,
    });
    // --once is the CI mode: a failed listing or review must fail the step, as in watch-prs.
    if (cmd.once && tick !== undefined && tick.failed.length > 0) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** Parse `watch-mrs` and `doctor-mrs`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseWatchMrsCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, builtinProvider, maxTurns } = ctx;
  const commandKind = positionals[0];
  const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (project === undefined || label === undefined) return { kind: 'help' };
  const concurrency = Number(values.concurrency);
  const interval = Number(values.interval);
  const shared = {
    project,
    repoPath,
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_GITLAB_MR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_GITLAB_MR_REVIEWED_LABEL,
    ...(typeof values.author === 'string' ? { author: values.author } : {}),
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
  };
  if (commandKind === 'doctor-mrs') return { kind: 'doctor-mrs', ...shared };
  return {
    kind: 'watch-mrs',
    ...shared,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    once: values.once === true,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
