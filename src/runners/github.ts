import { execa } from 'execa';
import { GitHubTaskFetcher, linkPullRequest, addPrFailureLabel, addPrGateLabel, editGithubLabels, commentGithubIssue, defaultGhRunner, isTrustedIssueAuthor } from '../tasks/github.js';
import { describeIgnoredAuthor } from '../tasks/comment-trust.js';
import { applyDependencyGate } from '../tasks/dependencies.js';
import { createOverlapChecker, overlapHoldMs } from '../tasks/overlap.js';
import { formatFailureComment } from '../core/errors.js';
import { isRateLimitHold, rateLimitHold } from '../core/rate-limit-marker.js';
import { UsageCapError } from '../core/usage-cap.js';
import { hasLabel } from '../core/labels.js';
import { runSpecGenerator } from './spec.js';
import { NO_CHANGE_MSG, holdMessage, commentAndRevert, failureOrCapComment, runSpecCore, triageAgentRun } from './watch-shared.js';
import type { WatchPrimitives, SpecWatchPrimitives, GenerateSpec } from './watch-shared.js';
import type { RunSpecGeneratorDeps } from './spec.js';
import { GitHubProjectFetcher } from '../tasks/github-project.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { publishReviewVerdict } from '../pipeline/review-publish.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { fanOut } from '../pipeline/fan-out.js';
import { runSourcedIssue } from './source-adapter.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { githubFailureLabel, GITHUB_GATE_CONFIG_LABEL, GITHUB_SECRET_BLOCKED_LABEL, GITHUB_RATE_LIMITED_LABEL } from '../github-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { GhRunner } from '../tasks/github.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SecretBlock } from '../core/secret-scan.js';
import { tokenProviderFor } from '../core/push-token.js';
import type { RunIssueDeps, RunIssueResult, Tracker, ReviewHost, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single GitHub issue end to end. */
export interface RunGithubIssueDeps extends RunIssueDeps {
  repoSlug: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld PR is not read as "no changes". */
export type RunGithubIssueResult = RunIssueResult;

/** The GitHub review host (`gh`): draft PR, verdict comment and labels. Shared by every source whose result is a GitHub PR. */
export function githubReviewHost(repoPath: string): ReviewHost {
  return {
    kind: 'gh',
    // Same PAT revise pushes with: a PR it opens fires the repo's pull_request workflows (CI).
    // Minted (App) or read (PAT) at each use, never cached: an App token lives 1 h, a run up to 180 min.
    newPrTarget: (pr) => ({ kind: 'new-pr', ...pr, cli: 'gh', tokenProvider: tokenProviderFor(repoPath) }),
    publishVerdict: publishReviewVerdict,
    async addFailureLabel(prUrl: string, kind: ProofFailureKind) {
      await addPrFailureLabel(repoPath, prUrl, githubFailureLabel(kind));
    },
    async addGateConfigLabel(prUrl: string) {
      await addPrGateLabel(repoPath, prUrl, GITHUB_GATE_CONFIG_LABEL);
    },
  };
}

/**
 * @internal Exported for unit tests; production callers use runGithubIssue. Only the issue
 * write-backs go through the injected `gh`; `prepare` and `linkPr` still reach the real CLI.
 */
export function githubTracker(deps: RunGithubIssueDeps, gh: GhRunner = defaultGhRunner): Tracker {
  return {
    async prepare(issueRef: string) {
      const task = await new GitHubTaskFetcher(deps.repoSlug).fetch(issueRef);
      return { task };
    },
    taskId: (task) => `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    closeIssueOnMerge: true,
    async linkPr(issueRef: string, _task: Task, prUrl: string) {
      await linkPullRequest(deps.repoSlug, issueRef, prUrl);
    },
    async signalSecretBlock(issueRef: string, _task: Task, block: SecretBlock) {
      // `gh issue edit --add-label` fails on a repo that never created the label, which would leave
      // the held issue with no Taskcell label at all. The edit creates it when the repo has neither
      // spelling (forced when the labels cannot be listed); every step stays best-effort.
      const label = editGithubLabels(deps.repoSlug, issueRef, { add: [GITHUB_SECRET_BLOCKED_LABEL], ensure: [GITHUB_SECRET_BLOCKED_LABEL] }, gh)
        .catch(() => undefined);
      // No recovery procedure here: this tracker also serves one-shot `taskcell run` and Projects,
      // whose release steps differ. The watch primitive that holds the issue posts the resume line.
      await Promise.all([label, commentGithubIssue(deps.repoSlug, issueRef, renderSecretBlockComment(block), gh).catch(() => undefined)]);
    },
    async signalBaseRed(issueRef: string, _task: Task, body: string) {
      // Comment only, no label (see Tracker); best-effort, like every other issue write-back.
      await commentGithubIssue(deps.repoSlug, issueRef, body, gh).catch(() => undefined);
    },
  };
}

/**
 * Run one GitHub issue end to end: fetch via `gh`, run the canonical implement/review/simplify
 * pipeline (the issue title/body go in as variables — no skill needed), open a draft PR, and comment
 * the PR link back onto the issue. GitHub is both the source and the review surface.
 */
export async function runGithubIssue(issueRef: string, deps: RunGithubIssueDeps): Promise<RunGithubIssueResult> {
  return runSourcedIssue(issueRef, deps, githubTracker(deps), githubReviewHost(deps.repoPath));
}

/**
 * Board tasks whose `owner/repo#N` id belongs to `repoSlug` (case-insensitive). runGithubIssue is
 * pinned to the configured repo, so an item from another repo would run the local issue with the
 * same number; those are skipped with a warning, as the board watch does.
 */
export function sameRepoTasks(tasks: Task[], repoSlug: string): Task[] {
  return tasks.filter((task) => {
    const itemRepo = task.id.slice(0, task.id.lastIndexOf('#'));
    if (itemRepo.toLowerCase() === repoSlug.toLowerCase()) return true;
    console.warn(`taskcell: project item ${task.id} belongs to another repository than ${repoSlug}; skipped`);
    return false;
  });
}

/**
 * Run every issue on a GitHub Projects v2 board (optionally filtered by label) as its own run + PR,
 * concurrently and with failure isolation. The owner defaults to the repo slug's owner.
 */
export async function runGithubProject(
  deps: RunGithubIssueDeps,
  opts: { projectNumber: number; owner?: string; label?: string; concurrency?: number },
): Promise<{ tasks: Task[]; outcomes: FanOutOutcome<Task, RunGithubIssueResult>[] }> {
  const owner = opts.owner ?? (deps.repoSlug.split('/')[0] as string);
  const fetcher = new GitHubProjectFetcher({ owner, projectNumber: opts.projectNumber, repo: deps.repoSlug });
  const tasks = sameRepoTasks(await fetcher.list(opts.label !== undefined ? { labels: [opts.label] } : undefined), deps.repoSlug);
  const outcomes = await fanOut(tasks, (task) => runGithubIssue(task.id, deps), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return { tasks, outcomes };
}

/** Read the run dependencies from the environment (+ flag overrides), resolving the repo slug from origin. */
export async function githubDepsFromEnv(repoPath: string, repoSlug?: string, choice: ProviderChoice = {}, env: NodeJS.ProcessEnv = process.env): Promise<RunGithubIssueDeps> {
  // The whole choice, so every provider that may run (reviewer, implementer fallback) is counted
  // when deciding whether the Anthropic credential must be injected.
  const auth = agentAuthFromEnv(choice, env);
  const slug = repoSlug ?? process.env.GITHUB_REPO ?? (await detectRepoSlug(repoPath));
  return { ...(auth !== undefined ? { auth } : {}), repoPath, repoSlug: slug };
}

/** Extract the owner/repo slug from the origin remote. */
export async function detectRepoSlug(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd });
  const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match?.[1] === undefined) throw new Error(`Could not detect repo from origin: ${stdout.trim()}`);
  return match[1];
}

export interface WatchGithubOptions {
  deps: RunGithubIssueDeps;
  /** Trigger label: open issues with this label are picked. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label` to be listed
   * as ready. Absent => only `label` is required (existing single-loop behaviour unchanged).
   * Used in loop-v1 so the `--label` (e.g. 'vanguard') ownership requirement is enforced even though
   * the routing labels (agent/spec trigger) already filter the query.
   */
  ownerLabel?: string;
  /** Label added on claim (and the trigger label removed) so re-polls skip it, e.g. 'taskcell:running'. */
  claimedLabel: string;
  /** Other repos (`owner/repo`) a dependency may be read from, besides the watched repo. */
  dependencyRepos?: readonly string[];
  /** Label added after a PR opens, e.g. 'taskcell:needs-human-review'. */
  reviewLabel: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + swapped to this label (claimed removed) and NO implement budget
   * is spent (returns no PR). Absent => behaviour is unchanged (no triage, straight to runGithubIssue).
   */
  needsInfoLabel?: string;
  /**
   * Run only this issue (owner/repo#n or a bare number) instead of listing every issue carrying the
   * trigger label(s). Fetched directly — no label-search index lag — and gated exactly as a listed
   * issue would be: open state, required labels, author trust, and not already claimed by another
   * run (best effort; the claim is what settles a race).
   */
  issueRef?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/**
 * Mark a GitHub issue rate-limited: add `taskcell:rate-limited` (creating the label first — a repo
 * that never created it would otherwise fail the edit and strand the issue claimed), clear the
 * claim label the failed run left behind, and post the marker comment naming the trigger that
 * restarts this stage. The trigger label itself is left off until `resume-rate-limited` restores it
 * once `until` has passed — restoring it now would let the very next poll retry into the same limit.
 * The caller's usual failure comment is kept and the rate-limit note appended to it: the limit
 * explains why the stage stopped, but only the failure text (and its stack) says where it was when
 * it did.
 */
async function markGithubIssueRateLimited(
  repo: string,
  id: string,
  claimedLabel: string,
  trigger: string,
  failureComment: string,
  error: Error,
  gh?: GhRunner,
  log?: (msg: string) => void,
): Promise<void> {
  const hold = rateLimitHold(error, trigger);
  await editGithubLabels(repo, id, { remove: [claimedLabel], add: [GITHUB_RATE_LIMITED_LABEL], ensure: [GITHUB_RATE_LIMITED_LABEL] }, gh, log);
  // A usage-cap pause is not a failure: only the hold notice, no "run failed" text.
  await commentGithubIssue(repo, id, error instanceof UsageCapError ? hold.comment : `${failureComment}\n\n${hold.comment}`, gh);
}

/**
 * Drop ready GitHub issues whose author is not trusted (OWNER/MEMBER/COLLABORATOR, --feedback-authors or
 * a GitHub App bot). A label alone is not consent: issue templates can apply the trigger label to an
 * outsider's issue. Applied to both passes, so the spec pass never advances one into the agent pass.
 */
async function withTrustedIssueAuthors(
  repo: string,
  tasks: Task[],
  allowedAuthors: readonly string[] | undefined,
  gh: GhRunner | undefined,
): Promise<Task[]> {
  const verdicts = await Promise.all(tasks.map((task) => isTrustedIssueAuthor(repo, task.ref ?? task.id, allowedAuthors, gh)));
  return tasks.filter((task, i) => {
    const verdict = verdicts[i]!;
    if (verdict.trusted) return true;
    if (verdict.error !== undefined) {
      console.log(`taskcell: ${task.id} skipped -> author lookup failed: ${verdict.error}`);
      return false;
    }
    console.log(`taskcell: ${task.id} skipped -> issue author ${describeIgnoredAuthor(verdict.author || '?', verdict.association)} is not trusted (repo member or --feedback-authors)`);
    return false;
  });
}

/**
 * Fetch the `--issue`-named issue directly (no label-search index lag) and gate it exactly as a
 * listed issue would be: it must be open (the sweep's `--state open`), carry the required trigger
 * label(s), and not already carry `claimedLabel` — another run claimed it first, so this one skips
 * it with a log line. That skip is best effort: the claim's label swap is what actually catches a
 * run that claimed between this fetch and the claim. Returns zero or one task; downstream (author
 * trust, held/rate-limited bookkeeping) treats it identically to a bulk list() result. A failed
 * fetch is NOT swallowed — it throws, so an unreachable or misnamed issue fails the run instead of
 * reporting "0 ready".
 */
async function fetchHintedIssue(
  fetcher: { fetch: (id: string) => Promise<Task> },
  ref: string,
  requiredLabels: string[],
  claimedLabel: string,
): Promise<Task[]> {
  const task = await fetcher.fetch(ref);
  if (task.state !== undefined && task.state.toUpperCase() !== 'OPEN') {
    console.log(`vanguard: ${task.id} skipped -> issue is ${task.state.toLowerCase()}, not open`);
    return [];
  }
  if (hasLabel(task.labels, claimedLabel)) {
    console.log(`vanguard: ${task.id} skipped -> already "${claimedLabel}" (claimed by another run)`);
    return [];
  }
  const missing = requiredLabels.filter((label) => !hasLabel(task.labels, label));
  if (missing.length > 0) {
    console.log(`vanguard: ${task.id} skipped -> missing label${missing.length > 1 ? 's' : ''} ${missing.map((label) => `"${label}"`).join(', ')}`);
    return [];
  }
  return [task];
}

/** GitHub-issue primitives: trigger by label, claim/review by swapping labels (issues have no states). */
export function githubIssueWatchPrimitives(opts: WatchGithubOptions, log?: (msg: string) => void): WatchPrimitives {
  const repo = opts.deps.repoSlug;
  const fetcher = new GitHubTaskFetcher(repo, opts.gh);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  // Ready issues still carrying the hold label from an earlier secret block: a human re-triggered
  // them, so the claim clears it too. Only for issues seen with the label — a blind `--remove-label`
  // makes `gh issue edit` fail in a repo that never created it.
  const heldBefore = new Set<string>();
  const rateLimitedBefore = new Set<string>();
  return {
    listReady: async () => {
      const listed =
        opts.issueRef !== undefined
          ? await fetchHintedIssue(fetcher, opts.issueRef, agentLabels, opts.claimedLabel)
          : await fetcher.list({ labels: agentLabels });
      const trusted = await withTrustedIssueAuthors(repo, listed, opts.deps.feedbackAuthors, opts.gh);
      const tasks = await applyDependencyGate(trusted, {
        repo,
        trigger: opts.label,
        ...(opts.dependencyRepos !== undefined ? { dependencyRepos: opts.dependencyRepos } : {}),
        ...(needsInfoLabel !== undefined ? { needsInfoLabel } : {}),
        ...(opts.gh !== undefined ? { gh: opts.gh } : {}),
        overlap: {
          holdMs: overlapHoldMs(),
          check: createOverlapChecker({
            repo,
            claimedLabel: opts.claimedLabel,
            fetch: (id) => fetcher.fetch(id),
            list: (labels, limit) => fetcher.list({ labels, limit }),
            ...(opts.gh !== undefined ? { gh: opts.gh } : {}),
          }),
        },
      });
      heldBefore.clear();
      for (const task of tasks) if (hasLabel(task.labels, GITHUB_SECRET_BLOCKED_LABEL)) heldBefore.add(task.id);
      rateLimitedBefore.clear();
      for (const task of tasks) if (hasLabel(task.labels, GITHUB_RATE_LIMITED_LABEL)) rateLimitedBefore.add(task.id);
      return tasks.map((task) => ({ id: task.id }));
    },
    // A claim releases every hold the issue carried: a rate-limit hold left on would make the resume
    // sweep re-trigger work that this run is already doing.
    claim: (id) =>
      editGithubLabels(
        repo,
        id,
        {
          remove: [
            opts.label,
            ...(heldBefore.has(id) ? [GITHUB_SECRET_BLOCKED_LABEL] : []),
            ...(rateLimitedBefore.has(id) ? [GITHUB_RATE_LIMITED_LABEL] : []),
          ],
          add: [opts.claimedLabel],
        },
        opts.gh,
        log,
      ),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGithubIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGithubIssue(i, opts.deps), {
              comment: (body) => commentGithubIssue(repo, id, body, opts.gh),
              toNeedsInfo: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, opts.gh, log),
            }, opts.deps.feedbackAuthors),
    review: (id) => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, opts.gh, log),
    onNoChange: (id) =>
      commentAndRevert(
        commentGithubIssue(repo, id, NO_CHANGE_MSG, opts.gh),
        editGithubLabels(repo, id, { remove: [opts.claimedLabel] }, opts.gh, log),
      ),
    // The trigger label was removed on claim, so dropping the claim leaves the issue idle until a
    // human re-applies the trigger — what the base-red comment asks for. No no-change comment.
    onBaseRed: (id) => editGithubLabels(repo, id, { remove: [opts.claimedLabel] }, opts.gh, log),
    // One edit swaps claimed -> secret-blocked, so the claim is never released without the hold
    // label landing. `gh issue edit --add-label` fails on a label the repo never created, so the edit
    // creates it when the repo has neither spelling (forced when the labels cannot be listed;
    // best-effort, as in addPrFailureLabel). If the swap fails it throws
    // into onFailure and the claimed marker stays. The trigger label was removed on claim and is
    // not restored; the comment names the label to re-apply. Same in white-label mode: the claim
    // label is already the watch's own marker, and a white-label tracker posts no findings, so this
    // comment is the human's only signal.
    onSecretBlocked: async (id) => {
      await editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [GITHUB_SECRET_BLOCKED_LABEL], ensure: [GITHUB_SECRET_BLOCKED_LABEL] }, opts.gh, log);
      await commentGithubIssue(
        repo,
        id,
        holdMessage(`Swapped \`${opts.claimedLabel}\` for \`${GITHUB_SECRET_BLOCKED_LABEL}\`.`, `re-apply the \`${opts.label}\` label`),
        opts.gh,
      );
    },
    onFailure: async (id, error) => {
      const comment = formatFailureComment('Taskcell run failed', error);
      if (isRateLimitHold(error)) {
        await markGithubIssueRateLimited(repo, id, opts.claimedLabel, opts.label, comment, error, opts.gh, log);
        return;
      }
      await commentGithubIssue(repo, id, comment, opts.gh);
    },
  };
}

