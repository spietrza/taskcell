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
}

// A closing keyword or `Part of`, then (optionally wrapped in `(`/`[`) a bare `#N` or `owner/repo#N`.
const ISSUE_REF_RE = new RegExp(`\\b(?:${CLOSING_KEYWORDS}|part of)\\s+[(\\[]*([^\\s,;#()\\[\\]]*)#(\\d+)`, 'gi');

type LinkSource = { repoSlug: string; body: string; headRefName: string };

/**
 * The issue number a PR implements: a body reference first, else the factory branch name. Only the PR's own
 * repo is accepted: the body is untrusted, and a ref naming another repo must not steer the author-trust
 * check or the fetch there. HTML comments are skipped; unusable references fall through to later ones.
 */
export function linkedIssueNumber(pr: LinkSource): number | undefined {
  const body = pr.body.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of body.matchAll(ISSUE_REF_RE)) {
    const repo = match[1] ?? '';
    if (repo === '' || repo.toLowerCase() === pr.repoSlug.toLowerCase()) return Number(match[2]);
  }
  const prefix = githubBranchPrefix(pr.repoSlug);
  if (!pr.headRefName.startsWith(prefix)) return undefined;
  const number = /^(\d+)-/.exec(pr.headRefName.slice(prefix.length))?.[1];
  return number === undefined ? undefined : Number(number);
}

/**
 * Resolve the linked issue with one `gh api` call. Undefined when none is referenced, the fetch fails or is
 * empty, or its author is not trusted (the implement pipeline's rule): the review then runs and says the
 * criteria were not checked.
 */
export async function resolveLinkedIssue(
  pr: LinkSource,
  opts: { gh?: GhRunner; allowedAuthors?: readonly string[]; log?: (line: string) => void } = {},
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
    };
    const author = issue.user?.login ?? '';
    if (author === '' || classifyAuthor(author, issue.author_association ?? '', { allowedAuthors: opts.allowedAuthors }) === 'untrusted') {
      opts.log?.(`review-pr ${pr.repoSlug}: linked issue ${ref} not used -> author ${author || '(unknown)'} is not trusted`);
      return undefined;
    }
    const title = issue.title ?? '';
    const body = issue.body ?? '';
    if (title.trim() === '' && body.trim() === '') return undefined;
    return { ref, title, body };
  } catch (error) {
    opts.log?.(`review-pr ${pr.repoSlug}: linked issue ${ref} fetch failed -> ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
