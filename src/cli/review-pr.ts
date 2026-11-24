import { parseFeedbackAuthors, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { githubDefaultBranch, defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { llmProxyNeedsNoPrimarySidecar } from '../agents/registry.js';
import { openAgentSession } from '../runners/agent-session.js';
import { baseBranchOrDefault } from '../core/base-branch.js';
import { buildPullRequestReviewPrompt, PullRequestReviewIncompleteError, reviewPullRequest } from '../runners/pr-review.js';
import { appendStepSummary } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import type { SummaryOutcome } from '../core/run-summary.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { PullRequestForReview, PullRequestReviewAttempt, PullRequestReviewOutcome, PullRequestReviewer, ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';
import { runReviewAgent } from './review-agent.js';
import type { OpenAgentSession } from './review-agent.js';
import type { Command } from './args.js';

type ReviewPrCommand = Extract<Command, { kind: 'review-pr' }>;

type ReviewPullRequestRunner = (ref: string, deps: ReviewPullRequestDeps) => Promise<ReviewPullRequestResult>;

export interface ReviewPrCommandDeps {
  gh?: GhRunner;
  reviewer?: PullRequestReviewer;
  reviewPullRequest?: ReviewPullRequestRunner;
  log?: (line: string) => void;
  /** Opens the agent session (default: a real sandboxed one). */
  openSession?: OpenAgentSession;
}

/** Review an existing GitHub PR and post a non-blocking GitHub review comment. */
export async function reviewPrCommand(cmd: ReviewPrCommand, deps: ReviewPrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReview = deps.reviewPullRequest ?? reviewPullRequest;
  const toFile = cmd.out !== undefined;

  // On Actions each review leaves one block in the job's Summary tab (no GITHUB_STEP_SUMMARY ⇒ no-op).
  // The default reviewer records its agent calls here; an injected one records nothing.
  const outcomes: SummaryOutcome[] = [];
  const stepSummary = (taskId: string, exit: StepSummaryExit, extra: Pick<StepSummary, 'prUrl' | 'verdict' | 'risk' | 'error'> = {}): Promise<void> => {
    const model = outcomes.at(-1)?.result.model ?? cmd.reviewModel;
    return appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
      taskId,
      flow: 'pr-review',
      provider: cmd.provider ?? 'claude',
      ...(model !== undefined ? { model } : {}),
      outcomes,
      exit,
      ...extra,
    });
  };

  // --out routes the review to a local file and suppresses the PR comment — a no-trace review for
  // client repos (nothing is posted to the tracker). Default posts the comment, as before.
  const deliver = async (result: ReviewPullRequestResult): Promise<void> => {
    if (result.skipped === true) {
      return; // reviewPullRequest already logged "already reviewed at <sha>"
    }
    await stepSummary(`${result.pr.repoSlug}#${result.pr.number}`, 'completed', {
      prUrl: result.pr.url,
      ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
      ...(result.risk !== undefined ? { risk: result.risk } : {}),
    });
    if (cmd.out !== undefined) {
      await mkdir(dirname(cmd.out), { recursive: true });
      await writeFile(cmd.out, result.commentBody, 'utf8');
      log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: written to ${resolve(cmd.out)} (no PR comment)`);
      return;
    }
    log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: done`);
  };

  const runAndDeliver = async (reviewer: PullRequestReviewer): Promise<void> => {
    try {
      await deliver(
        await runReview(cmd.prRef, {
          reviewer,
          ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
          log,
          publish: !toFile,
          ...(cmd.force === true ? { force: true } : {}),
          ...(cmd.feedbackAuthors !== undefined ? { allowedAuthors: cmd.feedbackAuthors } : {}),
          ...(cmd.repoSlug !== undefined ? { repoSlug: cmd.repoSlug } : {}),
          ...(/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? { runId: process.env.GITHUB_RUN_ID! } : {}),
        }),
      );
    } catch (error) {
      const pr = error instanceof PullRequestReviewIncompleteError ? error.pr : undefined;
      await stepSummary(pr !== undefined ? `${pr.repoSlug}#${pr.number}` : cmd.prRef, 'error', { error: String(error) });
      // --out callers still get the incomplete notice on disk; the rethrow keeps the exit code truthful.
      if (cmd.out !== undefined && error instanceof PullRequestReviewIncompleteError) {
        await mkdir(dirname(cmd.out), { recursive: true });
        await writeFile(cmd.out, error.commentBody, 'utf8');
        log(`review-pr ${error.pr.repoSlug}#${error.pr.number}: incomplete notice written to ${resolve(cmd.out)} (no PR comment)`);
      }
      throw error;
    }
  };

  if (deps.reviewer !== undefined) {
    await runAndDeliver(deps.reviewer);
    return;
  }

  const auth = agentAuthFromEnv(cmd.provider !== undefined ? { provider: cmd.provider } : {});
  const sandboxContext = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    skipPrimarySidecar: cmd.llmProxy === true && llmProxyNeedsNoPrimarySidecar(cmd),
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });
  try {
    await runAndDeliver((pr, opts) => runDefaultReviewer(pr, cmd, auth, sandboxContext, opts, outcomes, deps.gh ?? defaultGhRunner, deps.openSession ?? openAgentSession));
  } finally {
    await sandboxContext.destroy();
  }
}

