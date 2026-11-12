/**
 * Lead-time rollup per issue: trigger label -> PR opened -> each revise round -> merged. This is
 * what a user waits for, as opposed to `src/core/stats.ts`'s agent-stage time — a task can take
 * 12-25 minutes of stage time yet take hours label-to-merge (CI, Actions queueing, image pulls,
 * revise rounds). Parsing is pure and fixture-tested (lead-time.test.ts); fetching the raw GitHub
 * timeline lives in lead-time-github.ts, which is the only part that shells to `gh`.
 */

/** One event off `GET /repos/{owner}/{repo}/issues/{number}/timeline` (PRs are issues there too). Only
 * the fields this module reads; GitHub's timeline carries many more per event type. */
export interface TimelineEvent {
  event: string;
  created_at?: string;
  label?: { name: string };
}

/** The PR facts `gh pr view --json number,createdAt,mergedAt` gives directly — cheaper and more
 * exact than deriving "opened"/"merged" from timeline events. */
export interface PrLeadTimeInfo {
  number: number;
  createdAt: string;
  mergedAt?: string | null;
}

export interface IssueLeadTime {
  issueRef: string;
  prNumber?: number;
  /** Earliest time any of the configured trigger labels was applied to the issue. */
  labeledAt?: string;
  prOpenedAt?: string;
  mergedAt?: string;
  labelToPrMs?: number;
  prToMergeMs?: number;
  /** Count of `needs revision` relabel events on the PR — each one is a round a human sent back. */
  reviseRounds: number;
  /** Merged with zero revise rounds. */
  firstTry: boolean;
}

export interface LeadTimeRollup {
  items: IssueLeadTime[];
  medianLabelToPrMs?: number;
  medianPrToMergeMs?: number;
  medianReviseRounds?: number;
  /** Share of MERGED items that were first-try; undefined when nothing merged yet. */
  firstTryRate?: number;
  /** PRs whose lookup failed (no access, rate limit); set only when > 0, so the medians are partial. */
  failedPrs?: number;
}

const DEFAULT_TRIGGER_LABELS: ReadonlySet<string> = new Set(['ready for agent', 'ready for spec', 'ready for vanguard review']);
export const DEFAULT_REVISE_LABEL = 'needs revision';

/** Earliest `labeled` event in `events` whose label name is in `labels`, or undefined if none. */
export function earliestLabelAt(events: ReadonlyArray<TimelineEvent>, labels: ReadonlySet<string>): string | undefined {
  const timestamps = events
    .filter((e) => e.event === 'labeled' && e.label !== undefined && labels.has(e.label.name) && e.created_at !== undefined)
    .map((e) => e.created_at as string);
  return timestamps.length === 0 ? undefined : [...timestamps].sort()[0];
}

/** Number of times `labelName` was applied (each `labeled` event is one round the label drove). */
export function countLabelEvents(events: ReadonlyArray<TimelineEvent>, labelName: string): number {
  return events.filter((e) => e.event === 'labeled' && e.label?.name === labelName).length;
}

function diffMs(laterIso: string, earlierIso: string): number | undefined {
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  // A negative span (label applied after the PR opened, a placeholder timestamp) is not a lead time.
  return Number.isNaN(later) || Number.isNaN(earlier) || later < earlier ? undefined : later - earlier;
}

export interface ComputeLeadTimeInput {
  issueRef: string;
  issueTimeline: ReadonlyArray<TimelineEvent>;
  triggerLabels?: ReadonlySet<string>;
  pr?: PrLeadTimeInfo;
  prTimeline?: ReadonlyArray<TimelineEvent>;
  reviseLabel?: string;
}

/** Combine one issue's timeline with its linked PR's facts + timeline into one lead-time record. */
export function computeIssueLeadTime(input: ComputeLeadTimeInput): IssueLeadTime {
  const labeledAt = earliestLabelAt(input.issueTimeline, input.triggerLabels ?? DEFAULT_TRIGGER_LABELS);
  const prOpenedAt = input.pr?.createdAt;
  const mergedAt = input.pr?.mergedAt ?? undefined;
  const reviseRounds = input.prTimeline !== undefined ? countLabelEvents(input.prTimeline, input.reviseLabel ?? DEFAULT_REVISE_LABEL) : 0;
  const labelToPrMs = labeledAt !== undefined && prOpenedAt !== undefined ? diffMs(prOpenedAt, labeledAt) : undefined;
  const prToMergeMs = prOpenedAt !== undefined && mergedAt !== undefined ? diffMs(mergedAt, prOpenedAt) : undefined;
  return {
    issueRef: input.issueRef,
    ...(input.pr?.number !== undefined ? { prNumber: input.pr.number } : {}),
    ...(labeledAt !== undefined ? { labeledAt } : {}),
    ...(prOpenedAt !== undefined ? { prOpenedAt } : {}),
    ...(mergedAt !== undefined ? { mergedAt } : {}),
    ...(labelToPrMs !== undefined ? { labelToPrMs } : {}),
    ...(prToMergeMs !== undefined ? { prToMergeMs } : {}),
    reviseRounds,
    firstTry: mergedAt !== undefined && reviseRounds === 0,
  };
}

function median(values: ReadonlyArray<number>): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/** Medians + first-try rate over a set of per-issue lead times (e.g. one project, one repo). */
export function rollupLeadTimes(items: ReadonlyArray<IssueLeadTime>): LeadTimeRollup {
  const medianOf = (pick: (i: IssueLeadTime) => number | undefined): number | undefined =>
    median(items.map(pick).filter((v): v is number => v !== undefined));
  const merged = items.filter((i) => i.mergedAt !== undefined);
  const medianLabelToPrMs = medianOf((i) => i.labelToPrMs);
  const medianPrToMergeMs = medianOf((i) => i.prToMergeMs);
  const medianReviseRounds = medianOf((i) => i.reviseRounds);
  const firstTryRate = merged.length > 0 ? merged.filter((i) => i.firstTry).length / merged.length : undefined;
  return {
    items: [...items],
    ...(medianLabelToPrMs !== undefined ? { medianLabelToPrMs } : {}),
    ...(medianPrToMergeMs !== undefined ? { medianPrToMergeMs } : {}),
    ...(medianReviseRounds !== undefined ? { medianReviseRounds } : {}),
    ...(firstTryRate !== undefined ? { firstTryRate } : {}),
  };
}

const hours = (ms: number | undefined): string => (ms === undefined ? '-' : `${(ms / 3_600_000).toFixed(1)} h`);

/** Plain-text LEAD TIME block for `taskcell stats --github-repo`. */
export function formatLeadTime(rollup: LeadTimeRollup): string {
  const lines = [
    'LEAD TIME',
    `  PRs measured           ${rollup.items.length}`,
    `  median label -> PR     ${hours(rollup.medianLabelToPrMs)}`,
    `  median PR -> merge     ${hours(rollup.medianPrToMergeMs)}`,
    `  median revise rounds   ${rollup.medianReviseRounds ?? '-'}`,
    `  first-try merge rate   ${rollup.firstTryRate === undefined ? '-' : `${Math.round(rollup.firstTryRate * 100)}%`}`,
  ];
  if (rollup.failedPrs !== undefined) lines.push(`  warning: ${rollup.failedPrs} PR lookup(s) failed; medians cover the rest only`);
  return lines.join('\n');
}
