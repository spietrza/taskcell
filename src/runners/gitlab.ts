import { REVIEW_HEADING, hasLabel } from '../core/labels.js';
import { execa } from 'execa';
import { agentAuthFromEnv } from '../agents/auth.js';
import { applyGitlabDependencyGate } from '../tasks/gitlab-dependencies.js';
import { runSpecGenerator } from './spec.js';
import { NO_CHANGE_MSG, holdMessage, failureOrCapComment, runSpecCore, triageAgentRun } from './watch-shared.js';
import type { WatchPrimitives, SpecWatchPrimitives, GenerateSpec } from './watch-shared.js';
import type { RunSpecGeneratorDeps } from './spec.js';
import { GitLabTaskFetcher, linkMergeRequest, addMrFailureLabel, addMrGateLabel, editGitlabLabels, commentGitlabIssue, defaultGlabRunner } from '../tasks/gitlab.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { parseMergeRequestRef, postMergeRequestNote, mergeRequestReviewMarker } from './mr-review.js';
import { REVIEW_INCOMPLETE, stripReviewMarkers } from './review-prompt.js';
import type { MergeRequestReviewTarget } from './mr-review.js';
import { renderConformanceSection, hasBlockingFinding } from '../pipeline/review-publish.js';
import { runSourcedIssue } from './source-adapter.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { gitlabFailureLabel, GITLAB_GATE_CONFIG_LABEL, GITLAB_SECRET_BLOCKED_LABEL } from '../gitlab-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { RunIssueDeps, RunIssueResult, SourceAdapter, PublishVerdictInput, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single GitLab issue end to end. */
export interface RunGitlabIssueDeps extends RunIssueDeps {
  /** GitLab project path, e.g. `group/project`. */
  project: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld MR is not read as "no changes". */
export type RunGitlabIssueResult = RunIssueResult;

/** @internal Exported for unit tests; production callers use runGitlabIssue. */
export function gitlabAdapter(deps: RunGitlabIssueDeps, glab?: GlabRunner): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      const task = await new GitLabTaskFetcher(deps.project, glab).fetch(issueRef);
      return { task };
    },
    taskId: (task: Task) => `gl-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    closeIssueOnMerge: true,
    reviewCli: 'glab',
    publishVerdict: (input: PublishVerdictInput) => publishGitlabVerdict(deps.project, input, glab),
    addFailureLabel: (mrUrl: string, kind: ProofFailureKind) => addGitlabFailureLabel(deps.project, mrUrl, kind, glab),
    addGateConfigLabel: (mrUrl: string) => addGitlabGateConfigLabel(deps.project, mrUrl, glab),
    async linkPr(issueRef: string, _task: Task, mrUrl: string) {
      await linkMergeRequest(deps.project, issueRef, mrUrl, glab);
    },
    async signalSecretBlock(issueRef: string, _task: Task, block: SecretBlock) {
      // `glab issue update --label` is a silent no-op on a project lacking the label (see
      // addMrFailureLabel), which would leave the held issue with no Taskcell label at all. Ensure
      // it first; every step stays best-effort.
      const label = (glab ?? defaultGlabRunner)(['label', 'create', '--repo', deps.project, '--name', GITLAB_SECRET_BLOCKED_LABEL])
        .catch(() => undefined)
        .then(() => editGitlabLabels(deps.project, issueRef, { add: [GITLAB_SECRET_BLOCKED_LABEL] }, glab))
        .catch(() => undefined);
      // No recovery procedure here (the watch primitive that holds the issue posts the resume line).
      await Promise.all([label, commentGitlabIssue(deps.project, issueRef, renderSecretBlockComment(block), glab).catch(() => undefined)]);
    },
    async signalBaseRed(issueRef: string, _task: Task, body: string) {
      // Note only, no label (see SourceAdapter); best-effort, like every other issue write-back.
      await commentGitlabIssue(deps.project, issueRef, body, glab).catch(() => undefined);
    },
  };
}

/**
 * Post the reviewer verdict (+ optional conformance section) as a note on a GitLab MR. Shared by
 * every source whose review surface is GitLab; `project` resolves a bare MR iid.
 */
export async function publishGitlabVerdict(project: string, input: PublishVerdictInput, glab?: GlabRunner): Promise<void> {
  if (input.reviewerOutcome === undefined) {
    throw new Error(`publishVerdict: no reviewer outcome for ${input.prUrl} — silence is not ok`);
  }
  const target = parseMergeRequestRef(input.prUrl, project);
  const verdictText = input.reviewerOutcome.result.finalText;
  // Build the comment body with attribution header and MR dedupe marker.
  const body = stripReviewMarkers(verdictText.replace(/<promise>\s*COMPLETE\s*<\/promise>/gi, '')).trim();
  const sha7 = input.headSha.slice(0, 7);
  const header = `Reviewed by ${input.attribution} @ ${sha7}`;
  // The glab user writes this note, so its marker would make review-mr skip the head for good: an
  // incomplete review gets none.
  const completed = input.reviewerOutcome.result.completed;
  const visible = !completed
    ? `${REVIEW_HEADING}\n\n${header}: ${REVIEW_INCOMPLETE}${body === '' ? '' : `\n\n${body}`}`
    : body === ''
      ? `${REVIEW_HEADING}\n\n${header}: no blocking issues`
      : `${REVIEW_HEADING}\n\n${header}:\n\n${body}`;
  let commentBody = completed ? `${visible}\n\n${mergeRequestReviewMarker(input.headSha)}` : visible;

  const conformanceResult = input.conformanceOutcome?.result;
  if (conformanceResult !== undefined) {
    const section = renderConformanceSection(conformanceResult);
    if (section !== undefined) {
      commentBody = `${commentBody}\n\n## Conformance\n\n${section}`;
    }
  }

  // Gate degrades to a plain note on GitLab — no --request-changes equivalent.
  // Warn when blocking findings exist so silence ≠ enforcement.
  if (input.gate === true) {
    const conformanceGateText = conformanceResult?.completed === false ? undefined : conformanceResult?.finalText;
    const blocking =
      hasBlockingFinding(verdictText) || (conformanceGateText !== undefined && hasBlockingFinding(conformanceGateText));
    if (blocking) {
      commentBody = `${commentBody}\n\n> ⚠️ Blocking findings detected — review gate is not enforced on GitLab (no \`--request-changes\` equivalent). Please review manually.`;
    }
  }

  await postMergeRequestNote(target, commentBody, glab);
}

