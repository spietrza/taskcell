// The hub's "Needs you" read model + reply action (src/hub/ scope): lists GitHub issues/PRs that
// wait on a human, using `gh` and labels only — no model call — and posts a human's reply back,
// moving the item on to the factory's next trigger label. See docs/hub.md.
import { defaultGhRunner, commentGithubIssue } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { commentPullRequest } from '../runners/pr-review.js';
import { redactForPublish } from '../core/secret-scan.js';
import { escapePromptTags } from '../context/escape.js';
import { DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_NEEDS_INFO_LABEL } from '../cli/args.js';
import { GITHUB_REVIEW_LABEL, GITHUB_VERIFY_FAILED_LABEL } from '../github-labels.js';
import { VanguardError } from '../core/errors.js';

/** The revise-pr trigger (DEFAULT_TRIGGER_LABELS in src/runners/resume-rate-limited.ts). */
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

export interface NeedsYouOptions {
  /** Extra logins that are the factory's own voice, as ActionableOptions.botLogins. */
  botLogins?: readonly string[];
  /** Cap on the open issues/PRs each `gh` list returns (`-L`). */
  limit?: number;
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
}

interface GhPrLite extends GhIssueLite {
  reviewDecision?: string | null;
}

/** `owner/repo`, the only shape that may reach a `--repo` flag: no leading `-`, no path traversal. */
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function assertRepoSlug(repoSlug: string): void {
  if (!REPO_SLUG_RE.test(repoSlug)) throw new VanguardError(`Invalid repo slug: ${repoSlug}`);
}

/** The login Vanguard comments under from CI (see src/tasks/comment-trust.ts). */
const CI_LOGINS = ['github-actions', 'github-actions[bot]'];

/**
 * The logins that are the factory's *own* voice: the `gh` user the hub acts as, the CI identity
 * Vanguard comments under, and any bot logins the operator configured. Deliberately not
 * `isBotLogin`, whose wide `[bot]` match would show Dependabot/Renovate chatter as something the
 * factory is asking. A failed `gh api user` only drops the local identity.
 */
async function ownLogins(gh: GhRunner, botLogins: readonly string[]): Promise<Set<string>> {
  const self = await gh(['api', 'user', '--jq', '.login']).then(
    (out) => out.trim(),
    () => '',
  );
  return new Set([...CI_LOGINS, ...botLogins, self].filter((login) => login !== '').map((login) => login.toLowerCase()));
}

/**
 * The factory's own last comment on one waiting item — redacted, then escaped so untrusted text
 * cannot break out of whatever block the hub UI renders it into. Fetched per waiting item: asking
 * the list calls for `comments` would download every comment of every open issue and PR.
 */
