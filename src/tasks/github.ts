import { execa } from 'execa';
import { VanguardError } from '../core/errors.js';
import { classifyAuthor } from './comment-trust.js';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';
import { redactForPublish } from '../core/secret-scan.js';
import { parseDependsOnBody, parseStartDate, mergeDependsOn, checkDependencies } from './dependencies.js';
import type { TaskRef, DependencyCheck, DependencyNode } from './dependencies.js';

export interface GitHubLabel {
  name: string;
}

export interface GitHubCommentAuthor {
  login: string;
}

export interface GitHubComment {
  author: GitHubCommentAuthor | null; // gh returns null for deleted accounts; justifies optional chaining in toTask()
  body: string;
  createdAt: string;
  /** GitHub CommentAuthorAssociation (e.g. OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/NONE). */
  authorAssociation?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: GitHubLabel[];
  comments?: GitHubComment[];
  /** Requested by fetch() (the open-state gate) and by list() only when a limit is set (S9 board). */
  state?: string;
  /** Issue author; added to fetch()'s --json field list (never on list(), which fetches no comments either). */
  author?: GitHubCommentAuthor | null;
}

/**
 * Runs a `gh` subcommand and returns its stdout. Injected so unit tests never call real gh.
 * `env` is merged over the process env for this one call (e.g. a one-off GH_TOKEN override).
 */
export type GhRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

export const defaultGhRunner: GhRunner = async (args, env): Promise<string> =>
  (await execa('gh', args, env !== undefined ? { env } : {})).stdout;

