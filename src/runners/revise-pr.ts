import { REVIEW_TRIGGER_LABEL, resolveRemovals } from '../core/labels.js';
import { describeIgnoredAuthor, isTrustedNonAuthorComment } from '../tasks/comment-trust.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parsePullRequestRef, fetchPullRequestForReview, postPullRequestReview, commentPullRequest } from './pr-review.js';
import {
  fetchPullRequestFeedback,
  partitionActionableFeedback,
  buildRevisionPrompt,
  replyAndResolveThread,
  countRevisionRoundsFromFeedback,
  revisionBudgetResetAt,
  revisionCapMarker,
  revisionMarker,
  buildItemReply,
  isConflictItem,
  buildRevisionSummary,
  buildRevisionChecklist,
  parseChecklistAnswers,
  buildRevisionDryRun,
  parseRevisionDiff,
  formatFileChanges,
  describeItemChange,
  guardedPoint,
} from './pr-feedback.js';
import type { FeedbackItem } from './pr-feedback.js';
import { prepareContext, disposeContext, refreshSandboxWorkspace } from '../core/taskcell.js';
import { mergeBaseIntoWorktree, filesWithConflictMarkers, formatConflictFiles } from './base-merge.js';
import type { RunContext } from '../core/taskcell.js';
import { VANGUARD_BRANCH_PREFIX } from '../worktree/manager.js';
import { baseBranchOrDefault } from '../core/base-branch.js';
import { loadLessonsForTask } from '../core/lessons.js';
import { changedFilesOf } from './re-review.js';
import { literalPrompt } from '../context/prompt-engine.js';
import { skillRegistryForRun } from '../context/skill-registry.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback } from '../pipeline/verify.js';
import { reviewRequestBody } from './review-body.js';
import { repairUntilGreen } from '../pipeline/repair-gate.js';
import { beginRun, persistBaseMerge } from '../core/run-store.js';
import { appendStepSummary } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import type { StageOutcome } from '../pipeline/pipeline.js';
import { GITHUB_GATE_CONFIG_LABEL, GITHUB_SECRET_BLOCKED_LABEL, GITHUB_RATE_LIMITED_LABEL } from '../github-labels.js';
import { isRateLimitHold, rateLimitHold } from '../core/rate-limit-marker.js';
import { UsageCapError } from '../core/usage-cap.js';
import { diffFilesWithPatches, extractGateConfigBlock, gateConfigChangedBlock, gateConfigPaths, loadGateConfigExtraGlobs } from '../context/gate-config.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { credentialLabel, releaseToken, tokenProviderFor } from '../core/push-token.js';
import { resolveToken } from '../pipeline/remote-branch.js';
import { deliverChange, scanOutgoingForSecrets } from './deliver-change.js';
import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { dischargePrBodyItemsBlock, extractPrBodyItemsBlock, parseSpecManifest, extractTaskIdFromPrBody, scanCommitClosingKeywords } from '../pipeline/conformance-gate.js';
import type { VerificationResult } from '../pipeline/verify.js';
import {
  implementReviewSimplifyStages,
  runStages,
  withStageProvider,
  withStageModel,
  withStageModelExcept,
  withStageFallback,
  withStageFallbackModel,
  withPrimaryFallback,
  STAGE,
} from '../pipeline/pipeline.js';
import { droppedCiPathsNote, pushToExistingBranch } from '../pipeline/remote-branch.js';
import { defaultGhRunner, GitHubTaskFetcher } from '../tasks/github.js';
import { modelFromLabels } from './source-adapter.js';
import { DockerSandboxProvider, sandboxImage } from '../sandbox/docker.js';
import { sandboxNetworkConfig } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { authSecrets } from '../agents/auth.js';
import { selectAgents, providerKeyEnvNames } from '../agents/registry.js';
import { GITHUB_REVIEW_LABEL } from '../github-labels.js';
import { WorktreeManager } from '../worktree/manager.js';
import { TaskcellError } from '../core/errors.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestForReview } from './pr-review.js';
import type { CommandRunner } from '../pipeline/remote-branch.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, SelectedAgents } from '../agents/registry.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider } from '../agents/provider.js';

const NEEDS_REVISION_LABEL = 'needs revision';
const VANGUARD_REVISING_LABEL = 'taskcell:revising';
const DEFAULT_MAX_ROUNDS = 2;
// The marker a finished review leaves; the trigger the PR-review workflow listens for is REVIEW_TRIGGER_LABEL (core/labels.ts).
const REVIEWED_LABEL = 'taskcell:reviewed';
// secret-blocked is removed too: a round that pushes cleanly after the human stripped the secret must
// not leave the PR mapped to verify-failed on the board.
// rate-limited too: a round that ran must not be re-triggered by the resume sweep.
const HAND_BACK_LABELS = { remove: [NEEDS_REVISION_LABEL, VANGUARD_REVISING_LABEL, GITHUB_SECRET_BLOCKED_LABEL, GITHUB_RATE_LIMITED_LABEL], add: [GITHUB_REVIEW_LABEL] };

/** Cap on implement-session resumes triggered by a red verification in the revise pass — one bounded repair. */
const MAX_VERIFY_REPAIRS = 1;

export interface ReviseGithubPrDeps extends ProviderChoice {
  feedbackAuthors?: string[];
  auth?: AgentAuth;
  repoPath: string;
  repoSlug?: string;
  gh?: GhRunner;
  /** LLM-proxy sidecar wiring (from startSandboxContext when --llm-proxy is active). */
  llmProxy?: LlmProxyDep;
  /** Egress proxy URL for the sandbox (from startSandboxContext when --egress is active). */
  proxyUrl?: string;
  /** Docker network for the sandbox (from startSandboxContext). */
  network?: string;
  /**
   * Model for the implementer/simplifier stages, as in `implement`. Overridden by a
   * `taskcell:model=<m>` label on the issue the PR body references (Closes/Part of #N) — same
   * precedence as implement's label vs. --provider-model.
   */
  providerModel?: string;
  /** Model for the review stage. */
  reviewModel?: string;
  /** Model for every stage that fell back to `fallbackProvider` (ProviderChoice.fallbackProvider); undefined = its default. */
  fallbackModel?: string;
  /** Git author for the revision commits + white-label toggle: drops the "vanguard" token from the revision marker so a client repo carries no automation branding. Set via --commit-author. */
  commitAuthor?: { name: string; email: string };
  /** Dry-run: write the diff + proposed thread replies to this local file and push/comment NOTHING. Set via --out. */
  out?: string;
  /** Skip the simplifier stage. */
  noSimplify?: boolean;
  /** Maximum revision rounds before capping (default 2). */
  maxRounds?: number;
  /** Explicit verification command (else auto-detected from the worktree). */
  verifyCmd?: string;
  /** --skills dir, merged with the repo's .github/vanguard-skills/ (read from repoPath, not the PR head). */
  skillsDir?: string;
  /** Extra logins to treat as bots (beyond the built-in heuristic). */
  botLogins?: string[];
  log?: (line: string) => void;
  /** Cancels an in-flight repair resume (observed when the current agent exec ends). */
  signal?: AbortSignal;
  // Test hooks
  /** Injected sandbox provider (avoids Docker in unit tests). */
  _sandbox?: IsolatedSandboxProvider;
  /** Injected agent provider (avoids real provider CLIs and credential checks in unit tests). */
  _agent?: AgentProvider;
  /** Injected WorktreeManager (avoids requiring a real git remote in unit tests). */
  _worktrees?: WorktreeManager;
  /** Injected CommandRunner for git push (pushToExistingBranch). */
  _pushRunner?: CommandRunner;
  /**
   * Start the worktree from this branch (a 'base' start that keeps a local copy that is ahead) instead
   * of fetching the PR head. Use in tests, on a repo without an origin, to point at a local branch.
   */
  _baseBranch?: string;
}

