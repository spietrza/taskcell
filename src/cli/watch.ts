import type { WatchSource } from './flags.js';
import { DEFAULT_CONCURRENCY, DEFAULT_LOOP_V1_OWNERSHIP_LABEL, DEFAULT_LINEAR_SPEC_STATE, DEFAULT_LINEAR_SPEC_STATE_NAME, DEFAULT_LINEAR_NEEDS_INFO_STATE, DEFAULT_LINEAR_AGENT_STATE, fail, sameName, parseLimit, parseDependencyRepos } from './flags.js';
import { DEFAULT_GITHUB_SPEC_LABEL, DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_NEEDS_INFO_LABEL } from '../core/labels.js';
import type { ParseCtx } from './flags.js';
import { watchLinear, watchGithub, watchGithubProject, watchLinearLoopV1, watchGithubLoopV1, watchGitlab, watchGitlabLoopV1 } from '../runners/watch.js';
import { githubDepsFromEnv } from '../runners/github.js';
import { gitlabDepsFromEnv } from '../runners/gitlab.js';
import { pickRunOptions } from '../runners/source-adapter.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { ciRunUrl } from '../core/links.js';
import { setRunTrigger } from '../core/run-store.js';
import { agentAuthFromEnv, refuseLlmProxyWithoutPrimarySidecar } from '../agents/auth.js';
import { customEgressHosts } from '../agents/registry.js';
import { loadProviderChoice } from './provider-choice.js';
import { LinearCliTaskFetcher } from '../tasks/linear-cli.js';
import { GitHubTaskFetcher } from '../tasks/github.js';
import { GitLabTaskFetcher } from '../tasks/gitlab.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import { GITLAB_CLAIMED_LABEL, GITLAB_REVIEW_LABEL, GITLAB_SPEC_CLAIMED_LABEL } from '../gitlab-labels.js';
import { formatPreflightReport, preflightFailed, runPreflight } from './preflight.js';
import type { AgentAuth } from '../agents/auth.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { Command } from './args.js';
import type { RunSpecGeneratorDeps } from '../runners/spec.js';

type WatchCommand = Extract<Command, { kind: 'watch' }>;

const SPEC_CLAIMED_STATE = 'Speccing'; // Linear default; override with --spec-claimed-state.

/** Run the autonomous watch loop for the chosen source (poll -> claim -> run -> review), with egress. */
export async function watchCommand(cmd: WatchCommand): Promise<void> {
  // S6: customs load + re-validate FIRST (the sync parser skipped pairing checks for a custom
  // --provider). Loaded once per watch process: customs and the enclave allowlist are a
  // watch-start snapshot — restart the watch to pick up app.json edits.
  const choice = await loadProviderChoice(cmd);
  cmd = choice.customProviders !== undefined ? { ...cmd, customProviders: choice.customProviders } : cmd;

  // Before preflight, whose llm-auth check would otherwise report a missing Claude key.
  refuseLlmProxyWithoutPrimarySidecar(cmd.llmProxy, choice);
  const report = await runPreflight(cmd);
  for (const line of formatPreflightReport(report)) console.log(line);
  if (!report.ok) throw preflightFailed();

  const auth = agentAuthFromEnv(choice);
  // The hub's Enable factory checklist counts only these records as "worker seen". The CI factory
  // (implement.yml runs `watch --once`) is not a self-hosted worker, so a run inside CI is not stamped.
  setRunTrigger(ciRunUrl() === undefined ? 'watch' : undefined);

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const extraEgressHosts = customEgressHosts(choice);
  const ctx = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(extraEgressHosts.length > 0 ? { extraEgressHosts } : {}),
  });

  const labelSuffix = cmd.label !== undefined ? ` labeled "${cmd.label}"` : '';
  console.log(`watch[${cmd.source}]: polling every ${cmd.intervalMs / 1000}s for items${labelSuffix}. Ctrl-C to stop.`);
  const reviewNote = specOnlyReviewNote(cmd);
  if (reviewNote !== undefined) console.log(reviewNote);
  try {
    if (cmd.source === 'linear') {
      await watchLinearSource(cmd, auth, ctx, controller.signal);
    } else if (cmd.source === 'project') {
      await watchGithubProjectSource(cmd, auth, ctx, controller.signal);
    } else if (cmd.source === 'gitlab') {
      await watchGitlabSource(cmd, auth, ctx, controller.signal);
    } else {
      await watchGithubSource(cmd, auth, ctx, controller.signal);
    }
  } finally {
    await ctx.destroy();
  }
}