export interface WatchGithubSpecOptions {
  /** Other repos (`owner/repo`) a dependency may be read from, besides the watched repo. */
  dependencyRepos?: readonly string[];
  /** Deps for the spec generator (no PR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  /** owner/repo the issues live in (the spec deps' fetcher is used to read them). */
  repoSlug: string;
  /** Trigger label: open issues with this label are picked for speccing. */
  specLabel: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `specLabel` to be
   * listed as ready for the spec pass. Absent => only `specLabel` is required (existing behaviour).
   * Used in loop-v1 so the `--label` (e.g. 'vanguard') ownership requirement is enforced on top of
   * the spec-trigger routing label. Claim/advance/needs-info are unaffected — they swap only the
   * routing labels, leaving the ownership label intact on the issue.
   */
  ownerLabel?: string;
  /** Label added on claim (and the spec label removed) so re-polls skip it, e.g. 'taskcell:speccing'. */
  claimedLabel: string;
  /** Label added after a spec is generated — the agent-pass trigger, e.g. 'vanguard'. */
  agentLabel: string;
  /** Label added when triage flags the ticket as too vague, e.g. 'taskcell:needs-info'. */
  needsInfoLabel: string;
  /**
   * Run only this issue (owner/repo#n or a bare number) instead of listing every issue carrying the
   * spec trigger label(s). Same gating as `WatchGithubOptions.issueRef`, against the spec claimed
   * label (e.g. 'taskcell:speccing').
   */
  issueRef?: string;
  gh?: GhRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * GitHub-issue SPEC primitives: trigger by label, triage each issue, then either generate+post a tech
 * spec and swap to the agent label, or request clarification and swap to needs-info. On failure the
 * trigger label is restored so a later poll retries it. (Issues have no states; everything is labels.)
 */
export function githubSpecPrimitives(opts: WatchGithubSpecOptions, log?: (msg: string) => void): SpecWatchPrimitives {
  const repo = opts.repoSlug;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () => {
      const listed =
        opts.issueRef !== undefined
          ? await fetchHintedIssue(fetcher, opts.issueRef, specLabels, opts.claimedLabel)
          : await fetcher.list({ labels: specLabels });
      const trusted = await withTrustedIssueAuthors(repo, listed, opts.deps.feedbackAuthors, opts.gh);
      // Gate here too: a blocked issue must never be specced or advanced (a --once run carries
      // advanced ids straight into the agent pass, past its own gate).
      const tasks = await applyDependencyGate(trusted, {
        repo,
        trigger: opts.specLabel,
        needsInfoLabel: opts.needsInfoLabel,
        ...(opts.dependencyRepos !== undefined ? { dependencyRepos: opts.dependencyRepos } : {}),
        ...(opts.gh !== undefined ? { gh: opts.gh } : {}),
      });
      return tasks.map((task) => ({ id: task.id }));
    },
    claim: (id) => editGithubLabels(repo, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, opts.gh, log),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGithubIssue(repo, id, body, opts.gh),
        advance: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.agentLabel] }, opts.gh, log),
        toNeedsInfo: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] }, opts.gh, log),
      });
    },
    onFailure: async (id, error) => {
      const comment = formatFailureComment('Taskcell spec failed', error);
      if (isRateLimitHold(error)) {
        await markGithubIssueRateLimited(repo, id, opts.claimedLabel, opts.specLabel, comment, error, opts.gh, log);
        return;
      }
      await commentGithubIssue(repo, id, comment, opts.gh);
      await editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, opts.gh, log);
    },
  };
}