export interface ReviseGithubPrResult {
  ignoredFeedback?: Array<{ author: string; association: string }>;
  pr: PullRequestForReview;
  /** Number of feedback items addressed this round (threads replied+resolved, non-thread items commented on). */
  addressed: number;
  committed: boolean;
  pushed: boolean;
  undrafted: boolean;
  /** Absolute path of the dry-run preview file, when --out was given (push/comment were skipped). */
  dryRunOut?: string;
  /** The revision diff carried a secret (or the scan failed): nothing was committed or pushed; `addressed` counts the items abandoned. */
  secretBlocked?: boolean;
  /** The PR still conflicts with its base (the agent left markers, or a conflict finding produced no change): nothing was pushed and `needs revision` stays for a human. */
  conflictUnresolved?: string[];
}

async function editPrLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['pr', 'edit', String(number), '--repo', repoSlug];
  // The PR may still carry a pre-rename `vanguard:*` label (older workflows add them): remove the spelling it has.
  const present = async (): Promise<string[]> =>
    ((JSON.parse(await gh(['pr', 'view', String(number), '--repo', repoSlug, '--json', 'labels'])) as { labels?: { name: string }[] }).labels ?? []).map((l) => l.name);
  for (const label of await resolveRemovals(labels.remove ?? [], present)) args.push('--remove-label', label);
  for (const label of labels.add ?? []) args.push('--add-label', label);
  return gh(args);
}

