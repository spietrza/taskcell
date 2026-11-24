import type { WatchSource } from './flags.js';
import { DEFAULT_CONCURRENCY, DEFAULT_LOOP_V1_OWNERSHIP_LABEL, DEFAULT_LINEAR_SPEC_STATE, DEFAULT_LINEAR_SPEC_STATE_NAME, DEFAULT_LINEAR_NEEDS_INFO_STATE, DEFAULT_LINEAR_AGENT_STATE, fail, sameName, parseLimit, parseDependencyRepos } from './flags.js';
import { DEFAULT_GITHUB_SPEC_LABEL, DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_NEEDS_INFO_LABEL } from '../core/labels.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

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