/** Add a proof-failure label to a GitLab MR; `project` resolves a bare MR iid. */
export async function addGitlabFailureLabel(
  project: string,
  mrUrl: string,
  kind: ProofFailureKind,
  glab?: GlabRunner,
): Promise<void> {
  const label = gitlabFailureLabel(kind);
  // Best-effort: a bad URL must never block the run (publishGitlabVerdict uses the same parser).
  let target: MergeRequestReviewTarget;
  try {
    target = parseMergeRequestRef(mrUrl, project);
  } catch {
    return;
  }
  await addMrFailureLabel(target.project, target.iid, label, glab);
}

/**
 * Flag a GitLab MR as touching gate config; `project` resolves a bare MR iid. Unlike
 * addGitlabFailureLabel nothing is swallowed — not a bad URL, not a failed flip (see
 * SourceAdapter#addGateConfigLabel).
 */
export async function addGitlabGateConfigLabel(project: string, mrUrl: string, glab?: GlabRunner): Promise<void> {
  const target = parseMergeRequestRef(mrUrl, project);
  await addMrGateLabel(target.project, target.iid, GITLAB_GATE_CONFIG_LABEL, glab);
}

/**
 * Run one GitLab issue end to end: fetch via `glab`, run the canonical implement/review/simplify
 * pipeline (plus optional conformance), open a draft MR, publish the reviewer verdict, and comment
 * the MR link back onto the issue.
 */
export async function runGitlabIssue(issueRef: string, deps: RunGitlabIssueDeps): Promise<RunGitlabIssueResult> {
  return runSourcedIssue(issueRef, deps, gitlabAdapter(deps));
}

/** Extract `group/project` from a scp-like SSH remote or any `scheme://` remote URL (HTTPS, `ssh://` with a port). */
export function parseGitlabProjectFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed.includes('://')) return trimmed.match(/^[^:]+:(.+?)(?:\.git)?\/*$/)?.[1];
  try {
    return new URL(trimmed).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The GitLab project a git remote URL points at, or undefined for a known non-GitLab host
 * (GitHub, Bitbucket, Azure DevOps) or an unparseable URL. Any other host counts as GitLab,
 * so self-hosted instances are detected.
 */
export function gitlabProjectFromRemote(remoteUrl: string): string | undefined {
  const host = remoteHostname(remoteUrl);
  if (host !== undefined && /(^|\.)(github\.com|bitbucket\.org|dev\.azure\.com)$/.test(host)) return undefined;
  return parseGitlabProjectFromRemote(remoteUrl);
}

/** A remote URL fit for logs: `scheme://user:token@host/...` loses its userinfo (CI remotes carry a job token). */
export function redactRemote(remoteUrl: string): string {
  // Greedy to the last `@` before the path, so an unencoded `@` in the password cannot leave a fragment.
  return remoteUrl.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

/** Lower-cased hostname of a URL or a bare `host[:port]` (a GITLAB_HOST value), without scheme, user or port. */
function hostnameOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  // scp-like `user@host:path`, or a bare `host[:port]`.
  return /^(?:[^@/]+@)?([^:/]+)/.exec(trimmed)?.[1]?.toLowerCase();
}

/**
 * Lower-cased host of a git remote, or undefined for a local path. Git reads a remote without a scheme
 * as scp-like only when a colon comes before any slash; `../mirror.git` or `mirror.git` is a path.
 */
export function remoteHostname(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed.includes('://')) return hostnameOf(trimmed);
  return /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed)?.[1]?.toLowerCase();
}

