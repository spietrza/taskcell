import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { llmProxyNeedsNoPrimarySidecar } from '../agents/registry.js';
import { runAgent } from '../core/taskcell.js';
import { openAgentSession } from '../runners/agent-session.js';
import { DEFAULT_BASE_BRANCH } from '../core/base-branch.js';
import { literalPrompt } from '../context/prompt-engine.js';
import { runResearch } from '../runners/research.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { Researcher } from '../runners/research.js';
import type { Command } from './args.js';

type ResearchCommand = Extract<Command, { kind: 'research' }>;

export interface ResearchCommandDeps {
  researcher?: Researcher;
  log?: (line: string) => void;
}

/** Run external research on a GitHub issue and post findings as a comment. Does not auto-advance. */
export async function researchCommand(cmd: ResearchCommand, deps: ResearchCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const repoSlug = resolveRepoSlug(cmd.issueRef, cmd.repoSlug);

  const runWith = async (researcher: Researcher): Promise<void> => {
    const result = await runResearch(cmd.issueRef, {
      repoSlug,
      researcher,
      webAccess: cmd.webAccess ?? false,
      whiteLabel: cmd.commitAuthor !== undefined,
      log,
    });
    log(`research ${cmd.issueRef}: iteration ${result.iteration} posted`);
  };

  if (deps.researcher !== undefined) {
    await runWith(deps.researcher);
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
    await runWith((prompt) => runDefaultResearcher(prompt, cmd, auth, sandboxContext));
  } finally {
    await sandboxContext.destroy();
  }
}

function resolveRepoSlug(issueRef: string, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const hash = issueRef.indexOf('#');
  if (hash > 0) return issueRef.slice(0, hash);
  throw new Error(`research: cannot determine repo slug from "${issueRef}" — use --github-repo`);
}

async function runDefaultResearcher(
  prompt: string,
  cmd: ResearchCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
): Promise<string> {
  const session = await openAgentSession({
    choice: cmd,
    repoPath: cmd.repoPath,
    ...(auth !== undefined ? { auth } : {}),
    ...(sandboxContext.proxyUrl !== undefined ? { proxyUrl: sandboxContext.proxyUrl } : {}),
    ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
    ...(sandboxContext.llmProxy !== undefined ? { llmProxy: sandboxContext.llmProxy } : {}),
    proxyMode: cmd.llmProxy === true,
  });
  // The session owns the provider sidecars, sandbox and context: closed on every exit path below.
  try {
    const { agents } = session;
    const taskId = `research-${cmd.issueRef.replace(/[^a-zA-Z0-9]/g, '-')}`;
    // research has no --base: the codebase is read at the default base as origin has it, like every other run.
    const ctx = await session.prepare({ taskId, localRepoPath: cmd.repoPath, baseBranch: DEFAULT_BASE_BRANCH, start: 'base' });
    const result = await runAgent(ctx, {
      stageName: 'research',
      agent: agents.agent,
      ...literalPrompt(prompt),
      maxTurns: 12,
      copyBack: false,
      ...(cmd.researchModel !== undefined ? { model: cmd.researchModel } : {}),
    });
    return result.finalText;
  } finally {
    await session.close();
  }
}
