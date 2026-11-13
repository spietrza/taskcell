import { CLOSING_KEYWORDS } from '../pipeline/conformance-gate.js';
import { classifyAuthor } from '../tasks/comment-trust.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { githubBranchPrefix } from '../tasks/overlap.js';

/** The issue a PR implements: untrusted text the reviewer checks the diff against. */
export interface LinkedIssue {
  /** `owner/repo#N`. */
  ref: string;
  title: string;
  body: string;
  /** Set when the PR body names a different issue than the factory branch: that ref, which was not used. */
  bodyRef?: string;
}

// A closing keyword or `Part of`, then (optionally wrapped in `(`/`[`) a bare `#N` or `owner/repo#N`.
const ISSUE_REF_RE = new RegExp(`\\b(?:${CLOSING_KEYWORDS}|part of)\\s+[(\\[]*([^\\s,;#()\\[\\]]*)#(\\d+)`, 'gi');

type LinkSource = { repoSlug: string; body: string; headRefName: string };

function bodyIssueNumber(pr: LinkSource): number | undefined {
  const body = pr.body.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of body.matchAll(ISSUE_REF_RE)) {
    const repo = match[1] ?? '';
    if (repo === '' || repo.toLowerCase() === pr.repoSlug.toLowerCase()) return Number(match[2]);
  }
  return undefined;
}

function branchIssueNumber(pr: LinkSource): number | undefined {
  const prefix = githubBranchPrefix(pr.repoSlug);
  if (!pr.headRefName.startsWith(prefix)) return undefined;
  const number = /^(\d+)-/.exec(pr.headRefName.slice(prefix.length))?.[1];
  return number === undefined ? undefined : Number(number);
}

/**
 * The issue number a PR implements: the factory branch name first (the host mints that number; the body is
 * written by the agent or the PR author), else a body reference. Only the PR's own repo is accepted: a ref
 * naming another repo must not steer the author-trust check or the fetch there. HTML comments are skipped;
 * unusable references fall through to later ones.
 */
export function linkedIssueNumber(pr: LinkSource): number | undefined {
  return branchIssueNumber(pr) ?? bodyIssueNumber(pr);
}

// The factory's own bot logins: any other `[bot]` App is not trusted to author the issue under review.
const FACTORY_BOT_LOGINS: readonly string[] = ['github-actions', 'github-actions[bot]'];

/**
 * Resolve the linked issue with one `gh api` call. Undefined when none is referenced, the fetch fails or is
 * empty, or its author is not trusted (the implement pipeline's rule): the review then runs and says the
 * criteria were not checked.
 */
export async function resolveLinkedIssue(
  pr: LinkSource,
  opts: { gh?: GhRunner; allowedAuthors?: readonly string[]; botLogins?: readonly string[]; log?: (line: string) => void } = {},
): Promise<LinkedIssue | undefined> {
  const number = linkedIssueNumber(pr);
  if (number === undefined) return undefined;
  const ref = `${pr.repoSlug}#${number}`;
  try {
    const issue = JSON.parse(await (opts.gh ?? defaultGhRunner)(['api', `repos/${pr.repoSlug}/issues/${number}`])) as {
      title?: string;
      body?: string | null;
      user?: { login?: string } | null;
      author_association?: string;
      pull_request?: unknown;
    };
    // `issues/N` also serves pull requests: a PR's text is never the issue.
    if (issue.pull_request !== undefined && issue.pull_request !== null) {
      opts.log?.(`review-pr ${pr.repoSlug}: linked issue ${ref} not used -> it is a pull request`);
      return undefined;
    }
    const author = issue.user?.login ?? '';
    const lowerAuthor = author.toLowerCase();
    const factoryBots = [...FACTORY_BOT_LOGINS, ...(opts.botLogins ?? [])].map((b) => b.toLowerCase());
    const foreignBot = lowerAuthor.endsWith('[bot]') && !factoryBots.includes(lowerAuthor);
    if (author === '' || foreignBot || classifyAuthor(author, issue.author_association ?? '', { allowedAuthors: opts.allowedAuthors, botLogins: opts.botLogins }) === 'untrusted') {
      opts.log?.(`review-pr ${pr.repoSlug}: linked issue ${ref} not used -> author ${author || '(unknown)'} is not trusted`);
      return undefined;
    }
    const title = issue.title ?? '';
    const body = issue.body ?? '';
    if (title.trim() === '' && body.trim() === '') return undefined;
    const bodyNumber = bodyIssueNumber(pr);
    return { ref, title, body, ...(bodyNumber !== undefined && bodyNumber !== number ? { bodyRef: `${pr.repoSlug}#${bodyNumber}` } : {}) };
  } catch (error) {
    opts.log?.(`review-pr ${pr.repoSlug}: linked issue ${ref} fetch failed -> ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