/**
 * Whether a remote's host is GitLab by explicit signal: gitlab.com, or the host in glab's
 * GITLAB_HOST. Stricter than gitlabProjectFromRemote because it serves sources whose review surface
 * defaults to GitHub (Linear): a GitHub Enterprise or other unknown host must keep that default.
 */
export function isKnownGitlabRemote(remoteUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = remoteHostname(remoteUrl);
  if (host === undefined) return false;
  const selfHosted = env.GITLAB_HOST === undefined ? undefined : hostnameOf(env.GITLAB_HOST);
  return host === 'gitlab.com' || host === selfHosted;
}

/**
 * The GitLab project the `origin` remote of `repoPath` points at when isKnownGitlabRemote accepts
 * it; undefined for any other host or when origin is unreadable (preflight then checks gh, too).
 * Throws when origin is on GitLab but names no project: falling back to gh would publish to the
 * wrong forge after the agent work is done.
 */
export async function knownGitlabProjectFromOrigin(repoPath: string): Promise<string | undefined> {
  let origin: string;
  try {
    origin = (await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })).stdout;
  } catch {
    return undefined;
  }
  if (!isKnownGitlabRemote(origin)) return undefined;
  const project = parseGitlabProjectFromRemote(origin);
  if (project === undefined) throw new Error(`origin ${redactRemote(origin)} is on GitLab but names no group/project; fix the remote.`);
  return project;
}

/** Assemble `RunGitlabIssueDeps` from environment + CLI flags (mirrors `githubDepsFromEnv`). */
export async function gitlabDepsFromEnv(repoPath: string, project: string | undefined, choice: ProviderChoice = {}, env: NodeJS.ProcessEnv = process.env): Promise<RunGitlabIssueDeps> {
  // Resolve auth first (mirrors githubDepsFromEnv order), so a missing-credential error surfaces
  // before git-remote detection. Without this, deps.auth is undefined and runSourcedIssue injects
  // no token into the sandbox — `run --gitlab` agents fail "Not logged in". The whole choice, so a
  // claude fallback behind a codex implementer gets its credential too.
  const auth = agentAuthFromEnv(choice, env);
  let resolvedProject = project;
  if (resolvedProject === undefined) {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const remote = stdout.trim();
    resolvedProject = gitlabProjectFromRemote(remote);
    if (resolvedProject === undefined) {
      throw new Error(`Cannot detect a GitLab project from the origin remote (${redactRemote(remote)}). Pass --gitlab-project explicitly.`);
    }
  }
  return {
    ...(auth !== undefined ? { auth } : {}),
    repoPath,
    project: resolvedProject,
    ...(choice.provider !== undefined ? { provider: choice.provider } : {}),
    ...(choice.reviewProvider !== undefined ? { reviewProvider: choice.reviewProvider } : {}),
  };
}

export interface WatchGitlabOptions {
  deps: RunGitlabIssueDeps;
  /** Trigger label: open issues carrying this label are picked for running. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label`.
   * Absent => only `label` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (trigger label removed) so re-polls skip it. */
  claimedLabel: string;
  /** Label added after an MR opens (claimed label auto-removed by GitLab scoped-label rule when same scope). */
  reviewLabel: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + swapped to this label and NO implement budget is spent.
   * Absent => behaviour is unchanged (no triage, straight to runGitlabIssue).
   */
  needsInfoLabel?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  /** Injectable runner for tests. Defaults to `defaultGlabRunner`. */
  gl?: GlabRunner;
}

