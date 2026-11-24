import type { ParseCtx } from './flags.js';
import { gitlabDefaultBranch, defaultGlabRunner } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { llmProxyNeedsNoPrimarySidecar } from '../agents/registry.js';
import { openAgentSession } from '../runners/agent-session.js';
import { baseBranchOrDefault } from '../core/base-branch.js';
import { buildMergeRequestReviewPrompt, reviewMergeRequest } from '../runners/mr-review.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type {
  MergeRequestForReview,
  MergeRequestReviewAttempt,
  MergeRequestReviewOutcome,
  MergeRequestReviewer,
  ReviewMergeRequestDeps,
  ReviewMergeRequestResult,
} from '../runners/mr-review.js';
import { runReviewAgent } from './review-agent.js';
import type { OpenAgentSession } from './review-agent.js';
import type { Command } from './args.js';

type ReviewMrCommand = Extract<Command, { kind: 'review-mr' }>;
type ReviewMergeRequestRunner = (ref: string, deps: ReviewMergeRequestDeps) => Promise<ReviewMergeRequestResult>;

export interface ReviewMrCommandDeps {
  glab?: GlabRunner;
  reviewer?: MergeRequestReviewer;
  reviewMergeRequest?: ReviewMergeRequestRunner;
  log?: (line: string) => void;
  /** See ReviewMergeRequestDeps.headDedupe. */
  headDedupe?: boolean;
  /** Opens the agent session (default: a real sandboxed one). */
  openSession?: OpenAgentSession;
}

/** Review an existing GitLab MR and post a non-blocking Taskcell review note. */
export async function reviewMrCommand(cmd: ReviewMrCommand, deps: ReviewMrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReview = deps.reviewMergeRequest ?? reviewMergeRequest;
  const headDedupe = deps.headDedupe !== undefined ? { headDedupe: deps.headDedupe } : {};
  if (deps.reviewer !== undefined) {
    const result = await runReview(String(cmd.iid), { reviewer: deps.reviewer, project: cmd.project, ...(deps.glab !== undefined ? { glab: deps.glab } : {}), log, ...headDedupe });
    logDone(result, log);
    return;
  }

  const auth = agentAuthFromEnv(cmd.provider !== undefined ? { provider: cmd.provider } : {});
  // Started on the first reviewer call, so an already-reviewed head never starts a sandbox, and shared by
  // the incomplete-retry so it does not rebuild the egress network and llm-proxy sidecar. The promise is
  // cached, not the context, so overlapping attempts could never start a second one. A failed start fails
  // the first attempt, and a thrown attempt ends the review (only an incomplete one is retried), so a
  // cached rejection is never awaited by a retry.
  let sandboxContext: Promise<SandboxContext> | undefined;
  const reviewer: MergeRequestReviewer = async (mr, opts) => {
    sandboxContext ??= startSandboxContext({
      egress: cmd.egress,
      llmProxy: cmd.llmProxy === true,
      skipPrimarySidecar: cmd.llmProxy === true && llmProxyNeedsNoPrimarySidecar(cmd),
      ...(auth !== undefined ? { auth } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    });
    return await runDefaultMrReviewer(mr, cmd, auth, await sandboxContext, opts, deps.glab ?? defaultGlabRunner, deps.openSession ?? openAgentSession);
  };
  try {
    const result = await runReview(String(cmd.iid), { reviewer, project: cmd.project, ...(deps.glab !== undefined ? { glab: deps.glab } : {}), log, ...headDedupe });
    logDone(result, log);
  } finally {
    const started = await sandboxContext?.catch(() => undefined);
    await started?.destroy();
  }
}

/** A skipped head already logged "already reviewed -> skip"; "done" would read as a fresh review. */
function logDone(result: ReviewMergeRequestResult, log: (line: string) => void): void {
  if (result.commentBody !== undefined) log(`review-mr ${result.mr.project}!${result.mr.iid}: done`);
}

async function runDefaultMrReviewer(
  mr: MergeRequestForReview,
  cmd: ReviewMrCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
  opts: MergeRequestReviewAttempt,
  glab: GlabRunner,
  openSession: OpenAgentSession,
): Promise<MergeRequestReviewOutcome> {
  const session = await openSession({
    choice: cmd,
    repoPath: cmd.repoPath,
    ...(auth !== undefined ? { auth } : {}),
    sandboxContext,
  });
  const result = await runReviewAgent(session, {
    stageName: 'mr-review',
    taskId: `mr-review-${mr.project.replace(/[^a-zA-Z0-9]/g, '-')}-${mr.iid}`,
    repoPath: cmd.repoPath,
    // The reviewer reads the tree the change lands on: the MR's target branch as origin has it.
    target: async () => ({
      baseBranch: baseBranchOrDefault(mr.targetBranch, `MR ${mr.project}!${mr.iid}`),
      instructionRef: await gitlabDefaultBranch(mr.project, glab),
    }),
    ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
    ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    isRetry: opts.isRetry,
    prompt: (overlay) => buildMergeRequestReviewPrompt(mr, { retryTriage: opts.isRetry, ...(overlay !== undefined ? { instructions: overlay } : {}) }),
  });
  return { text: result.finalText, completed: result.completed };
}

/** Parse `review-mr`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseReviewMrCommand(ctx: ParseCtx): Command {
  const { values, repoPath, builtinProvider, maxTurns } = ctx;
  const iidRaw = typeof values.mr === 'string' ? Number(values.mr) : undefined;
  const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
  if (iidRaw === undefined || !Number.isInteger(iidRaw) || project === undefined) return { kind: 'help' };
  return {
    kind: 'review-mr',
    iid: iidRaw,
    project,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