async function handBackPrLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  log: (line: string) => void,
): Promise<void> {
  try {
    await gh(['label', 'create', GITHUB_REVIEW_LABEL, '--repo', repoSlug, '--force']);
    // HAND_BACK_LABELS removes the hold label unconditionally, and a `--remove-label` for a label the
    // repo never created fails the whole edit: make sure it exists.
    await gh(['label', 'create', GITHUB_RATE_LIMITED_LABEL, '--repo', repoSlug, '--force']);
  } catch (err) {
    log(`revise-pr ${repoSlug}#${number}: label ensure -> manual label check (${err instanceof Error ? err.message : String(err)})`);
  }

  try {
    log(`revise-pr ${repoSlug}#${number}: labels -> needs-human-review`);
    await editPrLabels(gh, repoSlug, number, HAND_BACK_LABELS);
  } catch (err) {
    log(`revise-pr ${repoSlug}#${number}: labels -> manual label check (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Run one gh call as the push token's owner first (GH_TOKEN for this call only), logging `action` with
 * the credential actually resolved, not with which env vars are set. Refused → log `refused` and retry
 * with the ambient credential.
 */
async function ghAsPushTokenOwner(
  gh: GhRunner,
  args: string[],
  tokenProvider: () => Promise<string | undefined>,
  log: (line: string) => void,
  action: string,
  refused: string,
): Promise<void> {
  const pushToken = await resolveToken(tokenProvider, undefined, log);
  log(`${action}${credentialLabel(pushToken)}`);
  if (pushToken) {
    try {
      await gh(args, { GH_TOKEN: pushToken });
      return;
    } catch {
      log(refused);
    } finally {
      await releaseToken(pushToken);
    }
  }
  await gh(args);
}

/**
 * After a push, re-request the review: drop the reviewed marker and the trigger label, then add the
 * trigger back so a fresh `labeled` event starts the review of the new head. The add goes out as the
 * VANGUARD_PUSH_TOKEN (PAT) owner, never the taskcell App: a `labeled` event from the ambient GITHUB_TOKEN
 * starts no workflow, and one sent by `taskcell[bot]` fails the review's allowed-actors gate
 * (taskcell-pr-review.yml labels App PRs with the PAT for the same reason). Without the PAT, or refused,
 * the ambient credential still sets the label but no review run starts. Best-effort.
 */
async function requestReReview(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  log: (line: string) => void,
): Promise<void> {
  try {
    await gh(['label', 'create', REVIEW_TRIGGER_LABEL, '--repo', repoSlug, '--force']).catch(() => undefined);
    await editPrLabels(gh, repoSlug, number, { remove: [REVIEWED_LABEL, REVIEW_TRIGGER_LABEL] }).catch(() => undefined);
    await ghAsPushTokenOwner(
      gh,
      ['pr', 'edit', String(number), '--repo', repoSlug, '--add-label', REVIEW_TRIGGER_LABEL],
      async () => process.env.VANGUARD_PUSH_TOKEN || undefined,
      log,
      `revise-pr ${repoSlug}#${number}: labels -> re-review (${REVIEW_TRIGGER_LABEL})`,
      `revise-pr ${repoSlug}#${number}: re-review label with the push token failed, retrying with the ambient credential (no review run will start)`,
    );
  } catch (err) {
    log(`revise-pr ${repoSlug}#${number}: re-review label -> manual label check (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Flag the PR as touching gate config, so a weakening pushed in a revise round reaches the same
 * human gate the first delivery raises (source-adapter.ts). Unlike the hand-back labels this is NOT
 * best-effort: the label IS the gate, so a failed flip is reported (it propagates to the caller's
 * error path) rather than swallowed, which would hand an unflagged PR back for review. Only the
 * advisory `label create` is logged and tolerated — the label may already exist.
 */
async function addGateConfigLabel(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  log: (line: string) => void,
): Promise<void> {
  log(`revise-pr ${repoSlug}#${number}: labels -> ${GITHUB_GATE_CONFIG_LABEL}`);
  try {
    await gh(['label', 'create', GITHUB_GATE_CONFIG_LABEL, '--repo', repoSlug, '--force']);
  } catch (err) {
    log(`revise-pr ${repoSlug}#${number}: gate-config label ensure -> manual label check (${err instanceof Error ? err.message : String(err)})`);
  }
  await editPrLabels(gh, repoSlug, number, { add: [GITHUB_GATE_CONFIG_LABEL] });
}

/**
 * Un-draft the PR. With a pushToken, try `pr ready` as the token's owner first (GH_TOKEN for this one
 * call): a `ready_for_review` event from the ambient GITHUB_TOKEN starts no workflows, so the review
 * workflow's label-factory-pr job never fires on the final commit (#557). Refused (e.g. no Pull
 * requests: write) → retry with the ambient credential so the PR still leaves draft.
 */
async function markReady(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  tokenProvider: () => Promise<string | undefined>,
  log: (line: string) => void,
): Promise<void> {
  await ghAsPushTokenOwner(
    gh,
    ['pr', 'ready', String(number), '--repo', repoSlug],
    tokenProvider,
    log,
    `revise-pr ${repoSlug}#${number}: undraft -> pr ready`,
    `revise-pr ${repoSlug}#${number}: pr ready with the push token failed, retrying with the ambient credential`,
  );
}

/**
 * Model pinned by a `taskcell:model=<m>` label on the issue the PR body references via a closing
 * keyword or `Part of` (extractTaskIdFromPrBody) — same override as implement's label vs.
 * --provider-model. Best-effort: a PR with no referenced issue, or a lookup that fails (deleted
 * issue, missing scope), must not block the revision — it just leaves --provider-model in place.
 */
async function modelFromSourceIssue(
  repoSlug: string,
  prBody: string,
  gh: GhRunner,
  log: (line: string) => void,
  prId: string,
): Promise<string | undefined> {
  const issueTaskId = extractTaskIdFromPrBody(prBody);
  if (issueTaskId === undefined) return undefined;
  try {
    const task = await new GitHubTaskFetcher(repoSlug, gh).fetch(issueTaskId);
    return modelFromLabels(task.labels, (label) =>
      log(`revise-pr ${prId}: ignoring malformed model label ${JSON.stringify(label)} on ${issueTaskId}`));
  } catch (err) {
    log(`revise-pr ${prId}: could not read labels on ${issueTaskId} (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

/**
 * The required-PR-body-item block with discharge applied. The manifest is read from non-issue-author
 * trusted comments only (the reporter must not be able to erase the disclosure); a failed lookup
 * leaves the block untouched.
 */
async function dischargedItemsBlockFor(
  repoSlug: string,
  gh: GhRunner,
  deps: ReviseGithubPrDeps,
  prBody: string,
  issueTaskId: string,
  log: (line: string) => void,
): Promise<string | undefined> {
  const block = extractPrBodyItemsBlock(prBody);
  if (block === undefined) return undefined;
  try {
    const task = await new GitHubTaskFetcher(repoSlug, gh).fetch(issueTaskId);
    const trust = { allowedAuthors: deps.feedbackAuthors, botLogins: deps.botLogins };
    // Dropping issue-author *trust* is not enough: a reporter who is also a member/allowlisted would
    // still count, so the reporter's own comments are excluded outright.
    const reporter = task.author?.toLowerCase();
    const specText = task.comments
      .filter((c) => c.author.toLowerCase() !== reporter && isTrustedNonAuthorComment(c, trust))
      .map((c) => c.body)
      .join('\n');
    return dischargePrBodyItemsBlock(block, parseSpecManifest(specText));
  } catch (err) {
    log(`revise-pr ${repoSlug}: could not read the spec manifest on ${issueTaskId} (${err instanceof Error ? err.message : String(err)}) — PR-body items left undischarged`);
    return block;
  }
}

/**
 * Run one PR revision round: read human review feedback, apply fixes on the existing PR branch,
 * reply to and resolve addressed threads, un-draft the PR, and flip the labels.
 */
export async function runRevisePullRequest(prRef: string, deps: ReviseGithubPrDeps): Promise<ReviseGithubPrResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const log = deps.log ?? console.log;
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const target = parsePullRequestRef(prRef, deps.repoSlug);
  log(`revise-pr ${target.repoSlug}#${target.number}: fetch -> pr & feedback`);
  const [pr, fb] = await Promise.all([
    fetchPullRequestForReview(target, gh),
    fetchPullRequestFeedback(target, gh, log),
  ]);

  // --out: a dry run that touches NEITHER the branch NOR the PR — the preview goes to the operator's
  // file and the absolute path comes back for `dryRunOut`.
  const writeDryRun = async (out: string, preview: string): Promise<string> => {
    const path = resolve(out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, preview, 'utf8');
    log(`revise-pr ${target.repoSlug}#${target.number}: dry-run -> ${path} (nothing pushed or commented)`);
    return path;
  };

  const { actionable, ignoredAuthors } = partitionActionableFeedback(fb, {
    feedbackAuthors: deps.feedbackAuthors,
    headRefOid: pr.headRefOid,
    ...(deps.botLogins !== undefined ? { botLogins: deps.botLogins } : {}),
  });

  const ignoredFeedback = [...new Map(ignoredAuthors.map((item) => [
    `${item.author} ${item.authorAssociation}`,
    { author: item.author, association: item.authorAssociation },
  ])).values()];
  const notes = ignoredFeedback.map(({ author, association }) =>
    `revise-pr ${target.repoSlug}#${target.number}: ignored feedback from ${describeIgnoredAuthor(author, association)}`);
  for (const note of notes) log(note);

  /**
   * Explain on the PR why no revision was applied and hand the routing labels back to a human, so the
   * PR never sits in `taskcell:revising` with no trace. Notices stay unbranded: a white-label run must
   * not name the automation (or its flags) in a client repo.
   */
  const handBackWithNotice = async (reason: string, message: string): Promise<void> => {
    log(`revise-pr ${target.repoSlug}#${target.number}: ${reason}, posting notice`);
    await postPullRequestReview(target, message, 'comment', gh);
    await handBackPrLabels(gh, target.repoSlug, target.number, log);
  };

  if (actionable.length === 0) {
    if (notes.length > 0) {
      // Everything this round was gated out on author trust — hand it back exactly as the round cap
      // does. --out is a dry-run that touches NEITHER the branch NOR the PR, so it only logs.
      if (deps.out === undefined) {
        await handBackWithNotice('all feedback untrusted', [
          'No automated revision was applied: every review comment in this round came from an author whose feedback is not trusted for automated revisions.',
          '',
          ...ignoredFeedback.map(({ author, association }) => `- ${describeIgnoredAuthor(author, association)}`),
          '',
          'Trusted feedback comes from a repository OWNER, MEMBER or COLLABORATOR, or from an explicitly allowed login.',
        ].join('\n'));
      }
      await appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
        taskId: `${target.repoSlug}#${target.number}`, flow: 'revise-pr', provider: deps.provider ?? 'unknown',
        exit: 'no-changes', outcomes: [], notes,
      });
    }
    log(`revise-pr ${target.repoSlug}#${target.number}: no actionable feedback — skipping`);
    return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  // A trusted human who comments after a cap notice and re-labels `needs revision` gets a fresh
  // budget: rounds are then only counted from that comment onward, so the PR is not refused again
  // for rounds that ran before the human asked for more work. A re-label with no new human comment
  // (automated or bot) leaves the cutoff undefined and the cap holds.
  const resetAt = revisionBudgetResetAt(fb, deps);
  const rounds = countRevisionRoundsFromFeedback(fb, deps, resetAt);
  // A round asked for nothing but the conflict with the base (no checklist item) may still run at the cap and
  // merges a base that git merges cleanly. Whether it WAS merge-only (uncounted, see revisionMarker) is decided
  // below from what it changed, never from the wording of the feedback: the agent still gets every item.
  const checklist = buildRevisionChecklist(fb, actionable, deps.botLogins);
  const mergeOnlyAsk = checklist.length === 0 && actionable.every(isConflictItem);
  const atCap = rounds >= maxRounds;
  const refuseAtCap = async (): Promise<ReviseGithubPrResult> => {
    await handBackWithNotice(`cap -> ${rounds} rounds`,
      `Revision cap reached (${rounds}/${maxRounds} rounds). No further automated revisions will be applied.\n\n${revisionCapMarker()}`);
    return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false };
  };
  if (atCap && !mergeOnlyAsk) return await refuseAtCap();

  if (pr.isCrossRepository) {
    // A fork PR's head branch is not on origin: fetching refs/heads/<headRefName> there (resolveStartRef
    // in taskcell.ts) would silently land on a same-named base-repo branch instead, and the push below
    // would land on it too. Refuse before any fetch, worktree or push — there is no safe revise path
    // for a fork head. Placed after the early returns above so a re-run with nothing actionable left,
    // or one past the round cap, stays as quiet here as it is for a same-repo PR.
    const notice = `Cannot revise: this PR's head branch is on ${pr.headRepositoryOwner !== '' ? `${pr.headRepositoryOwner}'s fork` : 'a fork'}, not ${target.repoSlug}. Automated revision only pushes to branches in this repository — please revise manually.`;
    log(`revise-pr ${target.repoSlug}#${target.number}: cross-repo -> cannot revise`);
    if (deps.out !== undefined) {
      // --out was asked for a file: write the refusal there too, so the operator never gets a silent
      // "no changes" with no preview.
      const dryRunOut = await writeDryRun(deps.out, `# Revision dry run: ${target.repoSlug}#${target.number}\n\n${notice}\n`);
      return { pr, addressed: 0, committed: false, pushed: false, undrafted: false, dryRunOut };
    }
    await postPullRequestReview(target, notice, 'comment', gh);
    await handBackPrLabels(gh, target.repoSlug, target.number, log);
    return { pr, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  const labelModel = await modelFromSourceIssue(target.repoSlug, pr.body, gh, log, `${target.repoSlug}#${target.number}`);
  if (labelModel !== undefined) {
    log(`revise-pr ${target.repoSlug}#${target.number}: pins the implementer model to ${labelModel} via label (overrides --provider-model)`);
  }
  const effectiveModel = labelModel ?? deps.providerModel;

  const agents: SelectedAgents =
    deps._agent !== undefined
      ? {
          agent: deps._agent,
          secrets: {},
          proxySecrets: {},
          injectAnthropicAuth: true,
        }
      : selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });

  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies);
    const sandbox =
      deps._sandbox ??
      new DockerSandboxProvider({
        image: sandboxImage(),
        secrets: {
          ...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth
            ? authSecrets(deps.auth)
            : {}),
          ...agents.secrets,
        },
        ...(env !== undefined ? { env } : {}),
        ...sandboxNetworkConfig(deps.network),
      });

    const taskId = `revise-pr-${target.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${target.number}`;
    // One RunWriter for the whole revision round, shared by the (mutually exclusive) writeStages
    // calls below, for consistency with runSourcedIssue's writer.
    const writer = beginRun(deps.repoPath, taskId, undefined, { secretEnvVars: providerKeyEnvNames(deps) });
    const revisionStageMeta: { flow: string; provider: string; lessonIds?: string[] } = { flow: 'revise', provider: agents.agent.name };
    let outcomes: StageOutcome[] = [];
    // For paths where the secret scan never ran: keep the cost trace, keep the diff off disk.
    const writeStagesWithoutDiff = (): Promise<void> => writer.writeStages(outcomes, { ...revisionStageMeta, omitDiff: true });
    // One block per revision in the Actions job's Summary tab (no GITHUB_STEP_SUMMARY ⇒ no-op).
    const stepSummary = (exit: StepSummaryExit, extra: Pick<StepSummary, 'error'> = {}): Promise<void> => {
      const model = outcomes.find((o) => o.name === STAGE.IMPLEMENTER)?.result.model ?? effectiveModel;
      return appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
        taskId: `${target.repoSlug}#${target.number}`,
        flow: 'revise-pr',
        provider: agents.agent.name,
        ...(model !== undefined ? { model } : {}),
        outcomes,
        notes,
        exit,
        prUrl: pr.url,
        ...extra,
      });
    };

    // Starting the worktree can fail before there is a context to dispose: gh reported no head ref or
    // no head sha, or the head moved between `gh pr view` and the fetch (resolveStartRef pins the PR's
    // own sha, so a moved head is refused rather than revised). Report it and hand the labels back like
    // every other giving-up path, instead of leaving the PR in `taskcell:revising` with no comment.
    let ctx: RunContext;
    try {
      if (deps._baseBranch === undefined && (pr.headRefName === '' || pr.headRefOid === '')) {
        throw new TaskcellError(`PR ${target.repoSlug}#${target.number} has no head ref to fetch`);
      }
      ctx = await prepareContext(
        {
          taskId,
          localRepoPath: deps.repoPath,
          sandbox,
          agentName: agents.agent.name,
          // The worktree starts from the PR head as fetched from origin, not the base (see prepareContext
          // for the same-repo caveat). Tests point it at a local branch instead, which has no origin.
          ...(deps._baseBranch !== undefined
            ? { baseBranch: deps._baseBranch, start: 'base' as const, keepLocalIfAhead: true }
            : {
                baseBranch: baseBranchOrDefault(pr.baseRefName, `PR ${target.repoSlug}#${target.number}`),
                start: { prHead: pr.headRefName, headRefOid: pr.headRefOid },
              }),
        },
        { skills: await skillRegistryForRun(deps.skillsDir, deps.repoPath), ...(deps._worktrees !== undefined ? { worktrees: deps._worktrees } : {}) },
      );
    } catch (error) {
      await stepSummary('error', { error: String(error) });
      // --out is a dry run that touches neither the branch nor the PR.
      if (deps.out === undefined) {
        const notice = `Cannot revise: could not start from this PR's head branch (\`${pr.headRefName}\` at \`${pr.headRefOid}\`) — it may have moved while this run was reading the PR. Re-label \`${NEEDS_REVISION_LABEL}\` to try again.`;
        await postPullRequestReview(target, notice, 'comment', gh).catch(() => undefined);
        await handBackPrLabels(gh, target.repoSlug, target.number, log);
      }
      throw error;
    }
    try {
      const allStages = implementReviewSimplifyStages();
      const base = deps.noSimplify === true ? allStages.filter((s) => s.name !== STAGE.SIMPLIFIER) : allStages;
      let pipeline = agents.reviewAgent !== undefined ? withStageProvider(base, agents.reviewAgent) : base;
      if (effectiveModel !== undefined) {
        const crossProviderReview =
          deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
        pipeline = crossProviderReview
          ? withStageModelExcept(pipeline, effectiveModel, STAGE.REVIEWER)
          : withStageModel(pipeline, effectiveModel);
      }
      if (deps.reviewModel !== undefined) pipeline = withStageModel(pipeline, deps.reviewModel, STAGE.REVIEWER);
      if (agents.reviewAgent !== undefined) {
        pipeline = withStageFallback(pipeline, {
          provider: agents.agent,
          ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
        });
      }
      // An explicit --review-model survives the fallback only when the fallback runs on the provider
      // the model was pinned for; a cross-provider fallback keeps --fallback-model / its own default.
      // Outside the fallback-provider branch: the reviewer's same-provider fallback above exists with
      // or without --fallback-provider, and withPrimaryFallback below never touches a stage that
      // already has one.
      if (deps.reviewModel !== undefined) pipeline = withStageFallbackModel(pipeline, deps.reviewModel, agents.agent);
      // Implementer fallback: on an AgentError from the primary provider (outage, usage limit, revoked
      // credential, rate limit) runStages retries the stage once on this provider — same contract as
      // the first delivery's implementer fallback (source-adapter.ts). Every stage on the primary gets
      // it (implementer, simplifier): the provider that failed one fails the other too.
      if (agents.fallbackAgent !== undefined) {
        pipeline = withPrimaryFallback(pipeline, {
          provider: agents.fallbackAgent,
          ...(deps.fallbackModel !== undefined ? { model: deps.fallbackModel } : {}),
        });
      }

      // A branch that no longer merges into its base is merged here (a merge commit), or, when the base changed CI config and the branch is the factory's, rebased onto it:
      // conflict markers are left in the worktree for the agent, and the gate below runs on the result.
      const baseName = baseBranchOrDefault(pr.baseRefName, `PR ${target.repoSlug}#${target.number}`);
      const baseMerge = await mergeBaseIntoWorktree(ctx.worktreePath, baseName, {
        ...(deps.commitAuthor !== undefined ? { authorName: deps.commitAuthor.name, authorEmail: deps.commitAuthor.email } : {}),
        // Only a factory branch (its prefix) may be rewritten; base-merge also requires every commit on it to carry the factory identity.
        factoryOwned: pr.headRefName.startsWith(VANGUARD_BRANCH_PREFIX),
        // Asked only to bring the branch up to its base: merge a base that git merges cleanly too.
        mergeClean: mergeOnlyAsk && deps.out === undefined,
      });
      const cleanMerged = baseMerge.status === 'clean' && baseMerge.merged === true;
      // One `base_merge` metric per check that ran (not for a dry run, which touches nothing); telemetry is best-effort.
      const recordBaseMerge = async (conflictedFiles: string[], resolvedBy?: 'agent' | 'human'): Promise<void> => {
        if (deps.out !== undefined || baseMerge.status === 'skipped') return;
        await persistBaseMerge(deps.repoPath, {
          repo: target.repoSlug, pr: target.number, base: baseName,
          outcome: baseMerge.status, conflictedFiles, ...(resolvedBy !== undefined ? { resolvedBy } : {}),
          // Recorded before the round's diff exists: what the round was asked for.
          round: mergeOnlyAsk ? 'merge-only' : 'mixed',
        }).catch(() => undefined);
      };
      if (baseMerge.status === 'clean') await recordBaseMerge([]);
      if (baseMerge.status === 'skipped') log(`revise-pr ${target.repoSlug}#${target.number}: base merge check skipped (${baseMerge.reason})`);
      const conflicted = baseMerge.status === 'conflicted' ? baseMerge.files : [];
      const mergedBase = baseMerge.status === 'conflicted' && baseMerge.unresolvable.length === 0 ? { base: baseName, files: conflicted, ...(baseMerge.rebased === true ? { rebased: true } : {}) } : undefined;
      const forceWithLease = mergedBase?.rebased === true ? pr.headRefOid : undefined;
      // Never report success on a PR that still conflicts: say so on the PR and leave `needs revision`
      // for a human (only the in-flight label goes, as for a rate limit).
      const holdForConflict = async (files: string[], reason?: string): Promise<ReviseGithubPrResult> => {
        const notice = `Could not resolve the conflict with \`${baseName}\`: ${formatConflictFiles(files)}${reason !== undefined ? ` (${reason})` : ''}. No changes were pushed; please merge \`${baseName}\` into this branch by hand.`;
        log(`revise-pr ${target.repoSlug}#${target.number}: ${notice}`);
        if (deps.out !== undefined) {
          const dryRunOut = await writeDryRun(deps.out, `# Revision dry run: ${target.repoSlug}#${target.number}\n\n${notice}\n`);
          return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false, conflictUnresolved: files, dryRunOut };
        }
        await postPullRequestReview(target, notice, 'comment', gh);
        await editPrLabels(gh, target.repoSlug, target.number, { remove: [VANGUARD_REVISING_LABEL] }).catch(() => undefined);
        await stepSummary('error', { error: notice });
        return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false, conflictUnresolved: files };
      };

      // Conflicts with no markers to resolve (modify/delete, rename, binary) are left to a human.
      if (baseMerge.status === 'conflicted' && baseMerge.unresolvable.length > 0) {
        await recordBaseMerge(baseMerge.files, 'human');
        return await holdForConflict(baseMerge.unresolvable, baseMerge.reason);
      }
      if (cleanMerged) {
        log(`revise-pr ${target.repoSlug}#${target.number}: ${baseName} merged cleanly`);
        await refreshSandboxWorkspace(ctx);
      }
      if (mergedBase !== undefined) {
        log(`revise-pr ${target.repoSlug}#${target.number}: ${baseName} conflicts with the branch (${formatConflictFiles(conflicted)}) -> ${mergedBase.rebased === true ? 'rebased' : 'merged'}, agent resolves`);
        await refreshSandboxWorkspace(ctx);
      }

      // Override the implementer's promptTemplate with the revision prompt. It holds review comments and
      // the diff, so it goes in as a variable and is never expanded as a template (see literalPrompt).
      // Lessons for the files the PR actually changes (the diff is known here), recorded on the run.
      const lessons = await loadLessonsForTask(deps.repoPath, '', { files: changedFilesOf(pr.diff) });
      const { promptTemplate, variables } = literalPrompt(buildRevisionPrompt(pr, actionable, mergedBase, checklist, lessons.text));
      pipeline = pipeline.map((stage) =>
        stage.name === STAGE.IMPLEMENTER ? { ...stage, promptTemplate } : stage,
      );

      log(`revise-pr ${target.repoSlug}#${target.number}: agent -> implementing`);
      if (lessons.ids.length > 0) revisionStageMeta.lessonIds = lessons.ids;
      outcomes = await runStages(ctx, pipeline, { agent: agents.agent, variables });
      const stillConflicted = await filesWithConflictMarkers(ctx.worktreePath, conflicted);
      if (baseMerge.status === 'conflicted') await recordBaseMerge(conflicted, stillConflicted.length > 0 ? 'human' : 'agent');
      if (stillConflicted.length > 0) {
        await writeStagesWithoutDiff();
        return await holdForConflict(stillConflicted);
      }

      // Every checklist item needs an answer from the agent; a missing one fails the revision rather than
      // reporting success. Only the implementer is given the checklist: a reviewer or simplifier line shaped
      // like an answer must not stand in for one. --out is a dry run and never posts.
      const answers = parseChecklistAnswers(
        outcomes.filter((o) => o.name === STAGE.IMPLEMENTER).map((o) => o.result.finalText).join('\n'),
        checklist.length,
      );
      const unanswered = checklist.filter((_, i) => answers[i] === undefined);
      const failOpenItems = async (notice: string): Promise<never> => {
        log(`revise-pr ${target.repoSlug}#${target.number}: ${notice}`);
        if (deps.out === undefined) {
          await postPullRequestReview(target, notice, 'comment', gh).catch(() => undefined);
          await editPrLabels(gh, target.repoSlug, target.number, { remove: [VANGUARD_REVISING_LABEL] }).catch(() => undefined);
        }
        throw new TaskcellError(`revise-pr ${target.repoSlug}#${target.number}: ${notice}`);
      };
      if (unanswered.length > 0) {
        await writeStagesWithoutDiff();
        return await failOpenItems(`Revision failed: ${unanswered.length} blocking item(s) have no answer (fixed / not fixed / disputed), nothing was pushed:\n${unanswered.map((t) => `- ${t}`).join('\n')}`);
      }
      const checklistAnswers = checklist.map((text, i) => ({ text, answer: answers[i]! }));

      // Run the resolved verification command after applying changes and before pushing, with one
      // bounded repair iteration on red — reusing renderVerificationFeedback and the same resume
      // pattern as runSourcedIssue so a red revision never silently ships (alpha-window#901: 5
      // NameError tests pushed through revise). Auto-detect only touches the worktree, no manifest.
      const verifyCmd = await resolveVerifyCommand(ctx.worktreePath, deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {});
      // Same repair gate as the first delivery (shared caps, cost accounting, cancel): a red revision
      // never silently ships (alpha-window#901: 5 NameError tests pushed through revise).
      let verification: VerificationResult | undefined;
      if (verifyCmd !== undefined) {
        const cmd = verifyCmd;
        await repairUntilGreen(ctx, {
          label: `${target.repoSlug}#${target.number}`,
          gate: async () => {
            verification = await runVerification(ctx.sandbox, cmd);
            return { pass: verification.passed, feedback: verification.passed ? '' : renderVerificationFeedback(verification) };
          },
          agent: agents.agent,
          outcomes,
          pipeline,
          maxIterations: MAX_VERIFY_REPAIRS,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          log,
        });
      }
      const verificationFailed = verification !== undefined && !verification.passed;

      // Capture round diff BEFORE commit — post-commit git diff HEAD is empty. A git failure here must
      // not lose the cost trace the persist below exists for: record the outcomes and rethrow.
      let revisionDiff: string;
      // The gate scans the attribute-proof rendering; revisionDiff stays the stored/previewed diff.
      let gateDiff: string;
      try {
        revisionDiff = await ctx.wm.diff(ctx.worktreePath);
        gateDiff = await ctx.wm.outgoingDiff(ctx.worktreePath);
      } catch (err) {
        await writeStagesWithoutDiff();
        throw err;
      }
      const whiteLabel = deps.commitAuthor !== undefined;

      // Same gate as the first delivery (runSourcedIssue): a secret in the agent's diff must never reach
      // a commit, the PR branch, or the --out preview a human will read and share. A scan error blocks
      // too. The block is made visible the same way: masked comment on the PR (not in white-label mode)
      // and the routing labels handed back, so the PR does not sit in `taskcell:revising`. Residual gaps,
      // shared with the first delivery: scanForSecrets skips `*.test.ts` / `tests/**` (isTestPath).
      // A custom provider's key env var is repo-configured: the secret gate cannot know its name.
      const secretEnvVars = providerKeyEnvNames(deps);
      const block = scanOutgoingForSecrets(gateDiff, `${target.repoSlug}#${target.number}`, 'revise push', secretEnvVars);
      // Repair cost merged into the implementer outcome by the gate reaches `taskcell stats` only if
      // the outcomes are persisted — the first delivery does this in runSourcedIssue. Persisted after
      // the scan so a blocked round leaves no `.diff` / `.bundle` on disk (the diff holds the secret).
      await writer.writeStages(outcomes, {
        ...revisionStageMeta,
        ...(block !== undefined ? { omitDiff: true } : {}),
      });
      if (block !== undefined) {
        // --out is a dry-run that touches NEITHER the branch NOR the PR: report the block on stderr only,
        // write no preview (it would carry the raw secret), and leave the labels alone.
        if (deps.out === undefined) {
          await handBackPrLabels(gh, target.repoSlug, target.number, log);
          // White-label runs keep the automation invisible in the client repo: no branded comment and no
          // secret-blocked label (same rule as the first delivery); the hand-back label is the one the
          // revise loop already relies on.
          if (!whiteLabel) {
            const notice = [
              renderSecretBlockComment(block, 'revision'),
              'Remove the secret from the revision and re-label `needs revision`.',
              droppedCiPathsNote(ctx.droppedCiPaths),
            ].filter((part) => part !== '').join('\n\n');
            await commentPullRequest(target, notice, gh).catch(() => undefined);
            // Same marker as the first delivery, so the board maps it to verify-failed, not to a clean hand-back.
            await gh(['label', 'create', GITHUB_SECRET_BLOCKED_LABEL, '--repo', target.repoSlug, '--force']).catch(() => undefined);
            await gh(['pr', 'edit', String(target.number), '--repo', target.repoSlug, '--add-label', GITHUB_SECRET_BLOCKED_LABEL]).catch(() => undefined);
          }
        }
        await stepSummary('secret-blocked');
        return { pr, ignoredFeedback, addressed: actionable.length, committed: false, pushed: false, undrafted: false, secretBlocked: true };
      }

      // Diff-true "what changed" point per feedback item — uses the diff, not a commit sha, so the
      // dry-run below can build proposed replies without committing.
      const diffFiles = parseRevisionDiff(revisionDiff);
      const globalPoint = formatFileChanges(diffFiles, 3, 3);
      const pointFor = (item: FeedbackItem): string =>
        guardedPoint(describeItemChange(item, diffFiles) || globalPoint, revisionDiff);

      // --out: dry-run. Write the diff + the reply we would post to each addressed item to a local file.
      // The operator reviews it, then re-runs without --out to apply. No commit / push / comment here.
      if (deps.out !== undefined) {
        const status = verification === undefined ? 'unknown' : verification.passed ? 'pass' : 'fail';
        const preview = buildRevisionDryRun({
          repoSlug: target.repoSlug,
          number: target.number,
          headRefName: pr.headRefName,
          diff: revisionDiff,
          items: actionable.map((item) => ({ item, point: pointFor(item) })),
          verification: { typecheck: status, test: status },
        });
        const dryRunOut = await writeDryRun(deps.out, preview);
        await stepSummary(verificationFailed ? 'verify-failed' : 'completed');
        return { pr, ignoredFeedback, addressed: actionable.length, committed: false, pushed: false, undrafted: false, dryRunOut };
      }

      // Merge-only is what the round did: the base was merged and the agent changed nothing outside the files that
      // conflicted (nothing at all after a clean merge). Anything else is an ordinary round: counted, re-reviewed in full.
      const mergeOnlyDiff = mergeOnlyAsk && (cleanMerged || mergedBase !== undefined) && (await ctx.wm.changedPaths(ctx.worktreePath)).every((f) => conflicted.includes(f));
      if (atCap && !mergeOnlyDiff) {
        await stepSummary('no-changes');
        return await refuseAtCap();
      }

      log(`revise-pr ${target.repoSlug}#${target.number}: commit -> staging`);
      // Resolved at each use (push, undraft): an App installation token is minted then, not now.
      const resolvePushToken = tokenProviderFor(deps.repoPath, target.repoSlug);
      let pushedWith = '';
      const tokenProvider = async (): Promise<string | undefined> => {
        pushedWith = '';
        const token = await resolvePushToken();
        pushedWith = credentialLabel(token);
        return token;
      };
      // deliverChange owns the order: secret scan on the revision diff → commit → push onto the PR branch.
      const delivery = await deliverChange(ctx, {
        taskId: `${target.repoSlug}#${target.number}`,
        commitMessage: `fix: address review feedback${mergedBase !== undefined ? ` and ${mergedBase.rebased === true ? 'rebase onto' : 'merge'} ${baseName}` : ''} (${target.repoSlug}#${target.number})`,
        ...(deps.commitAuthor !== undefined ? { commitAuthor: deps.commitAuthor } : {}),
        secretEnvVars,
        target: {
          kind: 'existing-branch',
          prHeadRef: pr.headRefName,
          tokenProvider,
          ...(forceWithLease !== undefined ? { forceWithLease } : {}),
          ...(deps._pushRunner !== undefined ? { runner: deps._pushRunner } : {}),
        },
      });
      if (delivery.kind === 'secret-blocked') {
        // The gate above scanned the same worktree before the --out branch and handled the block
        // (comment, labels). Reaching here means the worktree changed in between — fail loudly rather
        // than strand the PR silently.
        throw new TaskcellError(`revise-pr ${target.repoSlug}#${target.number}: secret found at delivery after a clean pre-scan`);
      }
      if (delivery.kind === 'no-changes' && mergedBase === undefined && !cleanMerged) {
        // A conflict finding that changed nothing, with no way to tell whether the branch still conflicts
        // (the base check was skipped), is a failure, not a quiet success.
        if (baseMerge.status === 'skipped' && actionable.some((item) => /\bconflict/i.test(item.body))) return await holdForConflict([]);
        if (checklist.length > 0) {
          return await failOpenItems(`Revision pushed nothing although ${checklist.length} blocking item(s) were open:\n${checklistAnswers.map(({ text, answer }, i) => `${i + 1}. ${text} — ${answer.status}: ${answer.detail}`).join('\n')}`);
        }
        log(`revise-pr ${target.repoSlug}#${target.number}: no changes — skipping push`);
        await stepSummary('no-changes');
        return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false };
      }
      // After a clean merge the round is merge-only only if nothing but the merge commit goes out.
      const mergeOnly = mergeOnlyDiff && (!cleanMerged || delivery.kind === 'no-changes');
      let sha: string;
      if (delivery.kind === 'delivered-push') {
        sha = delivery.sha;
      } else if (delivery.kind === 'no-changes') {
        // The agent kept the branch's side of every conflict and changed nothing else: the local merge
        // (or rebased) HEAD itself is what goes out.
        await pushToExistingBranch(ctx, { prHeadRef: pr.headRefName, host: 'github.com', tokenProvider, ...(forceWithLease !== undefined ? { forceWithLease } : {}), ...(deps._pushRunner !== undefined ? { runner: deps._pushRunner } : {}) });
        sha = (await execa('git', hostGitArgs(['rev-parse', 'HEAD']), { cwd: ctx.worktreePath })).stdout.trim();
      } else {
        throw new TaskcellError(`unexpected delivery outcome ${delivery.kind} for an existing-branch target`);
      }
      log(`revise-pr ${target.repoSlug}#${target.number}: pushed -> ${pr.headRefName}${pushedWith}`);

      // Re-derive the PR body from the CURRENT diff on every cycle so a stale `Closes #N` can never
      // survive a revision that regressed (alpha-window#901 kept a stale Closes through two review
      // requests). The referenced issue is recovered from the existing body; a red verification
      // forces the `Part of #N` path, and a commit-level closing keyword is downgraded to `Part of`.
      const issueTaskId = extractTaskIdFromPrBody(pr.body);
      if (issueTaskId !== undefined) {
        const closeIssueOnMerge = scanCommitClosingKeywords([pr.body], issueTaskId).length > 0;
        const rederived = reviewRequestBody(issueTaskId, {
          closeIssueOnMerge,
          ...(verificationFailed ? { verificationFailed: true } : {}),
        });
        // reviewRequestBody only ever rebuilds the closing-keyword section; it knows nothing about the
        // `## Gate config changed` block the first delivery (or an earlier round) wrote into the body.
        // Carry it forward verbatim — otherwise this re-derivation silently drops the disclosure of a
        // weakening the gate already flagged (the label survives; the human-readable evidence would not).
        // Same for the required-PR-body-item block: it is the only record of a hand-applied obligation,
        // and holds whatever a human pasted into it.
        const newBody = [rederived, extractGateConfigBlock(pr.body), await dischargedItemsBlockFor(target.repoSlug, gh, deps, pr.body, issueTaskId, log)]
          .filter((s): s is string => s !== undefined)
          .join('\n\n');
        if (newBody !== pr.body) {
          log(`revise-pr ${target.repoSlug}#${target.number}: body -> re-derived (${verificationFailed ? 'Part of' : closeIssueOnMerge ? 'Closes' : 'no-close'})`);
          await gh(['pr', 'edit', String(target.number), '--repo', target.repoSlug, '--body', newBody]);
        }
      }

      // Reply to and resolve each addressed thread (one reply per unique thread).
      // Map each threadId to its first actionable item to derive a per-thread point.
      const threadIdToItem = new Map<string, FeedbackItem>();
      for (const item of actionable) {
        if (item.source === 'thread' && item.threadId !== undefined && !threadIdToItem.has(item.threadId)) {
          threadIdToItem.set(item.threadId, item);
        }
      }
      await Promise.all(
        [...threadIdToItem.entries()].map(([threadId, item]) => {
          const p = pointFor(item);
          const detail = p ? `: ${p}` : '.';
          return replyAndResolveThread(threadId, `Addressed in commit ${sha}${detail}\n\n${revisionMarker(pr.headRefOid, whiteLabel, mergeOnly)}`, gh);
        }),
      );

      // Post a per-item referencing reply for each non-threadable feedback item.
      const nonThreadItems = actionable.filter((item) => item.source !== 'thread');
      await Promise.all(
        nonThreadItems.map((item) => commentPullRequest(target, buildItemReply(item, pointFor(item), sha, pr.headRefOid, whiteLabel, mergeOnly), gh)),
      );

      // Post the single final round summary.
      const verificationStatus = verification === undefined ? 'unknown' : verification.passed ? 'pass' : 'fail';
      const summaryText = buildRevisionSummary({
        repoSlug: target.repoSlug,
        number: target.number,
        headRefOid: pr.headRefOid,
        commitSha: sha,
        addressed: actionable.map((item) => ({ item, point: pointFor(item) })),
        deferred: [],
        verification: { typecheck: verificationStatus, test: verificationStatus },
        whiteLabel,
        ...(checklistAnswers.length > 0 ? { checklist: checklistAnswers } : {}),
        ...(mergedBase !== undefined ? { mergedBase } : cleanMerged ? { mergedBase: { base: baseName, files: [] } } : {}),
        ...(mergeOnly ? { mergeOnly } : {}),
        ...(baseMerge.status === 'skipped' ? { baseCheckSkipped: { base: baseName, reason: baseMerge.reason } } : {}),
      });
      // The gate on checker config is per-push, not per-PR (#627): a weakening introduced in a later
      // revise round must carry the same disclosure and label as one present when the PR was opened,
      // or the human gate is bypassed by simply pushing it a round later. Both go out before the
      // hand-back below, so a failure to post leaves the PR in `taskcell:revising` with the round's
      // error rather than silently handing an unflagged change back for review.
      const configFiles = diffFilesWithPatches(gateDiff);
      const configPaths = gateConfigPaths(
        configFiles,
        await loadGateConfigExtraGlobs(deps.repoPath, baseBranchOrDefault(pr.baseRefName, `PR ${target.repoSlug}#${target.number}`)),
      );
      const configBlock = gateConfigChangedBlock(configFiles.filter((file) => configPaths.includes(file.path)));
      await commentPullRequest(target, [summaryText, configBlock, droppedCiPathsNote(ctx.droppedCiPaths)].filter((part) => part !== '').join('\n\n'), gh);
      if (configPaths.length > 0) await addGateConfigLabel(gh, target.repoSlug, target.number, log);

      await markReady(gh, target.repoSlug, target.number, tokenProvider, log);

      await handBackPrLabels(gh, target.repoSlug, target.number, log);
      // A merge-only round that resolved no conflict markers changed nothing the review covered: the previous
      // verdict stands (reviewed label kept, no review run; the approver's patch-id check sees the same change).
      if (mergeOnly && cleanMerged) log(`revise-pr ${target.repoSlug}#${target.number}: merge-only, clean merge -> keeping the previous review verdict`);
      else await requestReReview(gh, target.repoSlug, target.number, log);

      await stepSummary(verificationFailed ? 'verify-failed' : 'completed');
      return {
        pr,
        ignoredFeedback,
        addressed: actionable.length,
        committed: true,
        pushed: true,
        undrafted: true,
      };
    } catch (error) {
      await stepSummary('error', { error: String(error) });
      // A rate or session limit (or the usage cap) that no fallback rescued ends the round with the PR still carrying
      // `taskcell:revising` and nothing said on it, so the work sits until someone notices (#615,
      // #656). Mark it `vanguard:rate-limited` with a notice carrying the parsed reset time (posted
      // as a review comment, like the other hand-back notices here), and drop the in-flight label,
      // leaving `needs revision` in place: `taskcell resume-rate-limited` re-triggers that label
      // once the reset time has passed (or a human can re-apply it sooner).
      // Best-effort — neither the notice nor the label edit may mask the original failure. --out is
      // a dry run that touches neither the branch nor the PR. Gated on AgentError (same test as
      // pipeline.ts): a `gh`/git failure carrying GitHub's own "API rate limit exceeded" is not the
      // provider, and the notice would misname it — and after a successful push it would invite a
      // pointless second round.
      if (isRateLimitHold(error) && deps.out === undefined) {
        const { until, comment } = rateLimitHold(error, NEEDS_REVISION_LABEL);
        log(`revise-pr ${target.repoSlug}#${target.number}: ${error instanceof UsageCapError ? 'at the usage cap' : 'provider rate-limited'}, marking vanguard:rate-limited until ${until.toISOString()}`);
        await gh(['label', 'create', GITHUB_RATE_LIMITED_LABEL, '--repo', target.repoSlug, '--force']).catch(() => undefined);
        await editPrLabels(gh, target.repoSlug, target.number, { remove: [VANGUARD_REVISING_LABEL], add: [GITHUB_RATE_LIMITED_LABEL] }).catch(() => undefined);
        await postPullRequestReview(target, comment, 'comment', gh).catch(() => undefined);
      }
      throw error;
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
