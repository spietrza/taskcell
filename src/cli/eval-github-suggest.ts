import { escapePromptTags } from '../context/escape.js';
import { redact } from '../core/retrospective-memory.js';
import { GITHUB_REVIEW_LABEL } from '../github-labels.js';
import { defaultGhRunner, githubDefaultBranch } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { VANGUARD_BRANCH_PREFIX } from '../worktree/manager.js';
import type { EvalKind } from '../evals/types.js';
import { EXPECTATION, candidateIdFromUrl } from './eval-candidate.js';
import type { EvalCaseCandidate, GitHubCandidateKind } from './eval-candidate.js';

const DETAIL_MAX_CHARS = 500;

function truncate(text: string, maxChars: number = DETAIL_MAX_CHARS): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Untrusted GitHub text (PR titles, comments, review bodies, commit messages) gets the same treatment
 * as any other tracker text read into a prompt: secrets masked, then `<`/`>` escaped so it cannot break
 * out of a prompt block or forge a `<promise>COMPLETE</promise>` once pasted into an issue. */
function sanitize(text: string): string {
  return escapePromptTags(redact(truncate(text)));
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

function isFactoryBranch(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(VANGUARD_BRANCH_PREFIX);
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
  let prs: GhClosedPr[];
  try {
    prs = JSON.parse(await gh(args)) as GhClosedPr[];
  } catch {
    return [];
  }
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
  const args = [
    'pr', 'list', '--repo', repoSlug, '--state', 'all', '--limit', '100',
    '--label', GITHUB_REVIEW_LABEL,
    '--search', `updated:>=${since}`,
    '--json', 'number,title,url,headRefName,reviews',
  ];
  let prs: GhLabeledPr[];
  try {
    prs = JSON.parse(await gh(args)) as GhLabeledPr[];
  } catch {
    return [];
  }
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
  let branch: string;
  try {
    branch = await githubDefaultBranch(repoSlug, gh);
  } catch {
    return [];
  }

  let commits: GhCommitListItem[];
  try {
    commits = JSON.parse(await gh(['api', `repos/${repoSlug}/commits?sha=${branch}&since=${since}`])) as GhCommitListItem[];
  } catch {
    return [];
  }

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

/** All three GitHub sources, fetched concurrently. Dedup across sources/runs happens in the caller. */
export async function fetchGitHubCandidates(
  repoSlug: string,
  since: string,
  gh: GhRunner = defaultGhRunner,
): Promise<EvalCaseCandidate[]> {
  const [unmerged, needsReview, reverts] = await Promise.all([
    fetchClosedUnmergedCandidates(repoSlug, since, gh),
    fetchNeedsHumanReviewCandidates(repoSlug, since, gh),
    fetchRevertCandidates(repoSlug, since, gh),
  ]);
  return [...unmerged, ...needsReview, ...reverts];
}
