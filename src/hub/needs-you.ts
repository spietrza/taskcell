// The hub's "Needs you" read model + reply action (src/hub/ scope): lists GitHub issues/PRs that
// wait on a human, using `gh` and labels only — no model call — and posts a human's reply back,
// moving the item on to the factory's next trigger label. See docs/hub.md.
import { defaultGhRunner, commentGithubIssue } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { commentPullRequest } from '../runners/pr-review.js';
import { redactForPublish } from '../core/secret-scan.js';
import { escapePromptTags } from '../context/escape.js';
import { isBotLogin } from '../tasks/comment-trust.js';
import { GITHUB_REVIEW_LABEL, GITHUB_VERIFY_FAILED_LABEL } from '../github-labels.js';
import { VanguardError } from '../core/errors.js';

export const NEEDS_INFO_LABEL = 'needs info';
export const READY_FOR_AGENT_LABEL = 'ready for agent';
export const NEEDS_REVISION_LABEL = 'needs revision';

export interface NeedsYouItem {
  /** `owner/repo#number` — also the `id` a reply targets. */
  id: string;
  kind: 'issue' | 'pr';
  number: number;
  repoSlug: string;
  title: string;
  url: string;
  /** Why this item waits: the label name, or `'changes requested'` for a PR review verdict. */
  reason: string;
  /** The factory's own last comment on the item, redacted and escaped as untrusted text. Absent when it never commented. */
  lastComment?: { author: string; body: string };
}

interface GhLabelLite {
  name: string;
}

interface GhCommentLite {
  author?: { login?: string } | null;
  body?: string;
}

interface GhIssueLite {
  number: number;
  title: string;
  url: string;
  labels: GhLabelLite[];
  comments?: GhCommentLite[];
}

interface GhPrLite extends GhIssueLite {
  reviewDecision?: string | null;
}

/** The factory's own last comment on the item — redacted, then escaped so untrusted text cannot
 * break out of whatever block the hub UI renders it into. */
function lastFactoryComment(comments: GhCommentLite[] | undefined): { author: string; body: string } | undefined {
  const own = (comments ?? []).filter((c) => isBotLogin(c.author?.login ?? ''));
  const last = own.at(-1);
  if (last === undefined) return undefined;
  return { author: last.author?.login ?? '', body: escapePromptTags(redactForPublish(last.body ?? '')) };
}

/** Why a PR waits for a human, or undefined if it doesn't (the acceptance-criteria vocabulary). */
function prReason(pr: { labels: GhLabelLite[]; reviewDecision?: string | null }): string | undefined {
  const labels = new Set(pr.labels.map((l) => l.name));
  if (labels.has(GITHUB_REVIEW_LABEL)) return GITHUB_REVIEW_LABEL;
  if (labels.has(GITHUB_VERIFY_FAILED_LABEL)) return GITHUB_VERIFY_FAILED_LABEL;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  return undefined;
}

const ISSUE_FIELDS = 'number,title,url,labels,comments';
const PR_FIELDS = 'number,title,url,labels,comments,reviewDecision';

/** Builds a `NeedsYouItem` shared by issues and PRs — the two only differ in `kind` and `reason`. */
function toItem(repoSlug: string, kind: 'issue' | 'pr', raw: GhIssueLite, reason: string): NeedsYouItem {
  const lastComment = lastFactoryComment(raw.comments);
  return {
    id: `${repoSlug}#${raw.number}`,
    kind,
    number: raw.number,
    repoSlug,
    title: raw.title,
    url: raw.url,
    reason,
    ...(lastComment !== undefined ? { lastComment } : {}),
  };
}

/**
 * List the items of `repoSlug` waiting for a human: issues at `needs info`, and PRs at
 * `vanguard:needs-human-review`/`vanguard:verify-failed` or with a review requesting changes.
 */
