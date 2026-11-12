// The hub's "Needs you" read model + reply action (src/hub/ scope): lists GitHub issues/PRs that
// wait on a human, using `gh` and labels only — no model call — and posts a human's reply back,
// moving the item on to the factory's next trigger label. See docs/hub.md.
import { defaultGhRunner, commentGithubIssue } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { commentPullRequest } from '../runners/pr-review.js';
import { redactForPublish } from '../core/secret-scan.js';
import { DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_NEEDS_INFO_LABEL } from '../cli/args.js';
import { GITHUB_REVIEW_LABEL, GITHUB_VERIFY_FAILED_LABEL } from '../github-labels.js';
import { shownBaseFromLabels } from '../core/base-branch.js';
import { TaskcellError } from '../core/errors.js';
import { fanOut } from '../pipeline/fan-out.js';

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
  /** A PR's base (target) branch, which a merge lands on. Absent for an issue. */
  baseRef?: string;
  /** The factory's own last comment on the item, redacted; untrusted text the UI renders as plain text. Absent when it never commented. */
  lastComment?: { author: string; body: string };
  /** The branch the PR targets (a PR's base), or the one the card asks for (`vanguard:base=`). Absent when unknown. */
  baseBranch?: string;
}

export interface NeedsYouOptions {
  /** Extra logins that are the factory's own voice, as ActionableOptions.botLogins. */
  botLogins?: readonly string[];
  /** Cap on the open issues/PRs each `gh` list returns (`-L`). */
  limit?: number;
  /** A comment-fetch budget shared across calls (the all-repositories list): each call takes what it fetches from `remaining`. */
  commentBudget?: { remaining: number };
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
  baseRefName?: string;
}

/** `owner/repo`, the only shape that may reach a `--repo` flag: no leading `-`, no path traversal. */
const REPO_SLUG_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

export function assertRepoSlug(repoSlug: string): void {
  if (!REPO_SLUG_RE.test(repoSlug)) throw new TaskcellError(`Invalid repo slug: ${repoSlug}`);
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
 * The factory's own last comment on one waiting item, redacted. Not escaped: it is untrusted text
 * the hub UI renders as a plain text node (NeedsYou.tsx), never as HTML. Fetched per waiting item: asking
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
  return { author: last.author?.login ?? '', body: redactForPublish(last.body ?? '') };
}

/**
 * Why a PR waits for a human, or undefined if it doesn't (the acceptance-criteria vocabulary).
 * A PR at `needs revision` is the factory's turn — a human (or a hub reply) already asked for one.
 */
function prReason(pr: { labels: GhLabelLite[]; reviewDecision?: string | null }): string | undefined {
  const labels = new Set(pr.labels.map((l) => l.name));
  if (labels.has(NEEDS_REVISION_LABEL)) return undefined;
  if (labels.has(GITHUB_REVIEW_LABEL)) return GITHUB_REVIEW_LABEL;
  if (labels.has(GITHUB_VERIFY_FAILED_LABEL)) return GITHUB_VERIFY_FAILED_LABEL;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  return undefined;
}

const ISSUE_FIELDS = 'number,title,url,labels';
const PR_FIELDS = 'number,title,url,labels,reviewDecision,baseRefName';
/** Explicit `-L`: gh's own default (30) would silently hide waiting items on a busy repo. */
const DEFAULT_LIST_LIMIT = 100;
/** Concurrent `gh … view --json comments` calls per list — one per waiting item, bounded. */
const COMMENT_FETCH_CONCURRENCY = 4;
/** Only the first this-many waiting items get `lastComment`: the rest are listed without it, to spare the API quota the factory shares. */
export const MAX_COMMENT_FETCHES = 30;

/** Builds a `NeedsYouItem` shared by issues and PRs — the two only differ in `kind` and `reason`. */
function toItem(
  repoSlug: string,
  kind: 'issue' | 'pr',
  raw: GhIssueLite & { baseRefName?: string },
  reason: string,
  lastComment: { author: string; body: string } | undefined,
): NeedsYouItem {
  const baseBranch = raw.baseRefName ?? shownBaseFromLabels(raw.labels.map((l) => l.name));
  return {
    id: `${repoSlug}#${raw.number}`,
    kind,
    number: raw.number,
    repoSlug,
    title: raw.title,
    url: raw.url,
    reason,
    ...(raw.baseRefName !== undefined ? { baseRef: raw.baseRefName } : {}),
    ...(lastComment !== undefined ? { lastComment } : {}),
    ...(baseBranch !== undefined && baseBranch !== '' ? { baseBranch } : {}),
  };
}

/**
 * List the items of `repoSlug` waiting for a human: issues at `needs info`, and PRs at
 * `vanguard:needs-human-review`/`vanguard:verify-failed` or with a review requesting changes.
 * Uses the default `needs info` label: the hub has no config for `--needs-info-label`, so a repo
 * running the factory with a custom one shows no issues here. A failed comment fetch drops only that
 * item's `lastComment`, never the list.
 */
