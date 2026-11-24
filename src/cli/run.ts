import type { RunOptions } from '../runners/source-adapter.js';
import { namedSkillsProblem } from '../context/named-skills.js';
import type { RunOnlyKey } from './flags.js';
import { parseForkScorer, present, DEFAULT_CONCURRENCY, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { runLinearIssue, runLinearParent } from '../runners/linear.js';
import { runGithubIssue, runGithubProject, githubDepsFromEnv } from '../runners/github.js';
import { runGitlabIssue, gitlabDepsFromEnv } from '../runners/gitlab.js';
import type { RunIssueResult } from '../runners/source-adapter.js';
import { reapContainers, dockerContainerLister, dockerContainerRemover, pruneWorktrees } from '../core/gc.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv, refuseLlmProxyWithoutPrimarySidecar } from '../agents/auth.js';
import { customEgressHosts } from '../agents/registry.js';
import { loadProviderChoice } from './provider-choice.js';
import { pickRunOptions } from '../runners/source-adapter.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { SandboxWiring } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { Command } from './args.js';

type RunCommand = Extract<Command, { kind: 'run' }>;

/** Dispatch `taskcell run` to the right source runner, assembling deps from env + flags. */
export async function runCommand(cmd: RunCommand): Promise<void> {
  // S6: customs load + re-validate FIRST — before gc, auth, and (critically) startSandboxContext.
  // The parse-time validateProviderChoice was skipped for a non-built-in --provider (sync parser
  // can't read app.json); relying on selectAgents' internal validation instead would spin the
  // enclave — and under --llm-proxy hand the custom's key to an Anthropic-upstream sidecar —
  // before the directOnly/collision rejection fires.
  const choice = await loadProviderChoice(cmd);
  if (cmd.gcBefore) {
    const reaped = await reapContainers(dockerContainerLister(), dockerContainerRemover());
    await pruneWorktrees(cmd.repoPath);
    console.log(`gc-before: reaped ${reaped.length} stale container(s), pruned worktrees.`);
  }

  refuseLlmProxyWithoutPrimarySidecar(cmd.llmProxy, choice);
  const auth = agentAuthFromEnv(choice);
  const extraEgressHosts = customEgressHosts(choice);
  const ctx = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(extraEgressHosts.length > 0 ? { extraEgressHosts } : {}),
  });

  // The runners rebuild the choice from cmd fields, so the loaded customs must ride ON cmd —
  // pickRunOptions copies field-by-field and would otherwise strip them before selectAgents.
  const cmdWithCustoms: RunCommand =
    choice.customProviders !== undefined ? { ...cmd, customProviders: choice.customProviders } : cmd;

  try {
    if (cmd.source === 'linear') {
      await runLinear(cmdWithCustoms, auth, ctx);
    } else if (cmd.source === 'project') {
      await runProject(cmdWithCustoms, ctx);
    } else if (cmd.source === 'gitlab') {
      await runGitlab(cmdWithCustoms, ctx);
    } else {
      await runGithub(cmdWithCustoms, ctx);
    }
  } finally {
    await ctx.destroy();
  }
}

export function linearDeps(
  cmd: RunCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxWiring,
): RunLinearIssueDeps {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  return {
    ...(auth !== undefined ? { auth } : {}),
    linearKey,
    skillsDir,
    repoPath: cmd.repoPath,
    sandboxContext,
    ...(cmd.reuse === true ? { reuse: true } : {}),
    ...(cmd.forkN !== undefined ? { forkN: cmd.forkN } : {}),
    ...pickRunOptions(cmd),
  };
}

async function runLinear(
  cmd: RunCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxWiring,
): Promise<void> {
  const deps = linearDeps(cmd, auth, sandboxContext);
  if (!cmd.parent) {
    const result = await runLinearIssue(cmd.id, deps);
    report(result);
    return;
  }
  const { parent, outcomes } = await runLinearParent(cmd.id, deps, { concurrency: cmd.concurrency });
  console.log(`Parent: ${parent.id} — ${parent.title} (${parent.children.length} sub-tasks)`);
  reportFanOut(outcomes, parent.children.length);
}

export async function runGithub(
  cmd: RunCommand,
  sandboxContext: SandboxWiring,
): Promise<void> {
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd);
  deps.sandboxContext = sandboxContext;
  if (cmd.reuse === true) deps.reuse = true;
  if (cmd.forkN !== undefined) deps.forkN = cmd.forkN;
  Object.assign(deps, pickRunOptions(cmd));
  const result = await runGithubIssue(cmd.id, deps);
  report(result);
}

export async function runGitlab(
  cmd: RunCommand,
  sandboxContext: SandboxWiring,
): Promise<void> {
  if (cmd.parent) throw new Error('--parent is not supported with --gitlab.');
  // If --gitlab-project is absent, extract project from the ref prefix (group/project#42).
  const projectFromRef = cmd.project === undefined && cmd.id.includes('#')
    ? cmd.id.split('#')[0]
    : undefined;
  const deps = await gitlabDepsFromEnv(cmd.repoPath, cmd.project ?? projectFromRef, cmd);
  deps.sandboxContext = sandboxContext;
  if (cmd.reuse === true) deps.reuse = true;
  if (cmd.forkN !== undefined) deps.forkN = cmd.forkN;
  Object.assign(deps, pickRunOptions(cmd));
  const result = await runGitlabIssue(cmd.id, deps);
  report(result);
}