/** Strips an optional `owner/repo#` prefix, returning just the numeric part. */
export function issueNumber(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

export function toTask(repo: string, issue: GitHubIssue): Task {
  const comments: TaskComment[] = (issue.comments ?? []).map((comment) => ({
    author: comment.author?.login ?? '',
    body: comment.body ?? '',
    // GitHub models an association on every comment and gh returns it on `issue view --json comments`,
    // so a missing one is mapped to '' and fails closed (see classifyAuthor). Only providers that model
    // none at all (GitLab) keep the absent-means-no-signal path.
    authorAssociation: comment.authorAssociation ?? '',
  }));
  // A future gh that drops the field would turn every non-bot comment untrusted: say it out loud.
  if (comments.length > 0 && (issue.comments ?? []).every((c) => c.authorAssociation === undefined)) {
    console.warn(`taskcell: ${repo}#${issue.number} — gh returned no authorAssociation on any comment; non-bot comments are treated as untrusted`);
  }
  const body = issue.body ?? '';
  const dependsOn = parseDependsOnBody(body);
  const startDate = parseStartDate(body);
  return {
    id: `${repo}#${issue.number}`,
    title: issue.title,
    description: body,
    labels: issue.labels.map((label) => label.name),
    children: [], // the gh issue mapping does not fetch sub-issues
    comments,
    ref: String(issue.number),
    ...(issue.state !== undefined ? { state: issue.state } : {}),
    ...(issue.author?.login !== undefined ? { author: issue.author.login } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
  };
}

/** One native "blocked by" relationship as GitHub's Issue Dependencies REST API returns it. */
export interface GitHubBlockedByItem {
  number: number;
  repository?: { full_name?: string } | null;
}

/**
 * True when `error` is a `gh api` 404 (resource not found) — the ONLY failure that should be read as
 * "this reference does not exist" / "this host has no Issue Dependencies endpoint". Anything else
 * (a 5xx, an auth failure, a network error) must propagate: silently treating a transient failure the
 * same as "not found" would wrongly report an existing, unmet dependency as missing (needs_info) or
 * wrongly report it as having no blockers at all (ready).
 */
function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}

/**
 * Native "blocked by" relationships for one issue (#760), via GitHub's Issue Dependencies REST API
 * (`GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by`). Best-effort only for a 404
 * (a host where the feature is unavailable, e.g. older GHES) — that case yields no native refs,
 * falling back to whatever the body's `Depends on` lines say. Every other error (rate limit, auth,
 * network) propagates rather than being silently read as "no blockers". Refs are always fully
 * qualified with their own `repo` (never left implicit), so a caller merging them into another
 * node's `dependsOn` cannot mistake "same repo as the queried issue" for "same repo as some other
 * fallback" (#760 cross-repo bug).
 */
export async function fetchNativeBlockedBy(repo: string, number: string, gh: GhRunner = defaultGhRunner): Promise<TaskRef[]> {
  let out: string;
  try {
    out = await gh(['api', `repos/${repo}/issues/${number}/dependencies/blocked_by`]);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const items = JSON.parse(out) as GitHubBlockedByItem[];
  return items.map((item) => ({ repo: item.repository?.full_name ?? repo, number: String(item.number) }));
}

/**
 * Resolve one dependency ref's status (met = its PR merged, or the issue closed other than as not
 * planned — `state_reason` is null for one closed without a reason) plus its own `dependsOn` (native +
 * body fallback, both fully qualified to this ref's own repo), for `checkDependencies`'s graph walk. Only a 404 on the issue itself (deleted issue, bad number) comes
 * back `missing` rather than throwing — any other error (rate limit, auth, network) propagates, so a
 * transient failure fails the run loudly instead of being silently read as "this reference does not
 * exist" (needs_info) or "no blockers" (ready).
 */
export async function resolveGithubDependencyNode(ref: TaskRef, fallbackRepo: string, gh: GhRunner = defaultGhRunner): Promise<DependencyNode> {
  const repo = ref.repo ?? fallbackRepo;
  let out: string;
  try {
    out = await gh(['api', `repos/${repo}/issues/${ref.number}`]);
  } catch (error) {
    if (isNotFoundError(error)) return { met: false, missing: true, dependsOn: [] };
    throw error;
  }
  const native = await fetchNativeBlockedBy(repo, ref.number, gh);
  const data = JSON.parse(out) as {
    state?: string;
    state_reason?: string | null;
    body?: string | null;
    pull_request?: { merged_at?: string | null } | null;
  };
  const fromBody = parseDependsOnBody(data.body ?? '').map((r) => (r.repo !== undefined ? r : { ...r, repo }));
  const met =
    data.pull_request != null
      ? data.pull_request.merged_at != null
      : data.state === 'closed' && data.state_reason !== 'not_planned';
  return { met, dependsOn: mergeDependsOn(native, fromBody) };
}

/**
 * Check a fetched GitHub task's readiness against its dependencies and start date (#760). `task`
 * supplies the body-fallback `dependsOn`/`startDate` already parsed by `toTask`; native "blocked by"
 * relations are fetched fresh here (not cached on `Task`, so plain `fetch()`/`list()` stay a single
 * round trip for every caller that does not need dependency gating).
 */
export async function checkGithubDependencies(
  repo: string,
  task: Task,
  issueRef: string,
  gh: GhRunner = defaultGhRunner,
  now?: Date,
): Promise<DependencyCheck> {
  const number = issueNumber(issueRef);
  const native = await fetchNativeBlockedBy(repo, number, gh);
  const dependsOn = mergeDependsOn(native, task.dependsOn ?? []);
  const self: TaskRef = { repo, number };
  return checkDependencies(
    { dependsOn, ...(task.startDate !== undefined ? { startDate: task.startDate } : {}) },
    self,
    repo,
    (ref) => resolveGithubDependencyNode(ref, repo, gh),
    now,
  );
}

/**
 * Whether the author of issue or PR `number` is trusted to start work: OWNER/MEMBER/COLLABORATOR, an
 * allowlisted login (--feedback-authors) or a GitHub App bot. `gh issue/pr --json` exposes no author
 * association, so this reads the REST issue (PRs are issues there). A failed lookup fails closed and
 * carries the reason in `error`, so callers can log it apart from an untrusted author.
 */
export async function isTrustedIssueAuthor(
  repo: string,
  number: number | string,
  allowedAuthors: readonly string[] | undefined,
  gh: GhRunner = defaultGhRunner,
): Promise<{ trusted: boolean; author: string; association: string; error?: string }> {
  try {
    const issue = JSON.parse(await gh(['api', `repos/${repo}/issues/${issueNumber(String(number))}`])) as {
      user?: { login?: string } | null;
      author_association?: string;
    };
    const author = issue.user?.login ?? '';
    const association = issue.author_association ?? '';
    const trusted = author !== '' && classifyAuthor(author, association, { allowedAuthors }) !== 'untrusted';
    return { trusted, author, association };
  } catch (error) {
    return { trusted: false, author: '', association: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetches GitHub issues (via the gh CLI) and maps them to Vanguard tasks. */
export class GitHubTaskFetcher implements TaskFetcher {
  constructor(
    private readonly repo: string,
    private readonly gh: GhRunner = defaultGhRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const number = issueNumber(id);
    // `state` is requested so callers that fetch an issue by name (watch --issue) can apply the same
    // open-only gate list() gets from `--state open`.
    const out = await this.gh(['issue', 'view', number, '--repo', this.repo, '--json', 'number,title,body,labels,comments,author,state']);
    return toTask(this.repo, JSON.parse(out) as GitHubIssue);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    // comments are not fetched on bulk list() (avoids N+1); only fetch() returns them.
    // `state` joins --json ONLY when a limit is set (the board call): keeping the unset-limit argv
    // byte-identical protects watch's fetch shape (S9 — conditional by contract, test-pinned).
    const fields = filter?.limit !== undefined ? 'number,title,body,labels,state' : 'number,title,body,labels';
    const args = ['issue', 'list', '--repo', this.repo, '--json', fields, '--state', filter?.state ?? 'open'];
    if (filter?.limit !== undefined) args.push('-L', String(filter.limit));
    if (filter?.labels !== undefined && filter.labels.length > 0) args.push('--label', filter.labels.join(','));
    const out = await this.gh(args);
    return (JSON.parse(out) as GitHubIssue[]).map((issue) => toTask(this.repo, issue));
  }
}

/** Comment a PR link back onto the source GitHub issue (closes the loop). */
export async function commentGithubIssue(
  repo: string,
  issueRef: string,
  body: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await gh(['issue', 'comment', issueNumber(issueRef), '--repo', repo, '--body', redactForPublish(body)]);
}

export async function linkPullRequest(
  repo: string,
  issueRef: string,
  prUrl: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await commentGithubIssue(repo, issueRef, `Vanguard opened a PR for review: ${prUrl}`, gh);
}

/**
 * Ensure a label exists and add it to a PR, surfacing a failed add. For labels that are themselves a
 * review gate (see SourceAdapter#addGateConfigLabel): an unflagged PR reaching a human is worse than
 * a failing run. The pre-create stays tolerant — it already exists on a repo that flagged a PR before,
 * and `gh pr edit --add-label` is the step that must succeed.
 */
export async function addPrGateLabel(repoPath: string, prUrl: string, label: string): Promise<void> {
  try {
    await execa('gh', ['label', 'create', label, '--force'], { cwd: repoPath });
  } catch { /* the add below is the step that must succeed */ }
  await execa('gh', ['pr', 'edit', prUrl, '--add-label', label], { cwd: repoPath });
}

/**
 * Best-effort: ensure a label exists and add it to a PR (used to flag failed proofs for triage).
 * The same two steps as addPrGateLabel, with the add swallowed too — labeling a draft PR must never
 * block the run.
 */
export async function addPrFailureLabel(repoPath: string, prUrl: string, label: string): Promise<void> {
  await addPrGateLabel(repoPath, prUrl, label).catch(() => undefined);
}

/** Add/remove labels on a GitHub issue (used to claim/advance it in the watch loop). */
export async function editGithubLabels(
  repo: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[] },
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  const args = ['issue', 'edit', issueNumber(issueRef), '--repo', repo];
  for (const label of labels.add ?? []) args.push('--add-label', label);
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  if (args.length > 4) await gh(args);
}

/** The default branch is the only branch whose instruction files a review trusts. */
export async function githubDefaultBranch(repoSlug: string, gh: GhRunner = defaultGhRunner): Promise<string> {
  let data: { defaultBranchRef?: { name?: unknown } | null } | null;
  try {
    data = JSON.parse(await gh(['repo', 'view', repoSlug, '--json', 'defaultBranchRef'])) as typeof data;
  } catch (cause) {
    throw new VanguardError('Cannot establish the repository default branch', { cause });
  }
  const name = data?.defaultBranchRef?.name;
  if (typeof name !== 'string' || name.trim() === '') throw new VanguardError('Cannot establish the repository default branch');
  return name;
}