export interface WatchGithubProjectOptions {
  deps: RunGithubIssueDeps;
  projectNumber: number;
  /** Owner of the project (default: first segment of deps.repoSlug). */
  owner?: string;
  /** Only pick up board items with this label (optional). */
  label?: string;
  /** Status option name for ready-to-run items (e.g. 'Todo'). */
  triggerStatus: string;
  /** Status option name set on claim so re-polls skip the item. */
  claimedStatus: string;
  /** Status option name set after a PR opens. */
  reviewStatus: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/**
 * GitHub Projects v2 primitives: trigger by Status field value, claim/review by updating the Status
 * field via `gh project item-edit`. Field and option IDs are resolved once via `gh project field-list`
 * and `gh project view` and then cached for the lifetime of the primitives object.
 *
 * The Status option names (triggerStatus / claimedStatus / reviewStatus) must match the exact names
 * configured on the project's Status field — find them with:
 *   gh project field-list <projectNumber> --owner <owner> --format json
 */
interface ProjectMeta {
  projectNodeId: string;
  statusFieldId: string;
  statusOptionIds: Map<string, string>;
}

export function githubProjectWatchPrimitives(opts: WatchGithubProjectOptions, log?: (msg: string) => void): WatchPrimitives {
  const gh = opts.gh ?? defaultGhRunner;
  const owner = opts.owner ?? (opts.deps.repoSlug.split('/')[0] as string);
  const repo = opts.deps.repoSlug;
  const projectNumber = String(opts.projectNumber);

  // Populated on each listReady call; claim/review look up the project item node ID here.
  const itemNodeIds = new Map<string, string>();
  // Ready items still carrying the hold label from an earlier secret block; cleared on claim.
  const heldBefore = new Set<string>();

  // Single cached promise: fetches project node ID and Status field in parallel, resolved once.
  let projectMeta: Promise<ProjectMeta> | undefined;

  function getProjectMeta(): Promise<ProjectMeta> {
    if (projectMeta === undefined) {
      projectMeta = Promise.all([
        gh(['project', 'view', projectNumber, '--owner', owner, '--format', 'json'])
          .then((out) => (JSON.parse(out) as { id: string }).id),
        gh(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']).then((out) => {
          const parsed = JSON.parse(out) as {
            fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
          };
          const field = parsed.fields.find((f) => f.name === 'Status');
          if (field === undefined) throw new Error(`GitHub project ${opts.projectNumber} has no "Status" field`);
          return { fieldId: field.id, optionIds: new Map(field.options?.map((o) => [o.name, o.id] as [string, string]) ?? []) };
        }),
      ]).then(([projectNodeId, { fieldId: statusFieldId, optionIds: statusOptionIds }]) => ({
        projectNodeId,
        statusFieldId,
        statusOptionIds,
      }));
    }
    return projectMeta;
  }

