// Tasks paused by a provider usage/rate limit: the hub's read of the `rate-limited` label and the
// factory's own marker comment (src/core/rate-limit-marker.ts), and the "Retry now" that does what the
// comment describes. `gh` and labels only, no model call.
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_RATE_LIMITED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_RESEARCHING_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import { latestRateLimitedMarker } from '../core/rate-limit-marker.js';
import type { RateLimitedMarker } from '../core/rate-limit-marker.js';
import { sameLabel } from '../core/labels.js';
import { assertRepoSlug, ensureLabel, ownLogins } from './needs-you.js';
import type { BoardTask, PausedState, RetryPausedResult } from '../wire.js';

/** Only this many paused cards cost a `gh` comment read; the rest still show as paused, without a time. */
const MAX_MARKER_READS = 30;
const MARKER_READ_CONCURRENCY = 4;

interface GhCommentLite {
  body?: string | null;
  author?: { login?: string } | null;
}

/** The newest marker written by the factory's own login on issue/PR `number`; anyone else's is ignored. */
export async function ownRateLimitMarker(repoSlug: string, kind: 'issue' | 'pr', number: number, own: ReadonlySet<string>, gh: GhRunner): Promise<RateLimitedMarker | undefined> {
  const out = await gh([kind, 'view', String(number), '--repo', repoSlug, '--json', 'comments']);
  const comments = (JSON.parse(out) as { comments?: GhCommentLite[] }).comments ?? [];
  return latestRateLimitedMarker(comments.filter((c) => own.has((c.author?.login ?? '').toLowerCase())).map((c) => c.body ?? ''));
}

export const pausedFrom = (marker: RateLimitedMarker | undefined): PausedState => ({
  reason: 'provider-limit',
  ...(marker !== undefined ? { until: marker.until.toISOString(), trigger: marker.trigger } : {}),
});

const numberOf = (id: string): number | undefined => {
  const m = /^gh-(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

/** Fill `until`/`trigger` on every paused card from the factory's marker. A failed read leaves the card paused without a time. */
export async function withPausedTimes<T extends BoardTask>(repoSlug: string, tasks: T[], gh: GhRunner = defaultGhRunner): Promise<T[]> {
  const paused = tasks.filter((t) => t.paused !== undefined).slice(0, MAX_MARKER_READS);
  if (paused.length === 0) return tasks;
  const own = await ownLogins(gh, []);
  const found = new Map<T, PausedState>();
  for (let i = 0; i < paused.length; i += MARKER_READ_CONCURRENCY) {
    await Promise.all(
      paused.slice(i, i + MARKER_READ_CONCURRENCY).map(async (t) => {
        const n = numberOf(t.id);
        if (n === undefined) return;
        found.set(t, pausedFrom(await ownRateLimitMarker(repoSlug, 'issue', n, own, gh).catch(() => undefined)));
      }),
    );
  }
  return tasks.map((t) => (found.has(t) ? { ...t, paused: found.get(t)! } : t));
}

/** Labels meaning the factory already took the issue (as start-task.ts). */
const STARTED_LABELS: readonly string[] = [GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL, GITHUB_RESEARCHING_LABEL];

/**
 * "Retry now": do what the marker comment describes — remove the rate-limited label, re-apply the recorded trigger.
 * Refused wherever Start is (pull request, closed, already running) and when there is nothing to retry with
 * (not paused, no marker from the factory, a trigger that is not one of the project's). Every refusal is before any write.
 */
export async function retryPausedTask(repoSlug: string, number: number, triggerLabels: readonly string[], gh: GhRunner = defaultGhRunner): Promise<RetryPausedResult> {
  assertRepoSlug(repoSlug);
  if (!Number.isInteger(number) || number <= 0) throw new BadRequestError(`number must be a positive integer, got ${String(number)}`);
  const n = String(number);
  const issue = JSON.parse(await gh(['api', `repos/${repoSlug}/issues/${n}`])) as { state: string; labels: { name: string }[]; pull_request?: unknown };
  if (issue.pull_request != null) throw new BadRequestError(`#${n} is a pull request, not an issue.`);
  if (issue.state !== 'open') throw new BadRequestError(`#${n} is closed; the factory only starts open issues.`);
  const names = issue.labels.map((l) => l.name);
  const held = names.filter((x) => sameLabel(x, GITHUB_RATE_LIMITED_LABEL));
  if (held.length === 0) throw new BadRequestError(`#${n} is not paused by a provider limit; nothing was changed.`);
  const started = names.filter((x) => STARTED_LABELS.some((s) => sameLabel(s, x)));
  if (started.length > 0) throw new BadRequestError(`#${n} is already running or queued (${started.join(', ')}); nothing was changed.`);
  const marker = await ownRateLimitMarker(repoSlug, 'issue', number, await ownLogins(gh, []), gh);
  if (marker === undefined) throw new BadRequestError(`#${n} has no rate-limit marker from the factory, so the trigger to re-apply is unknown; re-apply it on GitHub.`);
  const trigger = triggerLabels.find((t) => t.toLowerCase() === marker.trigger.toLowerCase());
  if (trigger === undefined) throw new BadRequestError(`"${marker.trigger}" is not a trigger label of this project (${triggerLabels.join(', ')}); nothing was changed.`);

  const edit = (flag: string, l: string): Promise<string> => gh(['issue', 'edit', n, '--repo', repoSlug, flag, l]);
  // Hold first (as resume-rate-limited): once it is gone no sweep fires the same marker twice. Then drop and re-add the
  // trigger: GitHub sends no `labeled` event for a label the issue already has.
  for (const h of held) await edit('--remove-label', h);
  for (const stale of names.filter((x) => triggerLabels.some((t) => t.toLowerCase() === x.toLowerCase()))) await edit('--remove-label', stale);
  await ensureLabel(repoSlug, trigger, gh);
  await edit('--add-label', trigger);
  return { label: trigger };
}