export async function runProject(
  cmd: RunCommand,
  sandboxContext: SandboxWiring,
): Promise<void> {
  const projectNumber = Number(cmd.id);
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd);
  deps.sandboxContext = sandboxContext;
  if (cmd.forkN !== undefined) deps.forkN = cmd.forkN;
  Object.assign(deps, pickRunOptions(cmd));
  const { tasks, outcomes } = await runGithubProject(deps, {
    projectNumber,
    concurrency: cmd.concurrency,
    ...(cmd.label !== undefined ? { label: cmd.label } : {}),
  });
  console.log(`Project ${projectNumber} (${deps.repoSlug}): ${tasks.length} task(s)`);
  reportFanOut(outcomes, tasks.length);
}

function report(result: RunIssueResult): void {
  const { id } = result.task;
  if (result.prUrl !== undefined) {
    console.log(`PR for review: ${result.prUrl} (linked back onto ${id})`);
    return;
  }
  console.log(
    result.secretBlocked === true
      ? `Secret scan blocked publish — no PR for ${id} (masked findings printed above).`
      : `No changes — no PR for ${id}.`,
  );
}

/** Print a fan-out summary (one line per task + totals). Shared by --parent and --project. */
function reportFanOut<I extends { id: string }, T extends { prUrl?: string; secretBlocked?: boolean }>(
  outcomes: ReadonlyArray<FanOutOutcome<I, T>>,
  total: number,
): void {
  let opened = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.prUrl !== undefined) opened += 1;
      const status =
        outcome.value.prUrl ??
        (outcome.value.secretBlocked === true ? 'secret scan blocked (no PR)' : 'no changes (no PR)');
      console.log(`  ${outcome.item.id}: ${status}`);
    } else {
      failed += 1;
      console.log(`  ${outcome.item.id}: FAILED — ${String(outcome.reason)}`);
    }
  }
  console.log(`Done: ${opened} PR(s) opened, ${failed} failed, of ${total}.`);
}

/** Parse `run`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseRunCommand(ctx: ParseCtx): Command {
  const { values, repoPath, skills, fallbackProvider, proxyMode, runOptions } = ctx;
  const sources: Array<['linear' | 'github' | 'project' | 'gitlab', string]> = [];
  if (typeof values.linear === 'string') sources.push(['linear', values.linear]);
  if (typeof values.github === 'string') sources.push(['github', values.github]);
  if (typeof values.project === 'string') sources.push(['project', values.project]);
  if (typeof values.gitlab === 'string') sources.push(['gitlab', values.gitlab]);
  // Exactly one source is required.
  const picked = sources[0];
  if (sources.length !== 1 || picked === undefined) {
    return fail('run requires exactly one of --linear <id>, --github <ref>, --gitlab <ref>, or --project <number>.');
  }
  if (values.parent === true && picked[0] !== 'linear') {
    return fail('--parent is only supported with --linear.');
  }
  // One spec file cannot describe N different tasks — fan-out modes would inject it into every run.
  if (typeof values['spec-file'] === 'string' && (picked[0] === 'project' || values.parent === true)) {
    return fail('--spec-file is only supported for a single-issue run (not --parent / --project fan-out).');
  }
  if (skills.length > 0 && (picked[0] === 'project' || values.parent === true)) {
    return fail('--skill is only supported for a single-issue run (not --parent / --project fan-out); use a "Skills:" line in each issue.');
  }
  if (picked[0] === 'project') {
    const projectNum = Number(picked[1]);
    if (!Number.isInteger(projectNum) || projectNum < 1) {
      return fail(`--project expects a board number, got "${picked[1]}".`);
    }
  }
  const concurrency = Number(values.concurrency);
  const forkN = Number(values.fork);
  const forkScorer = parseForkScorer(values['fork-scorer']);
  if (forkScorer === null) return fail(`--fork-scorer expects llm or decision, got "${String(values['fork-scorer'])}".`);
  if (forkScorer !== undefined && !(Number.isFinite(forkN) && forkN >= 2)) return fail('--fork-scorer only applies with --fork <n> (n>=2).');
  // forkAndSelect runs every variant on the primary agent and returns before the stage fallback is
  // consulted, so the flag would be accepted and silently never fire.
  if (fallbackProvider !== undefined && Number.isFinite(forkN) && forkN >= 2) return fail('--fallback-provider does not apply to --fork variants; drop one of them.');
  // The single-task RunOptions (see RunOnlyKey): typed exhaustively so a new run-only field lands here.
  const skillProblem = namedSkillsProblem(skills);
  if (skillProblem !== undefined) return fail(`--skill ${skillProblem}.`);
  const runOnly = present<Pick<RunOptions, RunOnlyKey>>({
    forkScorer,
    specFile: typeof values['spec-file'] === 'string' ? values['spec-file'] : undefined,
    namedSkills: skills.length > 0 ? skills : undefined,
  });
  return {
    kind: 'run',
    source: picked[0],
    id: picked[1],
    parent: values.parent === true,
    gcBefore: values['gc-before'] === true,
    egress: values.egress === true,
    repoPath,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(Number.isFinite(forkN) && forkN >= 2 ? { forkN: Math.floor(forkN) } : {}),
    ...(values.reuse === true ? { reuse: true } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(typeof values.label === 'string' ? { label: values.label } : {}),
    ...(typeof values['gitlab-project'] === 'string' && picked[0] === 'gitlab' ? { project: values['gitlab-project'] } : {}),
    ...runOptions,
    ...runOnly,
  };
}