/** Under --spec-only, where specced issues go; a build job that triggers there leaves no review window. */
export function specOnlyReviewNote(cmd: WatchCommand): string | undefined {
  if (cmd.specOnly !== true) return undefined;
  if (cmd.source === 'linear') {
    return `watch: --spec-only moves specced issues to state "${cmd.agentState ?? DEFAULT_LINEAR_AGENT_STATE}". Its state type must differ from the --spec-state type, or the spec pass specs them again on every poll, and from the build job's trigger type (unstarted by default), or there is no review window.`;
  }
  return cmd.agentLabel !== undefined
    ? `watch: --spec-only moves specced issues to label "${cmd.agentLabel}". For a review window the build job must not trigger on it. Taskcell only checks that it is not the default build label "${DEFAULT_GITHUB_AGENT_LABEL}"; it cannot see a build job on another label. The build job's --label must be the approval label a human applies, not the loop-v1 ownership --label, which stays on every issue.`
    : undefined;
}

export async function watchLinearSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so Taskcell can read and update Linear issues.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  // parseCli guarantees --label for the linear source (single-pass and loop-v1), so it is present here.
  const label = cmd.label!;

  const agentDeps = {
    ...(auth !== undefined ? { auth } : {}),
    linearKey,
    skillsDir,
    repoPath: cmd.repoPath,
    sandboxContext: ctx,
    ...pickRunOptions(cmd),
  };

  // Loop v1: activated when --spec-state is supplied. parseCli guarantees --spec-state-name and
  // --needs-info-state accompany it.
  if (cmd.specState !== undefined) {
    const specStateName = cmd.specStateName!;
    const needsInfoState = cmd.needsInfoState!;
    const specDeps: RunSpecGeneratorDeps = {
      ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new LinearCliTaskFetcher({
        ...(cmd.team !== undefined ? { team: cmd.team } : {}),
      }),
      sandboxSecrets: { LINEAR_API_KEY: linearKey },
      sandboxContext: ctx,
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.customProviders !== undefined ? { customProviders: cmd.customProviders } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
      ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}),
      ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
      skillsDir,
    };
    await watchLinearLoopV1({
      spec: {
        deps: specDeps,
        label,
        specTriggerState: cmd.specState,
        specTriggerStateName: specStateName,
        claimedState: cmd.specClaimedState ?? SPEC_CLAIMED_STATE,
        agentState: cmd.agentState ?? DEFAULT_LINEAR_AGENT_STATE,
        needsInfoState,
        ...(cmd.team !== undefined ? { team: cmd.team } : {}),
      },
      agent: {
        deps: agentDeps,
        label,
        triggerState: cmd.triggerState ?? 'unstarted',
        triggerStateName: cmd.triggerStateName ?? cmd.agentState ?? DEFAULT_LINEAR_AGENT_STATE,
        claimedState: cmd.claimedState ?? 'In Progress',
        reviewState: cmd.reviewState ?? 'In Review',
        needsInfoState,
        ...(cmd.team !== undefined ? { team: cmd.team } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
      ...(cmd.specOnly === true ? { specOnly: true } : {}),
      signal,
    });
    return;
  }

  if (cmd.specOnly === true) throw new Error('--spec-state is required with --spec-only for linear loop-v1');
  await watchLinear({
    deps: agentDeps,
    label,
    triggerState: cmd.triggerState ?? 'unstarted',
    triggerStateName: cmd.triggerStateName ?? 'Todo',
    claimedState: cmd.claimedState ?? 'In Progress',
    reviewState: cmd.reviewState ?? 'In Review',
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
    signal,
    ...(cmd.team !== undefined ? { team: cmd.team } : {}),
  });
}