async function lastOwnComment(
  repoSlug: string,
  kind: 'issue' | 'pr',
  number: number,
  own: Set<string>,
  gh: GhRunner,
): Promise<{ author: string; body: string } | undefined> {
  const out = await gh([kind, 'view', String(number), '--repo', repoSlug, '--json', 'comments']);
  const comments = (JSON.parse(out) as { comments?: GhCommentLite[] }).comments ?? [];
  const last = comments.filter((c) => own.has((c.author?.login ?? '').toLowerCase())).at(-1);
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

const ISSUE_FIELDS = 'number,title,url,labels';
const PR_FIELDS = 'number,title,url,labels,reviewDecision';
/** Explicit `-L`: gh's own default (30) would silently hide waiting items on a busy repo. */
const DEFAULT_LIST_LIMIT = 100;

/** Builds a `NeedsYouItem` shared by issues and PRs — the two only differ in `kind` and `reason`. */
function toItem(
  repoSlug: string,
  kind: 'issue' | 'pr',
  raw: GhIssueLite,
  reason: string,
  lastComment: { author: string; body: string } | undefined,
): NeedsYouItem {
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
export async function listNeedsYou(
  repoSlug: string,
  gh: GhRunner = defaultGhRunner,
  opts: NeedsYouOptions = {},
): Promise<NeedsYouItem[]> {
  assertRepoSlug(repoSlug);
  const scope = ['--repo', repoSlug, '--state', 'open', '-L', String(opts.limit ?? DEFAULT_LIST_LIMIT)];
  const [issuesOut, prsOut] = await Promise.all([
    gh(['issue', 'list', ...scope, '--label', DEFAULT_GITHUB_NEEDS_INFO_LABEL, '--json', ISSUE_FIELDS]),
    gh(['pr', 'list', ...scope, '--json', PR_FIELDS]),
  ]);

  const issueItems = (JSON.parse(issuesOut) as GhIssueLite[]).map((raw) => ({
    kind: 'issue' as const,
    raw,
    reason: DEFAULT_GITHUB_NEEDS_INFO_LABEL,
  }));
  const prItems = (JSON.parse(prsOut) as GhPrLite[]).flatMap((raw) => {
    const reason = prReason(raw);
    return reason === undefined ? [] : [{ kind: 'pr' as const, raw, reason }];
  });

  const waiting = [...issueItems, ...prItems];
  if (waiting.length === 0) return []; // nothing waits — no identity lookup, no comment fetch

  const own = await ownLogins(gh, opts.botLogins ?? []);
  return Promise.all(
    waiting.map(async ({ kind, raw, reason }) => {
      const lastComment = await lastOwnComment(repoSlug, kind, raw.number, own, gh);
      return toItem(repoSlug, kind, raw, reason, lastComment);
    }),
  );
}

/**
 * The item number `id` names. `id` travels from the client while `repoSlug` is derived from the
 * allowlisted repo path, so an `id` naming another repo must be refused: the allowlist would
 * otherwise be bypassed by commenting on and relabelling an unregistered repo.
 */
function itemNumber(repoSlug: string, id: string): string {
  const hash = id.lastIndexOf('#');
  const number = id.slice(hash + 1);
  if (hash === -1 || !/^\d+$/.test(number)) throw new VanguardError(`Invalid item id: ${id}`);
  if (id.slice(0, hash) !== repoSlug) throw new VanguardError(`${id} is not an item of ${repoSlug}`);
  return number;
}

async function ensureLabel(repoSlug: string, label: string, gh: GhRunner): Promise<void> {
  await gh(['label', 'create', label, '--repo', repoSlug, '--force']).catch(() => undefined);
}

async function issueIsWaiting(repoSlug: string, number: string, gh: GhRunner): Promise<boolean> {
  const out = await gh(['issue', 'view', number, '--repo', repoSlug, '--json', 'state,labels']);
  const issue = JSON.parse(out) as { state: string; labels: GhLabelLite[] };
  return issue.state === 'OPEN' && issue.labels.some((l) => l.name === DEFAULT_GITHUB_NEEDS_INFO_LABEL);
}

async function prIsWaiting(repoSlug: string, number: string, gh: GhRunner): Promise<boolean> {
  const out = await gh(['pr', 'view', number, '--repo', repoSlug, '--json', 'state,labels,reviewDecision']);
  const pr = JSON.parse(out) as { state: string; labels: GhLabelLite[]; reviewDecision?: string | null };
  return pr.state === 'OPEN' && prReason(pr) !== undefined;
}

/**
 * Post `body` as the caller's own comment on `id` — an item of `repoSlug`, never of the repo the
 * `id` itself names — then move it on to the factory's next trigger label: `needs info` ->
 * `ready for agent` for an issue, or `needs revision` added for a PR. Refuses (no comment, no label
 * change) when the item is no longer in a waiting state: a stale read model, or two people replying
 * to the same item, must never relabel out from under it.
 */
export async function replyNeedsYou(
  repoSlug: string,
  id: string,
  kind: 'issue' | 'pr',
  body: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  assertRepoSlug(repoSlug);
  const number = itemNumber(repoSlug, id);

  if (kind === 'issue') {
    if (!(await issueIsWaiting(repoSlug, number, gh))) {
      throw new VanguardError(`${id} is not waiting for a reply (no longer labelled "${DEFAULT_GITHUB_NEEDS_INFO_LABEL}").`);
    }
    await commentGithubIssue(repoSlug, number, body, gh);
    await ensureLabel(repoSlug, DEFAULT_GITHUB_AGENT_LABEL, gh);
    await gh(['issue', 'edit', number, '--repo', repoSlug, '--remove-label', DEFAULT_GITHUB_NEEDS_INFO_LABEL, '--add-label', DEFAULT_GITHUB_AGENT_LABEL]);
    return;
  }

  if (!(await prIsWaiting(repoSlug, number, gh))) {
    throw new VanguardError(`${id} is not waiting for a reply.`);
  }
  await commentPullRequest({ repoSlug, number: Number(number) }, body, gh);
  await ensureLabel(repoSlug, NEEDS_REVISION_LABEL, gh);
  await gh(['pr', 'edit', number, '--repo', repoSlug, '--add-label', NEEDS_REVISION_LABEL]);
}
