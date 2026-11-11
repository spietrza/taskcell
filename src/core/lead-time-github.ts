/** Fetches the raw GitHub timeline/PR facts lead-time.ts needs and turns them into IssueLeadTime
 * records. The only part of the lead-time feature that shells to `gh` — kept separate so the parsing
 * math (lead-time.ts) stays pure and fixture-tested with no network. */
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { computeIssueLeadTime, rollupLeadTimes, DEFAULT_REVISE_LABEL } from './lead-time.js';
import type { IssueLeadTime, LeadTimeRollup, PrLeadTimeInfo, TimelineEvent } from './lead-time.js';

export interface LeadTimeOptions {
  triggerLabels?: ReadonlySet<string>;
  reviseLabel?: string;
}

interface GhPrLeadView {
  number: number;
  createdAt: string;
  mergedAt?: string | null;
  closingIssuesReferences?: Array<{ number: number }>;
}

/** `owner/repo` + PR number from a `https://github.com/owner/repo/pull/123` URL, or undefined for
 * anything else (a GitLab MR URL, a malformed string). */
export function parsePrUrl(url: string): { repoSlug: string; number: number } | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url.trim());
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { repoSlug: match[1], number: Number(match[2]) };
}

/** One issue/PR's timeline, every page (`--paginate --slurp` keeps pages in one JSON array). PRs are
 * issues in this endpoint, so the same call fetches a PR's own timeline (labeled/unlabeled/merged…). */
async function fetchTimeline(repoSlug: string, number: number, gh: GhRunner): Promise<TimelineEvent[]> {
  const pages = JSON.parse(
    await gh(['api', '--paginate', '--slurp', `repos/${repoSlug}/issues/${number}/timeline`]),
  ) as TimelineEvent[][];
  return pages.flat();
}

/**
 * Lead time for one PR: reads the PR (createdAt/mergedAt/the issue it closes) plus both timelines
 * (the issue's, for the trigger label; the PR's, for revise-round labels), then combines them.
 * Returns undefined when the PR does not close an issue — there is no trigger label to measure from.
 */
export async function fetchPrLeadTime(
  repoSlug: string,
  prNumber: number,
  opts: LeadTimeOptions = {},
  gh: GhRunner = defaultGhRunner,
): Promise<IssueLeadTime | undefined> {
  const view = JSON.parse(
    await gh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'number,createdAt,mergedAt,closingIssuesReferences']),
  ) as GhPrLeadView;
  const issueNumber = view.closingIssuesReferences?.[0]?.number;
  if (issueNumber === undefined) return undefined;

  const [issueTimeline, prTimeline] = await Promise.all([
    fetchTimeline(repoSlug, issueNumber, gh),
    fetchTimeline(repoSlug, prNumber, gh),
  ]);
  const pr: PrLeadTimeInfo = {
    number: view.number,
    createdAt: view.createdAt,
    ...(view.mergedAt !== undefined ? { mergedAt: view.mergedAt } : {}),
  };
  return computeIssueLeadTime({
    issueRef: `${repoSlug}#${issueNumber}`,
    issueTimeline,
    pr,
    prTimeline,
    ...(opts.triggerLabels !== undefined ? { triggerLabels: opts.triggerLabels } : {}),
    reviseLabel: opts.reviseLabel ?? DEFAULT_REVISE_LABEL,
  });
}

/** Lead times for several PRs in one repo, concurrently. A PR that fails to fetch (deleted, no
 * access) or has no closing issue is dropped rather than failing the whole rollup. */
export async function fetchLeadTimes(
  repoSlug: string,
  prNumbers: ReadonlyArray<number>,
  opts: LeadTimeOptions = {},
  gh: GhRunner = defaultGhRunner,
): Promise<IssueLeadTime[]> {
  const results = await Promise.all(
    prNumbers.map((number) => fetchPrLeadTime(repoSlug, number, opts, gh).catch(() => undefined)),
  );
  return results.filter((r): r is IssueLeadTime => r !== undefined);
}

/** Distinct PR numbers in `repoSlug` found among `prUrls` (e.g. every `prUrl` recorded in
 * metrics.jsonl — see stats.ts/MetricRecord). Order-preserving, first-seen. */
export function prNumbersForRepo(prUrls: ReadonlyArray<string>, repoSlug: string): number[] {
  const numbers = new Set<number>();
  for (const url of prUrls) {
    const parsed = parsePrUrl(url);
    if (parsed !== undefined && parsed.repoSlug.toLowerCase() === repoSlug.toLowerCase()) numbers.add(parsed.number);
  }
  return [...numbers];
}

/** Fetch + rollup lead times for every PR in `prUrls` that belongs to `repoSlug`. */
export async function leadTimeRollupForPrUrls(
  repoSlug: string,
  prUrls: ReadonlyArray<string>,
  opts: LeadTimeOptions = {},
  gh: GhRunner = defaultGhRunner,
): Promise<LeadTimeRollup> {
  const prNumbers = prNumbersForRepo(prUrls, repoSlug);
  const items = await fetchLeadTimes(repoSlug, prNumbers, opts, gh);
  return rollupLeadTimes(items);
}
