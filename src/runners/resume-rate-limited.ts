import { failureReason } from '../core/errors.js';
import { latestRateLimitedMarker } from '../core/rate-limit-marker.js';
import { GITHUB_RATE_LIMITED_LABEL } from '../github-labels.js';
import { classifyAuthor } from '../tasks/comment-trust.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { RateLimitedMarker } from '../core/rate-limit-marker.js';
import type { GhRunner } from '../tasks/github.js';

/** Cap on parked items read per sweep, as watch-prs uses for its own label-filtered list. */
const LIST_LIMIT = '100';

export interface ResumeRateLimitedOptions {
  /** owner/repo whose parked issues and PRs to sweep. */
  repoSlug: string;
  /** Report what would be re-triggered and edit nothing. */
  dryRun?: boolean;
  /** Clock for the `until` comparison (injected by tests). */
  now?: Date;
  gh?: GhRunner;
  log?: (line: string) => void;
}

export interface ResumeRateLimitedReport {
  /** Items whose trigger label was re-applied (or would be, under --dry-run). */
  resumed: string[];
  /** Items whose marker names a reset time still in the future. */
  waiting: string[];
  /** Items carrying the label with no usable marker — a human has to decide what to do with them. */
  skipped: string[];
  failed: string[];
}

interface GhCommentBody {
  body?: string | null;
  author?: { login?: string } | null;
  authorAssociation?: string;
  createdAt?: string;
  /** `gh pr view --json reviews` timestamps a review with submittedAt, not createdAt. */
  submittedAt?: string;
}

type ParkedKind = 'issue' | 'pr';

/**
 * Trusted comment bodies, oldest first (what latestRateLimitedMarker expects). An untrusted author's
 * body is dropped before the marker scan: the marker is plain text anyone can paste, and it names
 * both the reset time this command waits for and the label it re-applies.
 */
function trustedBodies(entries: readonly GhCommentBody[]): string[] {
  const at = (entry: GhCommentBody): string => entry.createdAt ?? entry.submittedAt ?? '';
  return entries
    .filter((entry) => classifyAuthor(entry.author?.login ?? '', entry.authorAssociation ?? '') !== 'untrusted')
    .sort((a, b) => at(a).localeCompare(at(b)))
    .map((entry) => entry.body ?? '');
}

/** Open issues (or PRs) carrying the hold label. `gh issue list` never returns PRs, so both are swept. */
async function listParked(kind: ParkedKind, repoSlug: string, gh: GhRunner): Promise<number[]> {
  const out = await gh([
    kind, 'list', '--repo', repoSlug, '--state', 'open', '--label', GITHUB_RATE_LIMITED_LABEL, '--limit', LIST_LIMIT, '--json', 'number',
  ]);
  return (JSON.parse(out) as { number?: number }[]).flatMap((item) => (item.number === undefined ? [] : [item.number]));
}

/** The newest marker on the item. A PR carries it as a comment (pr-watch) or a review (revise-pr). */
async function latestMarker(kind: ParkedKind, repoSlug: string, number: number, gh: GhRunner): Promise<RateLimitedMarker | undefined> {
  // `gh issue view` has no `reviews` field to ask for; an issue's marker is always a comment.
  const fields = kind === 'issue' ? 'comments' : 'comments,reviews';
  const view = JSON.parse(await gh([kind, 'view', String(number), '--repo', repoSlug, '--json', fields])) as {
    comments?: GhCommentBody[];
    reviews?: GhCommentBody[];
  };
  return latestRateLimitedMarker(trustedBodies([...(view.comments ?? []), ...(view.reviews ?? [])]));
}

/**
 * Re-trigger the stage, then release the hold. The trigger label is removed and added back rather
 * than just added: GitHub fires `labeled` only for a label that was not already there, and a parked
 * PR still carries its trigger label (revise-pr drops only `vanguard:revising`). The hold label goes
 * last, so a failure mid-way leaves the item parked and the next sweep retries it.
 */
async function retrigger(kind: ParkedKind, repoSlug: string, number: number, trigger: string, gh: GhRunner): Promise<void> {
  const edit = (labels: string[]): Promise<string> => gh([kind, 'edit', String(number), '--repo', repoSlug, ...labels]);
  await edit(['--remove-label', trigger]);
  await edit(['--add-label', trigger]);
  await edit(['--remove-label', GITHUB_RATE_LIMITED_LABEL]);
}

/**
 * Pick the factory work a provider rate or session limit parked back up. A parked issue or PR carries
 * `vanguard:rate-limited` plus a marker comment naming the reset time and the label that restarts its
 * stage (see rate-limit-marker.ts); once that time has passed, this re-applies the trigger label and
 * drops the hold. Nothing else resumes that work — the run that hit the limit is long gone — so this
 * is run on a schedule. Per-item failures are reported, not thrown: one unreachable PR must not stop
 * the sweep.
 */
export async function resumeRateLimited(opts: ResumeRateLimitedOptions): Promise<ResumeRateLimitedReport> {
  const gh = opts.gh ?? defaultGhRunner;
  const log = opts.log ?? console.log;
  const now = opts.now ?? new Date();
  const report: ResumeRateLimitedReport = { resumed: [], waiting: [], skipped: [], failed: [] };
  for (const kind of ['issue', 'pr'] as const) {
    for (const number of await listParked(kind, opts.repoSlug, gh)) {
      const id = `${opts.repoSlug}#${number}`;
      const record = (outcome: keyof ResumeRateLimitedReport, line: string): void => {
        log(`resume-rate-limited ${id}: ${line}`);
        report[outcome].push(id);
      };
      try {
        const marker = await latestMarker(kind, opts.repoSlug, number, gh);
        if (marker === undefined) {
          record('skipped', 'skip -> no rate-limit marker from a trusted author');
        } else if (marker.until.getTime() > now.getTime()) {
          record('waiting', `waiting -> resets ${marker.until.toISOString()}`);
        } else if (opts.dryRun === true) {
          record('resumed', `would re-apply "${marker.trigger}" and drop ${GITHUB_RATE_LIMITED_LABEL} (dry-run)`);
        } else {
          await retrigger(kind, opts.repoSlug, number, marker.trigger, gh);
          record('resumed', `resumed -> re-applied "${marker.trigger}", dropped ${GITHUB_RATE_LIMITED_LABEL}`);
        }
      } catch (error) {
        record('failed', `failed -> ${failureReason(error)}`);
      }
    }
  }
  return report;
}
