import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { detectRepoSlug, githubReviewHost } from './github.js';
import { localReviewHost, runSourcedIssue } from './source-adapter.js';
import type { Task } from '../tasks/fetcher.js';
import type { RunIssueDeps, RunIssueResult, Tracker, ReviewHost } from './source-adapter.js';

/** A hub-board task as the hub's task store holds it: the whole source of a `hub` run. */
export interface StoredHubTask {
  id: string;
  title: string;
  body: string;
}

/**
 * The hub board as a task source. The task is the stored one, not a tracker fetch (no `gh issue view`), and nothing is
 * written back to a tracker: the hub records the run's result on the task.
 */
export function hubTracker(stored: StoredHubTask): Tracker {
  const task: Task = { id: stored.id, title: stored.title, description: stored.body, labels: [], children: [], comments: [] };
  const none = async (): Promise<void> => undefined;
  return {
    prepare: async () => ({ task }),
    taskId: (t) => t.id,
    stages: implementReviewSimplifyStages,
    signalSecretBlock: none,
    signalBaseRed: none,
    linkPr: none,
  };
}

/** `repoSlug` set: the repository has a github.com origin and the result is a pull request there, as for a GitHub issue. Unset: it stays a local branch. */
export function hubReviewHost(repoPath: string, repoSlug: string | undefined): ReviewHost {
  return repoSlug === undefined ? localReviewHost : githubReviewHost(repoPath);
}

/** Run one hub-board task end to end: the canonical pipeline on the stored title and body, then a PR or a local branch. */
export async function runHubTask(stored: StoredHubTask, deps: RunIssueDeps): Promise<RunIssueResult> {
  const repoSlug = await detectRepoSlug(deps.repoPath).catch(() => undefined);
  return runSourcedIssue(stored.id, deps, hubTracker(stored), hubReviewHost(deps.repoPath, repoSlug));
}