async function runDefaultReviewer(
  pr: PullRequestForReview,
  cmd: ReviewPrCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
  opts: PullRequestReviewAttempt,
  outcomes: SummaryOutcome[],
  gh: GhRunner,
  openSession: OpenAgentSession,
): Promise<PullRequestReviewOutcome> {
  const session = await openSession({
    choice: cmd,
    repoPath: cmd.repoPath,
    ...(auth !== undefined ? { auth } : {}),
    sandboxContext,
  });
  const result = await runReviewAgent(session, {
    stageName: 'pr-review',
    taskId: `pr-review-${pr.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${pr.number}`,
    repoPath: cmd.repoPath,
    // The reviewer reads the tree the change lands on: the PR's base as origin has it.
    target: async () => ({
      baseBranch: baseBranchOrDefault(pr.baseRefName, `PR ${pr.repoSlug}#${pr.number}`),
      instructionRef: await githubDefaultBranch(pr.repoSlug, gh),
    }),
    ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
    ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    isRetry: opts.isRetry,
    prompt: (overlay) => buildPullRequestReviewPrompt(pr, { retryTriage: opts.isRetry, ...(overlay !== undefined ? { instructions: overlay } : {}) }),
  });
  outcomes.push({ name: opts.isRetry ? 'pr-review-retry' : 'pr-review', result, ...(cmd.reviewModel !== undefined ? { model: cmd.reviewModel } : {}) });
  return {
    text: result.finalText,
    completed: result.completed,
    turns: result.turns,
    ...(result.usage !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
    ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
    ...(result.lastBlock !== undefined ? { lastBlock: result.lastBlock } : {}),
    // The model the provider reported, not the requested one: a gateway or alias can serve another.
    ...(result.model !== undefined ? { model: result.model } : {}),
  };
}

/** Parse `review-pr`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseReviewPrCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, builtinProvider, maxTurns, proxyMode } = ctx;
  // Accept the PR ref as a positional, --github-pr <n>, or --github <ref> — the last for parity with
  // spec/run/research, which all take --github (a natural thing to reach for).
  const prRef =
    typeof values['github-pr'] === 'string'
      ? values['github-pr']
      : typeof values.github === 'string'
      ? values.github
      : positionals[1];
  if (prRef === undefined) {
    return fail('review-pr requires a PR reference: a URL, owner/repo#number, --github <ref>, or --github-pr <number>.');
  }
  const reviewFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  return {
    kind: 'review-pr',
    ...(reviewFeedbackAuthors !== undefined ? { feedbackAuthors: reviewFeedbackAuthors } : {}),
    prRef,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(typeof values.out === 'string' ? { out: values.out } : {}),
  };
}