export async function listNeedsYou(repoSlug: string, gh: GhRunner = defaultGhRunner): Promise<NeedsYouItem[]> {
  const [issuesOut, prsOut] = await Promise.all([
    gh(['issue', 'list', '--repo', repoSlug, '--state', 'open', '--label', NEEDS_INFO_LABEL, '--json', ISSUE_FIELDS]),
    gh(['pr', 'list', '--repo', repoSlug, '--state', 'open', '--json', PR_FIELDS]),
  ]);

  const issues = JSON.parse(issuesOut) as GhIssueLite[];
  const prs = JSON.parse(prsOut) as GhPrLite[];

  const issueItems = issues.map((issue) => toItem(repoSlug, 'issue', issue, NEEDS_INFO_LABEL));
  const prItems = prs.flatMap((pr) => {
    const reason = prReason(pr);
    return reason === undefined ? [] : [toItem(repoSlug, 'pr', pr, reason)];
  });

  return [...issueItems, ...prItems];
}

function parseId(id: string): { repoSlug: string; number: string } {
  const hash = id.lastIndexOf('#');
  const number = hash === -1 ? '' : id.slice(hash + 1);
  if (hash === -1 || !/^\d+$/.test(number)) throw new VanguardError(`Invalid item id: ${id}`);
  return { repoSlug: id.slice(0, hash), number };
}

async function ensureLabel(repoSlug: string, label: string, gh: GhRunner): Promise<void> {
  await gh(['label', 'create', label, '--repo', repoSlug, '--force']).catch(() => undefined);
}

async function issueIsWaiting(repoSlug: string, number: string, gh: GhRunner): Promise<boolean> {
  const out = await gh(['issue', 'view', number, '--repo', repoSlug, '--json', 'state,labels']);
  const issue = JSON.parse(out) as { state: string; labels: GhLabelLite[] };
  return issue.state === 'OPEN' && issue.labels.some((l) => l.name === NEEDS_INFO_LABEL);
}

async function prIsWaiting(repoSlug: string, number: string, gh: GhRunner): Promise<boolean> {
  const out = await gh(['pr', 'view', number, '--repo', repoSlug, '--json', 'state,labels,reviewDecision']);
  const pr = JSON.parse(out) as { state: string; labels: GhLabelLite[]; reviewDecision?: string | null };
  return pr.state === 'OPEN' && prReason(pr) !== undefined;
}

/**
 * Post `body` as the caller's own comment, then move the item on to the factory's next trigger
 * label — `needs info` -> `ready for agent` for an issue, or `needs revision` added for a PR.
 * Refuses (no comment, no label change) when the item is no longer in a waiting state: a stale
 * read model, or two people replying to the same item, must never relabel out from under it.
 */
export async function replyNeedsYou(id: string, kind: 'issue' | 'pr', body: string, gh: GhRunner = defaultGhRunner): Promise<void> {
  const { repoSlug, number } = parseId(id);

  if (kind === 'issue') {
    if (!(await issueIsWaiting(repoSlug, number, gh))) {
      throw new VanguardError(`${id} is not waiting for a reply (no longer labelled "${NEEDS_INFO_LABEL}").`);
    }
    await commentGithubIssue(repoSlug, number, body, gh);
    await ensureLabel(repoSlug, READY_FOR_AGENT_LABEL, gh);
    await gh(['issue', 'edit', number, '--repo', repoSlug, '--remove-label', NEEDS_INFO_LABEL, '--add-label', READY_FOR_AGENT_LABEL]);
    return;
  }

  if (!(await prIsWaiting(repoSlug, number, gh))) {
    throw new VanguardError(`${id} is not waiting for a reply.`);
  }
  await commentPullRequest({ repoSlug, number: Number(number) }, body, gh);
  await ensureLabel(repoSlug, NEEDS_REVISION_LABEL, gh);
  await gh(['pr', 'edit', number, '--repo', repoSlug, '--add-label', NEEDS_REVISION_LABEL]);
}