export async function buildGithubDeps(cmd: WatchCommand, auth: AgentAuth | undefined, ctx: SandboxContext) {
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd);
  if (auth !== undefined) deps.auth = auth;
  deps.sandboxContext = ctx;
  Object.assign(deps, pickRunOptions(cmd));
  return deps;
}

export async function watchGithubSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const deps = await buildGithubDeps(cmd, auth, ctx);

  // Loop v1: activated when --spec-label is supplied. parseCli guarantees --agent-label and
  // --needs-info-label accompany it.
  if (cmd.specLabel !== undefined) {
    const agentLabel = cmd.agentLabel!;
    const needsInfoLabel = cmd.needsInfoLabel!;
    const repoSlug = deps.repoSlug;
    const specDeps: RunSpecGeneratorDeps = {
      ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new GitHubTaskFetcher(repoSlug),
      sandboxContext: ctx,
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.customProviders !== undefined ? { customProviders: cmd.customProviders } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
      ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}),
      ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
      ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
    };
    await watchGithubLoopV1({
      spec: {
        deps: specDeps,
        repoSlug,
        specLabel: cmd.specLabel,
        claimedLabel: cmd.specClaimedLabel ?? GITHUB_SPEC_CLAIMED_LABEL,
        agentLabel,
        needsInfoLabel,
        ...(cmd.dependencyRepos !== undefined ? { dependencyRepos: cmd.dependencyRepos } : {}),
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
        ...(cmd.issue !== undefined ? { issueRef: cmd.issue } : {}),
      },
      agent: {
        deps,
        label: agentLabel,
        claimedLabel: cmd.claimedState ?? GITHUB_CLAIMED_LABEL,
        reviewLabel: cmd.reviewState ?? GITHUB_REVIEW_LABEL,
        needsInfoLabel,
        ...(cmd.dependencyRepos !== undefined ? { dependencyRepos: cmd.dependencyRepos } : {}),
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
        ...(cmd.issue !== undefined ? { issueRef: cmd.issue } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
      ...(cmd.specOnly === true ? { specOnly: true } : {}),
      signal,
    });
    return;
  }

  if (cmd.specOnly === true) throw new Error('--spec-label is required with --spec-only for github loop-v1');
  // parseCli guarantees --label for the single-pass github source.
  const label = cmd.label!;
  await watchGithub({
    deps,
    label,
    claimedLabel: cmd.claimedState ?? GITHUB_CLAIMED_LABEL,
    reviewLabel: cmd.reviewState ?? GITHUB_REVIEW_LABEL,
    ...(cmd.dependencyRepos !== undefined ? { dependencyRepos: cmd.dependencyRepos } : {}),
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
    ...(cmd.issue !== undefined ? { issueRef: cmd.issue } : {}),
    signal,
  });
}

export async function watchGithubProjectSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  if (cmd.specOnly === true) throw new Error('--spec-only is not supported with --source project');
  // parseCli guarantees --project for the project source.
  const projectNumber = cmd.projectNumber!;
  const deps = await buildGithubDeps(cmd, auth, ctx);
  await watchGithubProject({
    deps,
    projectNumber,
    triggerStatus: cmd.triggerState ?? 'Todo',
    claimedStatus: cmd.claimedState ?? 'In Progress',
    reviewStatus: cmd.reviewState ?? 'In Review',
    ...(cmd.label !== undefined ? { label: cmd.label } : {}),
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
    signal,
  });
}

