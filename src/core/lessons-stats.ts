import { classifyAuthor } from '../tasks/comment-trust.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { extractCommentVerdict } from '../runners/review-prompt.js';
import { parsePrUrl } from './lead-time-github.js';
import type { MetricRecord } from './stats.js';

/** Share of PRs that passed, or undefined (rendered "no data") when none were measured. */
export interface PassRate {
  prs: number;
  passed: number;
  rate?: number;
}

export interface LessonsReport {
  /** Runs whose records carry `lessonsLoaded` (records from before the field do not count). */
  runs: number;
  runsWithLessons: number;
  /** Mean lessons loaded per run; absent when no run recorded the field. */
  avgLessonsPerRun?: number;
  /** First review verdict had no blocking finding: all factory PRs measured, and split by lessons loaded vs none. */
  firstPass: { all: PassRate; withLessons: PassRate; without: PassRate };
}

const rate = (prs: number, passed: number): PassRate => ({ prs, passed, ...(prs > 0 ? { rate: Math.round((passed / prs) * 1000) / 1000 } : {}) });

/**
 * Lessons rollup from run records. A run is one task + timestamp (its stage records share both). A PR counts
 * as "lessons loaded" when any of its records loaded one; a PR whose records predate the field is in the
 * overall rate only. `firstPass` maps a PR url to whether its first review verdict had no blocking finding;
 * a PR missing from it has no data.
 */
export function aggregateLessons(records: ReadonlyArray<MetricRecord>, firstPass: ReadonlyMap<string, boolean> = new Map()): LessonsReport {
  const runs = new Map<string, number>();
  const prLoaded = new Map<string, boolean | undefined>();
  records.forEach((r, i) => {
    if (r.lessonsLoaded !== undefined) {
      const key = r.ts !== undefined ? `${r.taskId}|${r.ts}` : `#${i}`;
      runs.set(key, Math.max(runs.get(key) ?? 0, r.lessonsLoaded));
    }
    if (r.prUrl !== undefined && firstPass.has(r.prUrl)) {
      const prior = prLoaded.get(r.prUrl);
      prLoaded.set(r.prUrl, r.lessonsLoaded === undefined ? prior : (prior ?? false) || r.lessonsLoaded > 0);
    }
  });
  const counts = [...runs.values()];
  const count = (pick: (loaded: boolean | undefined) => boolean): PassRate => {
    const urls = [...prLoaded].filter(([, loaded]) => pick(loaded)).map(([url]) => url);
    return rate(urls.length, urls.filter((u) => firstPass.get(u) === true).length);
  };
  return {
    runs: counts.length,
    runsWithLessons: counts.filter((n) => n > 0).length,
    ...(counts.length > 0 ? { avgLessonsPerRun: Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 100) / 100 } : {}),
    firstPass: { all: count(() => true), withLessons: count((l) => l === true), without: count((l) => l === false) },
  };
}

const fmtRate = (r: PassRate): string => (r.rate === undefined ? 'no data' : `${Math.round(r.rate * 100)}% (${r.passed}/${r.prs} PRs)`);

export function formatLessonsStats(report: LessonsReport): string {
  return [
    'LESSONS',
    `  runs with lessons      ${report.runs === 0 ? 'no data' : `${report.runsWithLessons} of ${report.runs}`}`,
    `  avg lessons per run    ${report.avgLessonsPerRun === undefined ? 'no data' : report.avgLessonsPerRun}`,
    `  first-pass rate        ${fmtRate(report.firstPass.all)}`,
    `    lessons loaded       ${fmtRate(report.firstPass.withLessons)}`,
    `    none                 ${fmtRate(report.firstPass.without)}`,
  ].join('\n');
}

interface GhReviewView {
  reviews?: Array<{ author?: { login?: string } | null; authorAssociation?: string; body?: string | null; state?: string; submittedAt?: string }> | null;
  comments?: Array<{ author?: { login?: string } | null; authorAssociation?: string; body?: string | null; createdAt?: string }> | null;
}

/** First review verdict of a PR from trusted authors: true = no blocking finding, undefined = none posted. */
export function firstPassOf(view: GhReviewView): boolean | undefined {
  const blockingOf = (body: string | null | undefined): boolean | undefined => {
    const v = extractCommentVerdict(body ?? '');
    return v === undefined ? undefined : v === 'blocking';
  };
  const verdicts = [
    ...(view.reviews ?? []).map((r) => ({ at: r.submittedAt ?? '', a: r, blocking: r.state === 'CHANGES_REQUESTED' ? true : blockingOf(r.body) })),
    ...(view.comments ?? []).map((c) => ({ at: c.createdAt ?? '', a: c, blocking: blockingOf(c.body) })),
  ]
    .filter((x) => x.blocking !== undefined && classifyAuthor(x.a.author?.login ?? '', x.a.authorAssociation ?? '') !== 'untrusted')
    .sort((x, y) => x.at.localeCompare(y.at));
  return verdicts[0] === undefined ? undefined : !verdicts[0].blocking;
}

const FETCH_CONCURRENCY = 6;

/** First-pass outcome per PR url of `repoSlug` (other repos and PRs that fail to fetch or have no verdict are left out). */
export async function fetchFirstPass(repoSlug: string, prUrls: ReadonlyArray<string>, gh: GhRunner = defaultGhRunner): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const todo = [...new Set(prUrls)].flatMap((url) => {
    const p = parsePrUrl(url);
    return p !== undefined && p.repoSlug.toLowerCase() === repoSlug.toLowerCase() ? [{ url, number: p.number }] : [];
  });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const { url, number } = todo[next++] as { url: string; number: number };
      try {
        const result = firstPassOf(JSON.parse(await gh(['pr', 'view', String(number), '--repo', repoSlug, '--json', 'reviews,comments'])) as GhReviewView);
        if (result !== undefined) out.set(url, result);
      } catch {
        // unreachable PR: counted as no data
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, todo.length) }, worker));
  return out;
}