/** GitLab issue primitives: trigger by label, claim/review by swapping scoped labels. */
export function gitlabWatchPrimitives(opts: WatchGitlabOptions): WatchPrimitives {
  const project = opts.deps.project;
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = new GitLabTaskFetcher(project, glab);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  // Ready issues still carrying the hold label from an earlier secret block (re-triggered by a
  // human): the claim clears it too. See githubIssueWatchPrimitives.
  const heldBefore = new Set<string>();
  return {
    listReady: async () => {
      const tasks = await applyGitlabDependencyGate(await fetcher.list({ labels: agentLabels }), {
        project,
        trigger: opts.label,
        ...(needsInfoLabel !== undefined ? { needsInfoLabel } : {}),
        glab,
      });
      heldBefore.clear();
      for (const task of tasks) if (hasLabel(task.labels, GITLAB_SECRET_BLOCKED_LABEL)) heldBefore.add(task.id);
      return tasks.map((task) => ({ id: task.id }));
    },
    claim: (id) =>
      // Explicitly remove trigger label so future polls don't pick it up again.
      // GitLab scoped :: only auto-removes within the same scope prefix.
      editGitlabLabels(
        project,
        id,
        { remove: heldBefore.has(id) ? [opts.label, GITLAB_SECRET_BLOCKED_LABEL] : [opts.label], add: [opts.claimedLabel] },
        glab,
      ),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGitlabIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGitlabIssue(i, opts.deps), {
              comment: (body) => commentGitlabIssue(project, id, body, glab),
              toNeedsInfo: () =>
                editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, glab),
            }, opts.deps.feedbackAuthors),
    review: (id) =>
      // Explicitly remove claimedLabel for robustness when non-scoped labels are configured.
      editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, glab),
    onNoChange: async (id) => {
      await commentGitlabIssue(project, id, NO_CHANGE_MSG, glab);
      await editGitlabLabels(project, id, { remove: [opts.claimedLabel] }, glab);
    },
    // One edit swaps claimed -> secret-blocked so the claim is never released without the hold
    // label landing. `glab issue update --label` is a silent no-op on a project lacking the label
    // (the `--unlabel` in the same call still lands, releasing the claim with no hold), and the
    // adapter only pre-creates it when it posts findings (not in white-label mode), so ensure it
    // here first (best-effort, as addMrFailureLabel does). A failing swap throws into onFailure
    // and the claimed marker stays. Trigger label not restored (removed on claim); the note names
    // the label to re-apply. Same in white-label mode (see githubIssueWatchPrimitives).
    onSecretBlocked: async (id) => {
      await glab(['label', 'create', '--repo', project, '--name', GITLAB_SECRET_BLOCKED_LABEL]).catch(() => undefined);
      await editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [GITLAB_SECRET_BLOCKED_LABEL] }, glab);
      await commentGitlabIssue(
        project,
        id,
        holdMessage(`Swapped \`${opts.claimedLabel}\` for \`${GITLAB_SECRET_BLOCKED_LABEL}\`.`, `re-apply the \`${opts.label}\` label`),
        glab,
      );
    },
    onFailure: (id, error) =>
      commentGitlabIssue(project, id, failureOrCapComment('Taskcell run failed', error), glab),
  };
}

export interface WatchGitlabSpecOptions {
  /** Deps for the spec generator (no MR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  /** GitLab project path, e.g. `group/project`. */
  project: string;
  /** Trigger label: open issues with this label are picked for speccing. */
  specLabel: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `specLabel`.
   * Absent => only `specLabel` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (spec label removed) so re-polls skip it. */
  claimedLabel: string;
  /** Label added after a spec is generated — the agent-pass trigger. */
  agentLabel: string;
  /** Label added when triage flags the ticket as too vague. */
  needsInfoLabel: string;
  gl?: GlabRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * GitLab-issue SPEC primitives: trigger by label, triage each issue, then either generate+post a tech
 * spec and swap to the agent label, or request clarification and swap to needs-info. On failure the
 * trigger label is restored so a later poll retries it.
 */
export function gitlabSpecPrimitives(opts: WatchGitlabSpecOptions): SpecWatchPrimitives {
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () =>
      (await applyGitlabDependencyGate(await fetcher.list({ labels: specLabels }), { project: opts.project, trigger: opts.specLabel, needsInfoLabel: opts.needsInfoLabel, glab })).map((task) => ({ id: task.id })),
    claim: (id) =>
      editGitlabLabels(opts.project, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, glab),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGitlabIssue(opts.project, id, body, glab),
        advance: () =>
          editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.agentLabel] }, glab),
        toNeedsInfo: () =>
          editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] }, glab),
      });
    },
    onFailure: async (id, error) => {
      await commentGitlabIssue(opts.project, id, failureOrCapComment('Taskcell spec failed', error), glab);
      // Restore spec label so next poll retries
      await editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, glab);
    },
  };
}