export async function watchGitlabSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const deps = await gitlabDepsFromEnv(cmd.repoPath, cmd.project, cmd);
  if (auth !== undefined) deps.auth = auth;
  deps.sandboxContext = ctx;
  Object.assign(deps, pickRunOptions(cmd));

  // Loop v1: activated when --spec-label is supplied.
  if (cmd.specLabel !== undefined) {
    if (cmd.agentLabel === undefined || cmd.needsInfoLabel === undefined) {
      throw new Error('--agent-label and --needs-info-label are required with --spec-label for gitlab loop-v1');
    }
    const specDeps: RunSpecGeneratorDeps = {
      ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new GitLabTaskFetcher(deps.project),
      sandboxContext: ctx,
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.customProviders !== undefined ? { customProviders: cmd.customProviders } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
      ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}),
      ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
      ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
    };
    await watchGitlabLoopV1({
      spec: {
        deps: specDeps,
        project: deps.project,
        specLabel: cmd.specLabel,
        claimedLabel: cmd.specClaimedLabel ?? GITLAB_SPEC_CLAIMED_LABEL,
        agentLabel: cmd.agentLabel,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      agent: {
        deps,
        label: cmd.agentLabel,
        claimedLabel: cmd.claimedState ?? GITLAB_CLAIMED_LABEL,
        reviewLabel: cmd.reviewState ?? GITLAB_REVIEW_LABEL,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
      ...(cmd.specOnly === true ? { specOnly: true } : {}),
      signal,
    });
    return;
  }

  if (cmd.specOnly === true) throw new Error('--spec-label is required with --spec-only for gitlab loop-v1');
  if (cmd.label === undefined) throw new Error('--label is required for gitlab watch source');
  await watchGitlab({
    deps,
    label: cmd.label,
    claimedLabel: cmd.claimedState ?? GITLAB_CLAIMED_LABEL,
    reviewLabel: cmd.reviewState ?? GITLAB_REVIEW_LABEL,
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    ...(cmd.maxTasks !== undefined ? { maxTasks: cmd.maxTasks } : {}),
    signal,
  });
}