export async function listNeedsYou(
  repoSlug: string,
  gh: GhRunner = defaultGhRunner,
  opts: NeedsYouOptions = {},
): Promise<NeedsYouItem[]> {
  assertRepoSlug(repoSlug);
  const scope = ['--repo', repoSlug, '--state', 'open', '-L', String(opts.limit ?? DEFAULT_LIST_LIMIT)];
  // Every list is filtered server-side, so `-L` caps waiting items only — never unrelated open PRs.
  const notRevising = `-label:"${NEEDS_REVISION_LABEL}"`;
  const [issuesOut, labelledPrsOut, changesPrsOut] = await Promise.all([
    gh(['issue', 'list', ...scope, '--label', DEFAULT_GITHUB_NEEDS_INFO_LABEL, '--json', ISSUE_FIELDS]),
    gh(['pr', 'list', ...scope, '--search', `label:"${GITHUB_REVIEW_LABEL}","${GITHUB_VERIFY_FAILED_LABEL}" ${notRevising}`, '--json', PR_FIELDS]),
    gh(['pr', 'list', ...scope, '--search', `review:changes_requested ${notRevising}`, '--json', PR_FIELDS]),
  ]);
  // A PR can match both searches; keep it once.
  const prs = new Map<number, GhPrLite>();
  for (const pr of [...(JSON.parse(labelledPrsOut) as GhPrLite[]), ...(JSON.parse(changesPrsOut) as GhPrLite[])]) {
    if (!prs.has(pr.number)) prs.set(pr.number, pr);
  }

  const issueItems = (JSON.parse(issuesOut) as GhIssueLite[]).map((raw) => ({
    kind: 'issue' as const,
    raw,
    reason: DEFAULT_GITHUB_NEEDS_INFO_LABEL,
  }));
  const prItems = [...prs.values()].flatMap((raw) => {
    const reason = prReason(raw);
    return reason === undefined ? [] : [{ kind: 'pr' as const, raw, reason }];
  });

  const waiting = [...issueItems, ...prItems];
  if (waiting.length === 0) return []; // nothing waits — no identity lookup, no comment fetch

  const own = await ownLogins(gh, opts.botLogins ?? []);
  const budget = opts.commentBudget;
  const fetches = Math.min(waiting.length, MAX_COMMENT_FETCHES, budget?.remaining ?? MAX_COMMENT_FETCHES);
  if (budget !== undefined) budget.remaining -= fetches;
  const outcomes = await fanOut(
    waiting.slice(0, fetches),
    ({ kind, raw }) => lastOwnComment(repoSlug, kind, raw.number, own, gh),
    { concurrency: COMMENT_FETCH_CONCURRENCY },
  );
  return waiting.map(({ kind, raw, reason }, i) => {
    const outcome = outcomes[i];
    return toItem(repoSlug, kind, raw, reason, outcome?.status === 'fulfilled' ? outcome.value : undefined);
  });
}

/**
 * The item number `id` names. `id` travels from the client while `repoSlug` is derived from the
 * allowlisted repo path, so an `id` naming another repo must be refused: the allowlist would
 * otherwise be bypassed by commenting on and relabelling an unregistered repo.
 */
function itemNumber(repoSlug: string, id: string): string {
  const hash = id.lastIndexOf('#');
  const number = id.slice(hash + 1);
  if (hash === -1 || !/^\d+$/.test(number)) throw new TaskcellError(`Invalid item id: ${id}`);
  if (id.slice(0, hash) !== repoSlug) throw new TaskcellError(`${id} is not an item of ${repoSlug}`);
  return number;
}

/** Create `label` if missing. No `--force`: it would reset an existing label's color. */
export async function ensureLabel(repoSlug: string, label: string, gh: GhRunner): Promise<void> {
  await gh(['label', 'create', label, '--repo', repoSlug]).catch(() => undefined);
}

async function issueIsWaiting(repoSlug: string, number: string, gh: GhRunner): Promise<boolean> {
  const out = await gh(['issue', 'view', number, '--repo', repoSlug, '--json', 'state,labels']);
  const issue = JSON.parse(out) as { state: string; labels: GhLabelLite[] };
  return issue.state === 'OPEN' && issue.labels.some((l) => l.name === DEFAULT_GITHUB_NEEDS_INFO_LABEL);
}

/** The PR's head commit when it is open and waiting for a human, else undefined. */
async function waitingPrHead(repoSlug: string, number: string, gh: GhRunner): Promise<{ headRefOid?: string } | undefined> {
  const out = await gh(['pr', 'view', number, '--repo', repoSlug, '--json', 'state,labels,reviewDecision,headRefOid']);
  const pr = JSON.parse(out) as { state: string; labels: GhLabelLite[]; reviewDecision?: string | null; headRefOid?: string };
  return pr.state === 'OPEN' && prReason(pr) !== undefined ? pr : undefined;
}

