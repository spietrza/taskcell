import { execa } from 'execa';
import { TaskcellError } from '../core/errors.js';
import { classifyAuthor } from './comment-trust.js';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';
import { resolveAdds, resolveRemovals } from '../core/labels.js';
import { redactForPublish } from '../core/secret-scan.js';

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
  /** Requested alongside `state` (board call only — see list()). */
  url?: string;
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
  return {
    id: `${repo}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
    children: [], // the gh issue mapping does not fetch sub-issues
    comments,
    ref: String(issue.number),
    ...(issue.state !== undefined ? { state: issue.state } : {}),
    ...(issue.url !== undefined ? { url: issue.url } : {}),
    ...(issue.author?.login !== undefined ? { author: issue.author.login } : {}),
  };
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

/** Fetches GitHub issues (via the gh CLI) and maps them to Taskcell tasks. */
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
    const fields = filter?.limit !== undefined ? 'number,title,body,labels,state,url' : 'number,title,body,labels';
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
  await commentGithubIssue(repo, issueRef, `Taskcell opened a PR for review: ${prUrl}`, gh);
}

/**
 * Add a label to a PR under the spelling the repo has, surfacing a failed add. For labels that are themselves a
 * review gate (see SourceAdapter#addGateConfigLabel): an unflagged PR reaching a human is worse than
 * a failing run. resolveAdds creates a `taskcell:` label the repo lacks in both spellings (tolerantly; a label
 * with no legacy twin is not created); `gh pr edit --add-label` must succeed.
 */
export async function addPrGateLabel(repoPath: string, prUrl: string, label: string): Promise<void> {
  const gh = async (args: string[]): Promise<string> => (await execa('gh', args, { cwd: repoPath })).stdout;
  // A repo that has only the legacy spelling gets that one, not a second label beside it (`--repo` takes the repo URL).
  const [name = label] = await resolveAdds([label], prUrl.replace(/\/pull\/\d+.*$/, ''), gh, [label]);
  await gh(['pr', 'edit', prUrl, '--add-label', name]);
}

/**
 * Best-effort: add a label to a PR (used to flag failed proofs for triage).
 * The same two steps as addPrGateLabel, with the add swallowed too — labeling a draft PR must never
 * block the run.
 */
export async function addPrFailureLabel(repoPath: string, prUrl: string, label: string): Promise<void> {
  await addPrGateLabel(repoPath, prUrl, label).catch(() => undefined);
}

/** The label names currently on a GitHub issue. */
async function issueLabelNames(repo: string, issueRef: string, gh: GhRunner): Promise<string[]> {
  const view = JSON.parse(await gh(['issue', 'view', issueNumber(issueRef), '--repo', repo, '--json', 'labels'])) as { labels?: GitHubLabel[] };
  return (view.labels ?? []).map((l) => l.name);
}

/**
 * Add/remove labels on a GitHub issue (used to claim/advance it in the watch loop). `ensure` names the added
 * labels to force-create when the repo's labels cannot be listed (see resolveAdds).
 */
export async function editGithubLabels(
  repo: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[]; ensure?: string[] },
  gh: GhRunner = defaultGhRunner,
  log: (line: string) => void = console.log,
): Promise<void> {
  const args = ['issue', 'edit', issueNumber(issueRef), '--repo', repo];
  for (const label of await resolveAdds(labels.add ?? [], repo, gh, labels.ensure)) args.push('--add-label', label);
  const remove = await resolveRemovals(labels.remove ?? [], () => issueLabelNames(repo, issueRef, gh), (label) => log(`taskcell: ${repo}#${issueNumber(issueRef)}: not removing ${label} -> the issue's labels do not show it`));
  for (const label of remove) args.push('--remove-label', label);
  // Nothing left to change (the issue lacks every label to remove): `gh issue edit` without a field flag fails.
  if (args.length > 5) await gh(args);
}

/** The default branch is the only branch whose instruction files a review trusts. */
export async function githubDefaultBranch(repoSlug: string, gh: GhRunner = defaultGhRunner): Promise<string> {
  let data: { defaultBranchRef?: { name?: unknown } | null } | null;
  try {
    data = JSON.parse(await gh(['repo', 'view', repoSlug, '--json', 'defaultBranchRef'])) as typeof data;
  } catch (cause) {
    throw new TaskcellError('Cannot establish the repository default branch', { cause });
  }
  const name = data?.defaultBranchRef?.name;
  if (typeof name !== 'string' || name.trim() === '') throw new TaskcellError('Cannot establish the repository default branch');
  return name;
}
