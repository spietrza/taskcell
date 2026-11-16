import { runAgent } from '../core/taskcell.js';
import { overlayInstructionFiles } from '../context/instruction-files.js';
import { skillRegistryForRun } from '../context/skill-registry.js';
import { literalPrompt } from '../context/prompt-engine.js';
import { adversarySystemPrompt } from '../pipeline/pipeline.js';
import { DEFAULT_REVIEW_MAX_TURNS } from './args.js';
import type { InstructionOverlay } from '../context/instruction-files.js';
import type { RunResult } from '../core/types.js';
import type { AgentSession, AgentSessionOptions } from '../runners/agent-session.js';

/** The reviewer may read the repository for context but never execute anything (no Bash/Write/Edit). */
export const PR_REVIEW_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** Opens an agent session; injectable so the CLI commands can be tested without a sandbox. */
export type OpenAgentSession = (opts: AgentSessionOptions) => Promise<AgentSession>;

export interface ReviewAgentInput {
  stageName: 'pr-review' | 'mr-review';
  taskId: string;
  repoPath: string;
  /** Resolved inside the session, so a failure here still closes it. `instructionRef` is the trusted default branch. */
  target: () => Promise<{ baseBranch: string; instructionRef: string }>;
  skillsDir?: string;
  maxTurns?: number;
  reviewModel?: string;
  isRetry: boolean;
  /** Builds the review prompt; `overlay` is set when the trusted default-branch instructions were overlaid. */
  prompt: (overlay: InstructionOverlay | undefined) => string;
}

/**
 * Run one read-only review attempt in `session` and close it on every exit path (the session is consumed).
 * Shared by the PR and MR reviewers: the same tool list, retry turn budget, effort, system prompt,
 * default-branch instruction overlay and repo skills.
 */
export async function runReviewAgent(session: AgentSession, input: ReviewAgentInput): Promise<RunResult> {
  try {
    const { baseBranch, instructionRef } = await input.target();
    let overlay: InstructionOverlay | undefined;
    const ctx = await session.prepare({ taskId: input.taskId, localRepoPath: input.repoPath, baseBranch, start: 'base' }, {
      // Load repo skills after the trusted default-branch instructions have been overlaid.
      skills: (worktreePath) => skillRegistryForRun(input.skillsDir, worktreePath),
      ...(instructionRef !== baseBranch ? { seedWorktree: async (worktreePath: string) => {
        overlay = await overlayInstructionFiles({ repoPath: input.repoPath, worktreePath, ref: instructionRef });
      } } : {}),
    });
    const baseTurns = input.maxTurns ?? DEFAULT_REVIEW_MAX_TURNS;
    return await runAgent(ctx, {
      stageName: input.stageName,
      agent: session.agents.agent,
      ...literalPrompt(input.prompt(overlay)),
      systemPrompt: adversarySystemPrompt(),
      effort: input.isRetry ? 'xhigh' : 'high',
      maxTurns: input.isRetry ? Math.min(Math.ceil(baseTurns * 1.5), Number.MAX_SAFE_INTEGER) : baseTurns,
      copyBack: false,
      // Read-only: the change under review is untrusted and never run. With Bash the reviewer installs
      // node_modules and runs the project instead of reviewing the diff it was given.
      allowedTools: [...PR_REVIEW_TOOLS],
      ...(input.reviewModel !== undefined ? { model: input.reviewModel } : {}),
    });
  } finally {
    await session.close();
  }
}
