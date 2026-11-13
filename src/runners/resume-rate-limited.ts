import { failureReason } from '../core/errors.js';
import { latestRateLimitedMarker } from '../core/rate-limit-marker.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_RATE_LIMITED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL, GITHUB_WAITING_LABEL } from '../github-labels.js';
import { classifyAuthor } from '../tasks/comment-trust.js';
import { checkDependencies, WAITING_MARKER_RE } from '../tasks/dependencies.js';
import { defaultGhRunner } from '../tasks/github.js';
import { findOverlapMarker } from '../tasks/overlap.js';
import type { RateLimitedMarker } from '../core/rate-limit-marker.js';
import type { GhRunner } from '../tasks/github.js';

/** Default trigger labels a marker may name; `triggerLabels` replaces them for repos with their own names. */
export const DEFAULT_TRIGGER_LABELS: ReadonlySet<string> = new Set(['ready for agent', 'ready for spec', 'needs revision', 'ready for vanguard review']);

/** Cap on parked items read per sweep, as watch-prs uses for its own label-filtered list. */
const LIST_LIMIT = '100';

export interface ResumeRateLimitedOptions {
  /** owner/repo whose parked issues and PRs to sweep. */
  repoSlug: string;
  /** Labels a marker may name (a pasted marker must not apply any other label). Default: DEFAULT_TRIGGER_LABELS. */
  triggerLabels?: readonly string[];
  /**
   * Labels meaning a waiting issue already started (claimed, in review, spec-claimed); must match the
   * watch's --claimed-state / --review-state / --spec-claimed-label. Default: the built-in labels.
   */
  startedLabels?: readonly string[];
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
  const fields = kind === 'issue' ? 'comments,labels' : 'comments,reviews,labels';
  const view = JSON.parse(await gh([kind, 'view', String(number), '--repo', repoSlug, '--json', fields])) as {
    comments?: GhCommentBody[];
    reviews?: GhCommentBody[];
    labels?: { name?: string }[];
  };
  // Re-read the hold on the item itself: label-filtered lists lag, and a claim may have released it.
  if (!(view.labels ?? []).some((label) => label.name === GITHUB_RATE_LIMITED_LABEL)) return undefined;
  return latestRateLimitedMarker(trustedBodies([...(view.comments ?? []), ...(view.reviews ?? [])]));
}

/**
 * Release the hold, then re-trigger the stage. The trigger label is removed and added back rather
 * than just added: GitHub fires `labeled` only for a label that was not already there, and a parked
 * PR still carries its trigger label (revise-pr drops only `vanguard:revising`). The hold label goes
 * first, so a sweep never fires the same marker twice.
 */
async function retrigger(item: { kind: ParkedKind; repoSlug: string; number: number }, trigger: string, hold: string, gh: GhRunner): Promise<void> {
  const edit = (labels: string[]): Promise<string> => gh([item.kind, 'edit', String(item.number), '--repo', item.repoSlug, ...labels]);
  // Hold first: if releasing it fails nothing has fired, and once it is gone no later sweep can
  // re-trigger the same marker even if the trigger edits below fail.
  await edit(['--remove-label', hold]);
  await edit(['--remove-label', trigger]);
  await edit(['--add-label', trigger]);
}

/**
 * An overlap hold (see holdForOverlap) lasts until its deadline (in its marker) or until every PR/run it
 * names is over: a PR closed/merged, a run's issue closed or no longer `vanguard:running` (failed,
 * needs-info, in review). Returns why it still holds, undefined when it is over.
 */
async function overlapStillHolds(repo: string, bodies: string[], gh: GhRunner, now: Date): Promise<string | undefined> {
  const marker = findOverlapMarker([...bodies].reverse());
  if (marker === undefined || now.getTime() >= marker.until.getTime()) return undefined;
  for (const ref of marker.refs) {
    const view = JSON.parse(await gh(['api', `repos/${repo}/issues/${ref.number}`])) as { state?: string; labels?: { name?: string }[] };
    const open = view.state?.toLowerCase() === 'open';
    if (open && (ref.kind === 'pr' || (view.labels ?? []).some((label) => label.name === GITHUB_CLAIMED_LABEL))) return `overlapping ${ref.kind} #${ref.number} is still open`;
  }
  return undefined;
}

/**
 * Dependency-waiting issues (`vanguard:waiting`, see applyDependencyGate): once every blocker is done and
 * the `Start:` date has passed, drop the hold and re-apply the trigger label named in the wait comment,
 * which starts the per-issue implement run. An invalid dependency is re-triggered too, so that run
 * reports it as needs-info; a failed lookup stays parked.
 */
