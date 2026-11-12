import { execa } from 'execa';
import {
  GitHubTaskFetcher,
  linkPullRequest,
  addPrFailureLabel,
  addPrGateLabel,
  editGithubLabels,
  commentGithubIssue,
  defaultGhRunner,
  checkGithubDependencies,
} from '../tasks/github.js';
import { hasDependencyComment, dependencyWaitComment } from '../tasks/dependencies.js';
import type { DependencyCheck } from '../tasks/dependencies.js';
import { GitHubProjectFetcher } from '../tasks/github-project.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { publishReviewVerdict } from '../pipeline/review-publish.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { fanOut } from '../pipeline/fan-out.js';
import { runSourcedIssue } from './source-adapter.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { githubFailureLabel, GITHUB_GATE_CONFIG_LABEL, GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { GhRunner } from '../tasks/github.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { RunIssueDeps, RunIssueResult, SourceAdapter, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single GitHub issue end to end. */
export interface RunGithubIssueDeps extends RunIssueDeps {
  repoSlug: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld PR is not read as "no changes". */
export type RunGithubIssueResult = RunIssueResult;

/**
 * @internal Exported for unit tests; production callers use runGithubIssue. Only `signalSecretBlock`
 * and `prepare` go through the injected `gh`; `linkPr`, `addFailureLabel` and `addGateConfigLabel`
 * still reach the real CLI. `task`, when given, is the issue the caller already fetched (the
 * dependency gate in runGithubIssue), so the run does not read it a second time.
 */
export function githubAdapter(deps: RunGithubIssueDeps, gh: GhRunner = defaultGhRunner, task?: Task): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      return { task: task ?? (await new GitHubTaskFetcher(deps.repoSlug, gh).fetch(issueRef)) };
    },
    taskId: (task) => `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    closeIssueOnMerge: true,
    publishVerdict: publishReviewVerdict,
    async addFailureLabel(prUrl: string, kind: ProofFailureKind) {
      await addPrFailureLabel(deps.repoPath, prUrl, githubFailureLabel(kind));
    },
    async addGateConfigLabel(prUrl: string) {
      await addPrGateLabel(deps.repoPath, prUrl, GITHUB_GATE_CONFIG_LABEL);
    },
    async linkPr(issueRef: string, _task: Task, prUrl: string) {
      await linkPullRequest(deps.repoSlug, issueRef, prUrl);
    },
    async signalSecretBlock(issueRef: string, _task: Task, block: SecretBlock) {
      // `gh issue edit --add-label` fails on a repo that never created the label, which would leave
      // the held issue with no Vanguard label at all. Ensure it first (the same pre-step as
      // addPrFailureLabel and the revise path); every step stays best-effort.
      const label = gh(['label', 'create', GITHUB_SECRET_BLOCKED_LABEL, '--repo', deps.repoSlug, '--force'])
        .catch(() => undefined)
        .then(() => editGithubLabels(deps.repoSlug, issueRef, { add: [GITHUB_SECRET_BLOCKED_LABEL] }, gh))
        .catch(() => undefined);
      // No recovery procedure here: this adapter also serves one-shot `taskcell run` and Projects,
      // whose release steps differ. The watch primitive that holds the issue posts the resume line.
      await Promise.all([label, commentGithubIssue(deps.repoSlug, issueRef, renderSecretBlockComment(block), gh).catch(() => undefined)]);
    },
    async signalBaseRed(issueRef: string, _task: Task, body: string) {
      // Comment only, no label (see SourceAdapter); best-effort, like every other issue write-back.
      await commentGithubIssue(deps.repoSlug, issueRef, body, gh).catch(() => undefined);
    },
  };
}

/**
 * Run one GitHub issue end to end: fetch via `gh`, run the canonical implement/review/simplify
 * pipeline (the issue title/body go in as variables — no skill needed), open a draft PR, and comment
 * the PR link back onto the issue. GitHub is both the source and the review surface.
 *
 * Before any of that: check the issue's dependencies and start date (#760). The watch sweeps filter
 * blocked issues out in `listReady` (watch.ts), before any claim; this is the backstop for the one-shot
 * `taskcell run --github` path, the sidecar, and a dependency that reopened between listing and the
 * run. A blocked issue is `parked`: no implement budget is spent, and (when not already posted) a
 * single comment names the reason. A `waiting` block (a dependency that will close, a start date that
 * will arrive) is also flagged `waiting`, so the watch hands the issue back to its trigger. A
 * `needs_info` block (cycle, missing reference) is flagged `released`: the watch drops the claim and
 * the issue stays idle until a human fixes the reference and re-triggers it.
 *
 * The task fetched for the gate is handed to the adapter, so a ready issue is read once.
 */
export async function runGithubIssue(issueRef: string, deps: RunGithubIssueDeps, gh: GhRunner = defaultGhRunner): Promise<RunGithubIssueResult> {
  const task = await new GitHubTaskFetcher(deps.repoSlug, gh).fetch(issueRef);
  const check = await githubDependencyGate(deps.repoSlug, task, issueRef, gh, deps.commitAuthor !== undefined);
  if (check.status !== 'ready') return { task, parked: true, ...(check.status === 'waiting' ? { waiting: true } : { released: true }) };
  return runSourcedIssue(issueRef, deps, githubAdapter(deps, gh, task));
}

/**
 * Check one issue's dependencies and start date (#760) and, when it is blocked, post the reason once
 * (the exact same comment is never repeated; a changed reason is posted). `task` may come from a bulk
 * list, which carries the body but no comments: the issue is re-read for its comments only when a
 * comment might be posted.
 */
export async function githubDependencyGate(
  repo: string,
  task: Task,
  issueRef: string,
  gh: GhRunner = defaultGhRunner,
  whiteLabel = false,
): Promise<DependencyCheck> {
  const check = await checkGithubDependencies(repo, task, issueRef, gh);
  // White-label (--commit-author) posts nothing on the issue, like runSourcedIssue's signals: park silently.
  if (check.status === 'ready' || whiteLabel) return check;
  const comment = dependencyWaitComment(check, repo);
  const withComments = task.comments.length > 0 ? task : await new GitHubTaskFetcher(repo, gh).fetch(issueRef);
  if (!hasDependencyComment(withComments, comment)) await commentGithubIssue(repo, issueRef, comment, gh);
  return check;
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
export async function githubDepsFromEnv(repoPath: string, repoSlug?: string, choice: ProviderChoice = {}): Promise<RunGithubIssueDeps> {
  // The whole choice, so every provider that may run (reviewer, implementer fallback) is counted
  // when deciding whether the Anthropic credential must be injected.
  const auth = agentAuthFromEnv(choice);
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
