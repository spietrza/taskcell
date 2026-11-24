import { parseFeedbackAuthors, DEFAULT_CONCURRENCY, DEFAULT_PR_REVIEWING_LABEL, DEFAULT_PR_REVIEWED_LABEL, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { readFileSync } from 'node:fs';
import { sameLabel } from '../core/labels.js';
import { githubPullRequestWatchPrimitives, passWithPinnedRetry, watchPullRequests } from '../runners/pr-watch.js';
import { reviewPrCommand } from './review-pr.js';
import type { Command } from './args.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestWatchPrimitives, PullRequestWatchTick, WatchPullRequestsLoopOptions } from '../runners/pr-watch.js';

type WatchPrsCommand = Extract<Command, { kind: 'watch-prs' }>;
type ReviewPrCommand = Extract<Command, { kind: 'review-pr' }>;

export type ReviewPrCommandRunner = (cmd: ReviewPrCommand) => Promise<void>;
export type WatchPullRequestsRunner = (
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsLoopOptions,
) => Promise<PullRequestWatchTick | undefined>;

interface PullRequestEventPayload {
  action?: string;
  label?: { name?: string };
  pull_request?: { number?: number };
}

/** A caller labels a just-opened or just-readied factory PR in an earlier job, then reviews it here. */
const READY_ACTIONS = new Set(['opened', 'ready_for_review']);

/**
 * PR number from the Actions event that triggered this run. The label-filtered scan is search-backed
 * and eventually consistent — a PR labeled seconds before the run can be invisible to it, turning the
 * run into a silent no-op. Only trusts the payload when its label matches the trigger label, or when the
 * PR was just opened or marked ready; either way the hinted PR is fetched live and must carry the label.
 */
export function eventPullRequestHint(
  label: string,
  eventPath: string | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number | undefined {
  if (eventPath === undefined || eventPath === '') return undefined;
  try {
    const payload = JSON.parse(readFile(eventPath)) as PullRequestEventPayload;
    if (!sameLabel(payload.label?.name ?? '', label) && !READY_ACTIONS.has(payload.action ?? '')) return undefined;
    const number = payload.pull_request?.number;
    return typeof number === 'number' && Number.isInteger(number) && number >= 1 ? number : undefined;
  } catch {
    return undefined;
  }
}

export interface WatchPrsCommandDeps {
  gh?: GhRunner;
  reviewPr?: ReviewPrCommandRunner;
  watchPullRequests?: WatchPullRequestsRunner;
  log?: (line: string) => void;
}

/** Poll GitHub pull requests by label and run Taskcell's non-blocking review on each claimed PR. */
export async function watchPrsCommand(cmd: WatchPrsCommand, deps: WatchPrsCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const reviewPr = deps.reviewPr ?? ((reviewCmd: ReviewPrCommand) => reviewPrCommand(reviewCmd));
  const runWatchPullRequests = deps.watchPullRequests ?? watchPullRequests;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const hintPr = cmd.pr ?? eventPullRequestHint(cmd.label, process.env.GITHUB_EVENT_PATH);
  const primitives = githubPullRequestWatchPrimitives({
    repoSlug: cmd.repoSlug,
    label: cmd.label,
    reviewingLabel: cmd.reviewingLabel,
    reviewedLabel: cmd.reviewedLabel,
    log,
    ...(hintPr !== undefined ? { hintPr } : {}),
    ...(cmd.pinnedOnly === true ? { pinnedOnly: true } : {}),
    ...(cmd.author !== undefined ? { author: cmd.author } : {}),
    ...(cmd.feedbackAuthors !== undefined ? { allowedAuthors: cmd.feedbackAuthors } : {}),
    ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
    reviewOne: (item) =>
      reviewPr({
        kind: 'review-pr',
        // The sweep already skips reviewed heads and a pinned PR was deliberately (re-)labeled: always review.
        force: true,
        ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
        prRef: String(item.number),
        repoSlug: item.repoSlug,
        repoPath: cmd.repoPath,
        egress: cmd.egress,
        ...(cmd.llmProxy === true ? { llmProxy: true } : {}),
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
        ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
        ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
      }),
  });

  log(`watch-prs[github]: polling every ${cmd.intervalMs / 1000}s for PRs labeled "${cmd.label}". Ctrl-C to stop.`);
  if (hintPr !== undefined) {
    log(`watch-prs[github]: ${cmd.repoSlug}#${hintPr} pinned from ${cmd.pr !== undefined ? '--pr' : 'the label event'} — reviewed even if the label scan misses it.`);
  }
  try {
    const pass = (): ReturnType<typeof runWatchPullRequests> =>
      runWatchPullRequests(primitives, {
        concurrency: cmd.concurrency,
        intervalMs: cmd.intervalMs,
        once: cmd.once,
        signal: controller.signal,
        log,
      });
    // A pinned-only run has no later sweep to retry its failed review, so the pin is retried in-run.
    const pinId = `${cmd.repoSlug}#${hintPr}`;
    const { tick, pinUnreviewed } = await passWithPinnedRetry(pass, { id: pinId, retry: cmd.pinnedOnly === true && cmd.once && hintPr !== undefined }, log);
    // --once is the CI mode: a failed review must fail the step (the trigger label was restored; without
    // --pinned-only the next sweep retries) instead of reporting green with nothing posted.
    if (cmd.once && tick !== undefined && (tick.failed.length > 0 || pinUnreviewed)) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** Parse `watch-prs`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseWatchPrsCommand(ctx: ParseCtx): Command {
  const { values, repoPath, builtinProvider, maxTurns, proxyMode } = ctx;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (repoSlug === undefined || label === undefined) return fail('watch-prs requires --github-repo <owner/repo> and --label <name>.');
  const concurrency = Number(values.concurrency);
  const interval = Number(values.interval);
  const prNumber = typeof values.pr === 'string' ? Number(values.pr) : undefined;
  if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) {
    return fail('watch-prs --pr expects a positive PR number.');
  }
  const prFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  return {
    kind: 'watch-prs',
    ...(prFeedbackAuthors !== undefined ? { feedbackAuthors: prFeedbackAuthors } : {}),
    repoSlug,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    once: values.once === true,
    egress: values.egress === true,
    ...(typeof values.author === 'string' ? { author: values.author } : {}),
    ...(prNumber !== undefined ? { pr: prNumber } : {}),
    ...(values['pinned-only'] === true ? { pinnedOnly: true } : {}),
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