/** Parse `watch` and `doctor`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseWatchCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, proxyMode, runOptions } = ctx;
  const commandKind = positionals[0];
  const source: WatchSource =
    values.source === 'github' || (values.source === undefined && typeof values['github-repo'] === 'string')
      ? 'github'
      : values.source === 'project'
        ? 'project'
        : values.source === 'gitlab'
          ? 'gitlab'
          : 'linear';
  // project number is required when source === 'project'
  const projectNumber = typeof values.project === 'string' ? Number(values.project) : undefined;
  if (source === 'project' && (projectNumber === undefined || !Number.isFinite(projectNumber))) {
    return fail(`${commandKind} --source project requires --project <number>.`);
  }

  let label = typeof values.label === 'string' ? values.label : undefined;
  let specLabel = typeof values['spec-label'] === 'string' ? values['spec-label'] : undefined;
  let agentLabel = typeof values['agent-label'] === 'string' ? values['agent-label'] : undefined;
  let needsInfoLabel = typeof values['needs-info-label'] === 'string' ? values['needs-info-label'] : undefined;
  let specState = typeof values['spec-state'] === 'string' ? values['spec-state'] : undefined;
  let specStateName = typeof values['spec-state-name'] === 'string' ? values['spec-state-name'] : undefined;
  const agentState = typeof values['agent-state'] === 'string' ? values['agent-state'] : undefined;
  let needsInfoState = typeof values['needs-info-state'] === 'string' ? values['needs-info-state'] : undefined;

  const hasGithubLoopFlags =
    specLabel !== undefined ||
    agentLabel !== undefined ||
    needsInfoLabel !== undefined ||
    typeof values['spec-claimed-label'] === 'string';
  const hasLinearLoopFlags =
    specState !== undefined ||
    specStateName !== undefined ||
    agentState !== undefined ||
    needsInfoState !== undefined ||
    typeof values['spec-claimed-state'] === 'string';
  const repoOnlyGithubLoop =
    source === 'github' && label === undefined && !hasGithubLoopFlags && !hasLinearLoopFlags;
  const isLoopV1 = values['loop-v1'] === true || hasGithubLoopFlags || hasLinearLoopFlags || repoOnlyGithubLoop;

  if (isLoopV1 && (source === 'github' || source === 'gitlab') && hasLinearLoopFlags) {
    return fail('Linear loop-v1 flags (--spec-state etc.) are not compatible with --source github/gitlab.');
  }
  if (isLoopV1 && source === 'linear' && hasGithubLoopFlags) {
    return fail('GitHub loop-v1 flags (--spec-label etc.) are not compatible with --source linear.');
  }
  if (isLoopV1 && (source === 'github' || source === 'gitlab')) {
    specLabel ??= DEFAULT_GITHUB_SPEC_LABEL;
    agentLabel ??= DEFAULT_GITHUB_AGENT_LABEL;
    needsInfoLabel ??= DEFAULT_GITHUB_NEEDS_INFO_LABEL;
  } else if (isLoopV1 && source === 'linear') {
    label ??= DEFAULT_LOOP_V1_OWNERSHIP_LABEL;
    specState ??= DEFAULT_LINEAR_SPEC_STATE;
    specStateName ??= DEFAULT_LINEAR_SPEC_STATE_NAME;
    needsInfoState ??= DEFAULT_LINEAR_NEEDS_INFO_STATE;
  }

  if (isLoopV1) {
    // Loop v1 validation per source.
    if (source === 'github' || source === 'gitlab') {
      if (specLabel === undefined || agentLabel === undefined || needsInfoLabel === undefined) {
        return fail('github/gitlab loop-v1 requires --spec-label, --agent-label, and --needs-info-label.');
      }
      if (source === 'gitlab' && label === undefined) {
        return fail('gitlab loop-v1 requires --label <name>.');
      }
      if (values['spec-only'] === true && sameName(agentLabel, DEFAULT_GITHUB_AGENT_LABEL)) {
        return fail(`${commandKind} --spec-only requires --agent-label <review label> other than "${DEFAULT_GITHUB_AGENT_LABEL}"; that default is the build trigger, so specced issues would get no review window.`);
      }
      if (values['spec-only'] === true && sameName(agentLabel, specLabel)) {
        return fail(`${commandKind} --spec-only cannot advance specced issues into the spec trigger label "${specLabel}"; set --agent-label to another label, or the spec pass specs the same issues again on every poll.`);
      }
      // --label is an optional extra ownership filter in github loop-v1. A repo-scoped shorthand
      // watches the routing labels directly; explicit --label narrows that further when desired.
    } else if (source === 'linear') {
      if (specState === undefined || specStateName === undefined || needsInfoState === undefined) {
        return fail('--spec-state requires --spec-state-name and --needs-info-state (linear loop-v1).');
      }
      // --label is still the shared ownership label across both passes. Defaults keep the filter,
      // not a status-only scan over the whole Linear workspace.
      if (label === undefined) {
        return fail(`${commandKind} --source linear loop-v1 requires --label <name>.`);
      }
      if (values['spec-only'] === true && sameName(agentState ?? DEFAULT_LINEAR_AGENT_STATE, DEFAULT_LINEAR_AGENT_STATE)) {
        return fail(`${commandKind} --spec-only requires --agent-state <review state> other than "${DEFAULT_LINEAR_AGENT_STATE}"; that default is the build trigger, so specced issues would get no review window.`);
      }
      // The spec pass lists by state TYPE (--spec-state); --spec-state-name is only its revert target. This
      // name check catches the obvious case and assumes --spec-state-name is a state of the --spec-state type.
      if (values['spec-only'] === true && sameName(agentState ?? DEFAULT_LINEAR_AGENT_STATE, specStateName)) {
        return fail(`${commandKind} --spec-only cannot advance specced issues into the spec trigger state "${specStateName}"; set --agent-state to another state, or the spec pass specs the same issues again on every poll.`);
      }
    } else {
      // project source does not support loop-v1
      return fail('loop-v1 is not supported with --source project.');
    }
  } else {
    if (values['spec-only'] === true) {
      return fail(`${commandKind} --spec-only requires loop-v1, which any loop-v1 flag turns on (for example --loop-v1, --spec-state or --spec-label); single-pass watch has no spec pass.`);
    }
    // Existing single-pass validation: label is required for linear/github/gitlab; optional for project.
    if (source !== 'project' && label === undefined) {
      return fail(`${commandKind} --source ${source} requires --label <name>${commandKind === 'doctor' && source === 'linear' ? ' (or pick a source: --source github --github-repo <owner/repo>)' : ''}.`);
    }
  }

  const interval = Number(values.interval);
  const concurrency = Number(values.concurrency);
  const maxTasks = parseLimit(values['max-tasks']);
  // A blast-radius cap must not fall through to "process all" on a typo, 0 or a negative.
  if (values['max-tasks'] !== undefined && maxTasks === undefined) {
    return fail(`--max-tasks needs a positive integer, got "${String(values['max-tasks'])}".`);
  }
  const issueRef = typeof values.issue === 'string' ? values.issue : undefined;
  if (issueRef !== undefined) {
    if (source !== 'github') return fail(`${commandKind} --issue requires --source github.`);
    // Same shape check as `watch-prs --pr`, plus the repo prefix: the fetch strips an `owner/repo#`
    // prefix and reads the number from --github-repo, so a prefix naming another repo would
    // silently run a different issue.
    const groups = /^(?:(?<repo>[^\s#/]+\/[^\s#/]+)#)?(?<number>\d+)$/.exec(issueRef)?.groups;
    if (groups === undefined || Number(groups['number']) < 1) {
      return fail(`${commandKind} --issue expects a positive issue number or owner/repo#n, got "${issueRef}".`);
    }
    const refRepo = groups['repo'];
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    if (refRepo !== undefined && refRepo !== repoSlug) {
      return fail(
        `${commandKind} --issue ${issueRef} names repo "${refRepo}", but --github-repo is ${repoSlug === undefined ? 'unset' : `"${repoSlug}"`}; the issue must live in the watched repo.`,
      );
    }
  }
  type WatchCommon = Omit<Extract<Command, { kind: 'watch' }>, 'kind' | 'concurrency' | 'intervalMs' | 'once' | 'egress'>;
  const common: WatchCommon = {
    source,
    repoPath,
    ...(maxTasks !== undefined ? { maxTasks } : {}),
    ...(issueRef !== undefined ? { issue: issueRef } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(projectNumber !== undefined ? { projectNumber } : {}),
    ...(typeof values['gitlab-project'] === 'string' ? { project: values['gitlab-project'] } : {}),
    ...(typeof values.team === 'string' ? { team: values.team } : {}),
    ...(typeof values['trigger-state'] === 'string' ? { triggerState: values['trigger-state'] } : {}),
    ...(typeof values['trigger-state-name'] === 'string' ? { triggerStateName: values['trigger-state-name'] } : {}),
    ...(typeof values['claimed-state'] === 'string' ? { claimedState: values['claimed-state'] } : {}),
    ...(typeof values['review-state'] === 'string' ? { reviewState: values['review-state'] } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...parseDependencyRepos(values['dependency-repos']),
    ...runOptions,
    ...(proxyMode ? { llmProxy: true } : {}),
    // Loop v1 fields (omitted when not supplied, preserving existing behaviour when absent).
    ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
    ...(specLabel !== undefined ? { specLabel } : {}),
    ...(agentLabel !== undefined ? { agentLabel } : {}),
    ...(needsInfoLabel !== undefined ? { needsInfoLabel } : {}),
    ...(typeof values['spec-claimed-label'] === 'string' ? { specClaimedLabel: values['spec-claimed-label'] } : {}),
    ...(specState !== undefined ? { specState } : {}),
    ...(specStateName !== undefined ? { specStateName } : {}),
    ...(agentState !== undefined ? { agentState } : {}),
    ...(needsInfoState !== undefined ? { needsInfoState } : {}),
    ...(typeof values['spec-claimed-state'] === 'string' ? { specClaimedState: values['spec-claimed-state'] } : {}),
    ...(values['spec-only'] === true ? { specOnly: true } : {}),
  };

  if (commandKind === 'doctor') {
    // StageOnlyKey: the proof/conformance knobs stay off the doctor command.
    const { visualProofCmd: _visualProofCmd, conformance: _conformance, conformanceModel: _conformanceModel, ...checks } = common;
    return { kind: 'doctor', ...checks, ...(values.fix === true ? { fix: true } : {}) };
  }

  return {
    kind: 'watch',
    ...common,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    // --issue names one issue: polling for it again would re-read an issue this run already
    // claimed or skipped, so it implies --once.
    once: values.once === true || issueRef !== undefined,
    egress: values.egress === true,
  };
}