  async function setStatus(issueRef: string, statusName: string): Promise<void> {
    const { projectNodeId, statusFieldId, statusOptionIds } = await getProjectMeta();
    const nodeId = itemNodeIds.get(issueRef);
    if (nodeId === undefined) throw new Error(`Project item for ${issueRef} not in cache; call listReady first`);
    const optionId = statusOptionIds.get(statusName);
    if (optionId === undefined) throw new Error(`Status option "${statusName}" not found in project ${opts.projectNumber}`);
    await gh(['project', 'item-edit', '--id', nodeId, '--project-id', projectNodeId, '--field-id', statusFieldId, '--single-select-option-id', optionId]);
  }

  return {
    listReady: async () => {
      const out = await gh(['project', 'item-list', projectNumber, '--owner', owner, '--format', 'json', '--limit', '1000']);
      const parsed = JSON.parse(out) as {
        items: Array<{
          id: string;
          status?: string;
          content?: { type?: string; number?: number; repository?: string; labels?: string[] };
        }>;
      };
      itemNodeIds.clear();
      heldBefore.clear();
      const ready: Array<{ id: string }> = [];
      for (const item of parsed.items) {
        const content = item.content;
        if (content === undefined || content.type !== 'Issue' || content.number === undefined) continue;
        const itemRepo = content.repository ?? repo;
        // The run path (runGithubIssue) is pinned to the watched repo: a foreign item would run
        // <repo>#<number>, an issue nobody selected. Skip it and say so.
        if (itemRepo.toLowerCase() !== repo.toLowerCase()) {
          if (item.status === opts.triggerStatus) console.warn(`taskcell: project item ${itemRepo}#${content.number} belongs to another repository than ${repo}; skipped`);
          continue;
        }
        const issueRef = `${itemRepo}#${content.number}`;
        itemNodeIds.set(issueRef, item.id);
        if (item.status !== opts.triggerStatus) continue;
        if (opts.label !== undefined && !hasLabel(content.labels ?? [], opts.label)) continue;
        if (hasLabel(content.labels ?? [], GITHUB_SECRET_BLOCKED_LABEL)) heldBefore.add(issueRef);
        ready.push({ id: issueRef });
      }
      return ready;
    },
    // A re-triggered item (moved back to the trigger status by a human) sheds the hold label from
    // its earlier secret block; only for items listReady saw carrying it (see githubIssueWatchPrimitives).
    // The cleanup is cosmetic and runs after the status move, so it must not throw: claimGate reads
    // any throw as "already claimed" and the item would sit in the claimed status with no run and
    // no comment. The edit goes to the issue's own repo — a board can hold issues from other repos.
    claim: async (id) => {
      await setStatus(id, opts.claimedStatus);
      if (heldBefore.has(id)) {
        await editGithubLabels(id.slice(0, id.indexOf('#')), id, { remove: [GITHUB_SECRET_BLOCKED_LABEL] }, gh, log).catch(() => undefined);
      }
    },
    runOne: (id) => runGithubIssue(id, opts.deps),
    review: (id) => setStatus(id, opts.reviewStatus),
    onNoChange: (id) => commentAndRevert(commentGithubIssue(repo, id, NO_CHANGE_MSG, gh), setStatus(id, opts.triggerStatus)),
    // The only configured statuses are trigger/claimed/review and reverting to the trigger status
    // would re-list the item next poll, so the hold keeps the claimed status; the comment names the
    // status to move back to. The tracker already added the secret-blocked label + masked findings.
    onSecretBlocked: (id) =>
      commentGithubIssue(
        repo,
        id,
        holdMessage(`It stays in "${opts.claimedStatus}" so the watch will not re-run it.`, `move it back to "${opts.triggerStatus}"`),
        gh,
      ),
    onFailure: (id, error) => commentGithubIssue(repo, id, failureOrCapComment('Taskcell run failed', error), gh),
  };
}
