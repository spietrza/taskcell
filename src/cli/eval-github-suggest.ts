import { escapePromptTags, neutralizeMentions } from '../context/escape.js';
import { redact } from '../core/retrospective-memory.js';
import { labelForms } from '../core/labels.js';
import { GITHUB_REVIEW_LABEL } from '../github-labels.js';
import { defaultGhRunner, githubDefaultBranch } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { isFactoryBranch } from '../worktree/manager.js';
import type { EvalKind } from '../evals/types.js';
import { EXPECTATION, candidateIdFromUrl } from './eval-candidate.js';
import type { EvalCaseCandidate, GitHubCandidateKind } from './eval-candidate.js';

const DETAIL_MAX_CHARS = 500;

function truncate(text: string, maxChars: number = DETAIL_MAX_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Untrusted GitHub text (PR titles, comments, review bodies, commit messages) gets the same treatment
 * as any other tracker text read into a prompt: secrets masked, then `<`/`>` escaped so it cannot break
 * out of a prompt block or forge a `<promise>COMPLETE</promise>` once pasted into an issue, and finally
 * `@mentions` defused so pasting the drafts into an issue notifies nobody. */
function sanitize(text: string): string {
  return neutralizeMentions(escapePromptTags(redact(truncate(text))));
}

/** Exhaustive over GitHubCandidateKind; 'refusal' is never auto-guessed (no refusal signal from GitHub). */
function guessGithubKind(kind: GitHubCandidateKind): Exclude<EvalKind, 'refusal'> {
  switch (kind) {
    case 'pr_closed_unmerged':
      return 'control';
    case 'pr_needs_human_review':
      return 'edge';
    case 'reverted_commit':
      return 'control';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

interface BuildArgs {
  kind: GitHubCandidateKind;
  url: string;
  issueNumber: number;
  title: string;
  reason: string;
}

function buildCandidate(args: BuildArgs): EvalCaseCandidate {
  const kind = guessGithubKind(args.kind);
  const title = sanitize(args.title);
  const reason = sanitize(args.reason);
  const input = `Reproduce and prevent the rejected change in ${args.url} (#${args.issueNumber}, "${title}"): ${reason}`;

  return {
    case: { id: candidateIdFromUrl(args.url), kind, input, expectation: EXPECTATION },
    source: args.kind,
    reason,
    provenance: { url: args.url, issueNumber: args.issueNumber },
  };
}

// ─── Source 1: factory PR closed without merge ────────────────────────────────

interface GhPrComment {
  author?: { login?: string } | null;
  body?: string | null;
}

interface GhClosedPr {
  number: number;
  title: string;
  url: string;
  headRefName?: string;
  mergedAt?: string | null;
  comments?: GhPrComment[];
}

/** The last comment before close stands in for "closing comment"; gh has no dedicated field for it. */
function closingComment(comments: GhPrComment[] | undefined): string {
  const last = (comments ?? []).at(-1);
  const body = last?.body?.trim();
  return body !== undefined && body !== '' ? body : '(no closing comment)';
}

/** Factory PRs closed without merge since `since` (ISO date) — the strongest "human rejected this" signal. */
export async function fetchClosedUnmergedCandidates(
  repoSlug: string,
  since: string,
  gh: GhRunner = defaultGhRunner,
): Promise<EvalCaseCandidate[]> {
  const args = [
    'pr', 'list', '--repo', repoSlug, '--state', 'closed', '--limit', '100',
    '--search', `closed:>=${since}`,
    '--json', 'number,title,url,headRefName,mergedAt,comments',
  ];
  const prs = JSON.parse(await gh(args)) as GhClosedPr[];
  return prs
    .filter((pr) => (pr.mergedAt ?? null) === null && isFactoryBranch(pr.headRefName))
    .map((pr) =>
      buildCandidate({
        kind: 'pr_closed_unmerged',
        url: pr.url,
        issueNumber: pr.number,
        title: pr.title,
        reason: closingComment(pr.comments),
      }),
    );
}

// ─── Source 2: factory PR that ended needs-human-review after the revision cap ────

interface GhPrReview {
  state?: string;
  body?: string | null;
}

interface GhLabeledPr {
  number: number;
  title: string;
  url: string;
  headRefName?: string;
  reviews?: GhPrReview[];
}

/** The most recent review's state + body stands in for "last review verdict". */
function lastReviewVerdict(reviews: GhPrReview[] | undefined): string {
  const last = (reviews ?? []).at(-1);
  if (last === undefined) return '(no review recorded)';
  const state = last.state ?? 'UNKNOWN';
  const body = last.body?.trim();
  return body !== undefined && body !== '' ? `${state}: ${body}` : state;
}

/** Factory PRs labeled needs-human-review (the revision cap was hit) since `since` (ISO date). */
export async function fetchNeedsHumanReviewCandidates(
  repoSlug: string,
  since: string,
  gh: GhRunner = defaultGhRunner,
): Promise<EvalCaseCandidate[]> {
  const lists = await Promise.all(labelForms(GITHUB_REVIEW_LABEL).map(async (label) => {
    const args = [
      'pr', 'list', '--repo', repoSlug, '--state', 'all', '--limit', '100',
      '--label', label,
      '--search', `updated:>=${since}`,
      '--json', 'number,title,url,headRefName,reviews',
    ];
    return JSON.parse(await gh(args)) as GhLabeledPr[];
  }));
  const prs = [...new Map(lists.flat().map((pr) => [pr.number, pr])).values()];
  return prs
    .filter((pr) => isFactoryBranch(pr.headRefName))
    .map((pr) =>
      buildCandidate({
        kind: 'pr_needs_human_review',
        url: pr.url,
        issueNumber: pr.number,
        title: pr.title,
        reason: lastReviewVerdict(pr.reviews),
      }),
    );
}

// ─── Source 3: revert commit on the default branch targeting a factory commit ─────

interface GhCommitListItem {
  sha: string;
  html_url: string;
  commit: { message: string };
}

interface GhCommitPullItem {
  number: number;
  head?: { ref?: string };
}

const REVERT_RE = /^Revert "/;
const REVERTED_SHA_RE = /This reverts commit ([0-9a-f]{7,40})/;

/** Revert commits on the default branch whose target was a factory PR's head, since `since` (ISO date). */
export async function fetchRevertCandidates(
  repoSlug: string,
  since: string,
  gh: GhRunner = defaultGhRunner,
): Promise<EvalCaseCandidate[]> {
  const branch = await githubDefaultBranch(repoSlug, gh);
  // --paginate --slurp: one JSON array of pages, so a busy week past the first page is not dropped.
  const pages = JSON.parse(
    await gh(['api', '--paginate', '--slurp', `repos/${repoSlug}/commits?sha=${branch}&since=${since}&per_page=100`]),
  ) as GhCommitListItem[][];
  const commits = pages.flat();

  const candidates: EvalCaseCandidate[] = [];
  for (const commit of commits) {
    const message = commit.commit.message;
    if (!REVERT_RE.test(message)) continue;
    const match = REVERTED_SHA_RE.exec(message);
    if (match === null || match[1] === undefined) continue;
    const targetSha = match[1];

    let pulls: GhCommitPullItem[];
    try {
      pulls = JSON.parse(await gh(['api', `repos/${repoSlug}/commits/${targetSha}/pulls`])) as GhCommitPullItem[];
    } catch {
      continue;
    }
    const factoryPr = pulls.find((pr) => isFactoryBranch(pr.head?.ref));
    if (factoryPr === undefined) continue;

    candidates.push(
      buildCandidate({
        kind: 'reverted_commit',
        url: commit.html_url,
        issueNumber: factoryPr.number,
        title: message.split('\n')[0] ?? message,
        reason: message,
      }),
    );
  }
  return candidates;
}

// ─── Combinator ─────────────────────────────────────────────────────────────────

/**
 * All three GitHub sources, fetched concurrently. Dedup across sources/runs happens in the caller.
 * A failed source is warned on stderr; when every source fails this throws, so a scheduled job cannot
 * mistake "gh is not logged in" for "nothing was rejected this week".
 */
export async function fetchGitHubCandidates(
  repoSlug: string,
  since: string,
  gh: GhRunner = defaultGhRunner,
  warn: (message: string) => void = (message) => console.error(message),
): Promise<EvalCaseCandidate[]> {
  const sources = ['closed unmerged PRs', 'needs-human-review PRs', 'reverted commits'] as const;
  const results = await Promise.allSettled([
    fetchClosedUnmergedCandidates(repoSlug, since, gh),
    fetchNeedsHumanReviewCandidates(repoSlug, since, gh),
    fetchRevertCandidates(repoSlug, since, gh),
  ]);
  const candidates: EvalCaseCandidate[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value);
      return;
    }
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    warn(`warning: could not read ${sources[i]} from ${repoSlug}: ${reason}`);
  });
  if (results.every((result) => result.status === 'rejected')) {
    throw new Error(`every GitHub source failed for ${repoSlug}; is gh authenticated?`);
  }
  return candidates;
}