async function resumeWaiting(ctx: { opts: ResumeRateLimitedOptions; gh: GhRunner; log: (line: string) => void; now: Date; allowed: ReadonlySet<string>; report: ResumeRateLimitedReport }): Promise<void> {
  const { opts, gh, log, now, allowed, report } = ctx;
  const started = opts.startedLabels ?? [GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL];
  const labelsOf = (view: { labels?: { name?: string }[] }): string[] => (view.labels ?? []).flatMap((label) => (label.name === undefined ? [] : [label.name]));
  const listed = JSON.parse(
    await gh(['issue', 'list', '--repo', opts.repoSlug, '--state', 'open', '--label', GITHUB_WAITING_LABEL, '--limit', LIST_LIMIT, '--json', 'number']),
  ) as { number?: number }[];
  for (const { number } of listed) {
    if (number === undefined) continue;
    const id = `${opts.repoSlug}#${number}`;
    const record = (outcome: keyof ResumeRateLimitedReport, line: string): void => {
      log(`resume-rate-limited ${id}: ${line}`);
      report[outcome].push(id);
    };
    try {
      const view = JSON.parse(await gh(['issue', 'view', String(number), '--repo', opts.repoSlug, '--json', 'number,title,body,labels,comments'])) as {
        title?: string;
        body?: string | null;
        labels?: { name?: string }[];
        comments?: GhCommentBody[];
      };
      const labels = labelsOf(view);
      if (!labels.includes(GITHUB_WAITING_LABEL)) continue;
      // Already started (or in review): the label is stale. Drop it; re-triggering would run the issue twice.
      if (started.some((label) => labels.includes(label))) {
        if (opts.dryRun !== true) await gh(['issue', 'edit', String(number), '--repo', opts.repoSlug, '--remove-label', GITHUB_WAITING_LABEL]);
        record('skipped', `skip -> already started, ${opts.dryRun === true ? 'would drop' : 'dropped'} stale ${GITHUB_WAITING_LABEL}`);
        continue;
      }
      const trigger = trustedBodies(view.comments ?? []).flatMap((body) => WAITING_MARKER_RE.exec(body)?.[1] ?? []).at(-1);
      if (trigger === undefined || !allowed.has(trigger)) {
        record('skipped', 'skip -> no trusted waiting marker naming an allowed trigger');
        continue;
      }
      const task = { id, title: view.title ?? '', description: view.body ?? '', labels, children: [], comments: [], ref: String(number) };
      const verdict = await checkDependencies(opts.repoSlug, task, gh, now);
      const overlapWait = verdict.status === 'ready' ? await overlapStillHolds(opts.repoSlug, trustedBodies(view.comments ?? []), gh, now) : undefined;
      if (verdict.status === 'error') {
        record('failed', `failed -> ${verdict.reason}`);
      } else if (verdict.status === 'waiting') {
        record('waiting', `waiting -> ${verdict.reason}`);
      } else if (overlapWait !== undefined) {
        record('waiting', `waiting -> ${overlapWait}`);
      } else if (opts.dryRun === true) {
        record('resumed', `would re-apply "${trigger}" and drop ${GITHUB_WAITING_LABEL} (dry-run)`);
      } else {
        // The dependency lookups take a while: re-read the labels so a claim that landed meanwhile is not run twice.
        const fresh = labelsOf(JSON.parse(await gh(['issue', 'view', String(number), '--repo', opts.repoSlug, '--json', 'labels'])) as { labels?: { name?: string }[] });
        if (!fresh.includes(GITHUB_WAITING_LABEL) || started.some((label) => fresh.includes(label))) {
          record('skipped', `skip -> labels changed during the check (${fresh.join(', ') || 'none'})`);
          continue;
        }
        await retrigger({ kind: 'issue', repoSlug: opts.repoSlug, number }, trigger, GITHUB_WAITING_LABEL, gh);
        record('resumed', `resumed -> re-applied "${trigger}", dropped ${GITHUB_WAITING_LABEL}`);
      }
    } catch (error) {
      record('failed', `failed -> ${failureReason(error)}`);
    }
  }
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
  const allowed = new Set(opts.triggerLabels !== undefined && opts.triggerLabels.length > 0 ? opts.triggerLabels : DEFAULT_TRIGGER_LABELS);
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
        } else if (!allowed.has(marker.trigger)) {
          record('skipped', `skip -> marker names "${marker.trigger}", not an allowed trigger (pass --trigger-labels)`);
        } else if (marker.until.getTime() > now.getTime()) {
          record('waiting', `waiting -> resets ${marker.until.toISOString()}`);
        } else if (opts.dryRun === true) {
          record('resumed', `would re-apply "${marker.trigger}" and drop ${GITHUB_RATE_LIMITED_LABEL} (dry-run)`);
        } else {
          await retrigger({ kind, repoSlug: opts.repoSlug, number }, marker.trigger, GITHUB_RATE_LIMITED_LABEL, gh);
          record('resumed', `resumed -> re-applied "${marker.trigger}", dropped ${GITHUB_RATE_LIMITED_LABEL}`);
        }
      } catch (error) {
        record('failed', `failed -> ${failureReason(error)}`);
      }
    }
  }
  await resumeWaiting({ opts, gh, log, now, allowed, report });
  return report;
}