const prIsWaiting = async (repoSlug: string, number: string, gh: GhRunner): Promise<boolean> =>
  (await waitingPrHead(repoSlug, number, gh)) !== undefined;

/**
 * Post `body` as the caller's own comment on `id` — an item of `repoSlug`, never of the repo the
 * `id` itself names — then move it on to the factory's next trigger label: `needs info` ->
 * `agentLabel` (the repo's configured trigger, default `ready for agent`) for an issue, or
 * `needs revision` added for a PR. Either way the item leaves the list. Refuses (no comment, no label
 * change) when the item is no longer in a waiting state, so a stale read model cannot relabel it.
 * The check and the writes are separate `gh` calls: two concurrent replies can both pass it.
 */
export async function replyNeedsYou(
  repoSlug: string,
  id: string,
  kind: 'issue' | 'pr',
  body: string,
  gh: GhRunner = defaultGhRunner,
  agentLabel: string = DEFAULT_GITHUB_AGENT_LABEL,
): Promise<void> {
  assertRepoSlug(repoSlug);
  const number = itemNumber(repoSlug, id);

  if (kind === 'issue') {
    if (!(await issueIsWaiting(repoSlug, number, gh))) {
      throw new TaskcellError(`${id} is not waiting for a reply (no longer labelled "${DEFAULT_GITHUB_NEEDS_INFO_LABEL}").`);
    }
    await commentGithubIssue(repoSlug, number, body, gh);
    await ensureLabel(repoSlug, agentLabel, gh);
    await gh(['issue', 'edit', number, '--repo', repoSlug, '--remove-label', DEFAULT_GITHUB_NEEDS_INFO_LABEL, '--add-label', agentLabel]);
    return;
  }

  if (!(await prIsWaiting(repoSlug, number, gh))) {
    throw new TaskcellError(`${id} is not waiting for a reply.`);
  }
  await commentPullRequest({ repoSlug, number: Number(number) }, body, gh);
  await ensureLabel(repoSlug, NEEDS_REVISION_LABEL, gh);
  await gh(['pr', 'edit', number, '--repo', repoSlug, '--add-label', NEEDS_REVISION_LABEL]);
}

/** Merge methods in preference order, with the `gh repo view` field that says the repo allows each. */
const MERGE_METHODS = [
  { flag: '--squash', allowed: 'squashMergeAllowed' },
  { flag: '--merge', allowed: 'mergeCommitAllowed' },
  { flag: '--rebase', allowed: 'rebaseMergeAllowed' },
] as const;

/**
 * Merge PR `id` of `repoSlug` with the repository's allowed merge method. Refuses (nothing merged)
 * a PR that is not in the "Needs you" list, or whose required checks are not all green. The check
 * and the merge are separate `gh` calls; GitHub itself still enforces branch protection on the merge.
 */
export async function mergeNeedsYou(repoSlug: string, id: string, gh: GhRunner = defaultGhRunner): Promise<void> {
  assertRepoSlug(repoSlug);
  const number = itemNumber(repoSlug, id);
  const head = await waitingPrHead(repoSlug, number, gh);
  if (head === undefined) {
    throw new TaskcellError(`${id} is not waiting for you, so the hub will not merge it.`);
  }
  // `--required` limits to the required checks. With `--json` the buckets carry the verdict; `gh` only
  // errors when it has nothing to report (no checks at all, or none required) — nothing to wait for.
  // Any other error (auth, network, old gh) is not a verdict on the checks and surfaces as itself.
  const notGreen = new TaskcellError(`${id} has failing or pending required checks.`);
  const checks = await gh(['pr', 'checks', number, '--repo', repoSlug, '--required', '--json', 'bucket']).catch((e: unknown) => {
    if (/no (required )?checks reported/i.test(String(e))) return '[]';
    throw e;
  });
  if ((JSON.parse(checks) as { bucket: string }[]).some((c) => c.bucket !== 'pass' && c.bucket !== 'skipping')) {
    throw notGreen;
  }
  const fields = MERGE_METHODS.map((m) => m.allowed).join(',');
  const repo = JSON.parse(await gh(['repo', 'view', repoSlug, '--json', fields])) as Record<string, boolean>;
  const method = MERGE_METHODS.find((m) => repo[m.allowed] === true);
  if (method === undefined) throw new TaskcellError(`${repoSlug} allows no merge method.`);
  // Pinned to the commit that was checked: a push in between makes the merge fail instead.
  const pin = head.headRefOid === undefined ? [] : ['--match-head-commit', head.headRefOid];
  await gh(['pr', 'merge', number, '--repo', repoSlug, method.flag, ...pin]);
}
