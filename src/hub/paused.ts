// Tasks paused by a provider usage/rate limit: the hub's read of the `rate-limited` label and the
// factory's own marker comment (src/core/rate-limit-marker.ts), and the "Retry now" that does what the
// comment describes. `gh` and labels only, no model call.
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_RATE_LIMITED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_RESEARCHING_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import { parseRateLimitedMarker } from '../core/rate-limit-marker.js';
import type { RateLimitedMarker } from '../core/rate-limit-marker.js';
import { hasLabel, sameLabel } from '../core/labels.js';
import { failureReason } from '../core/errors.js';
import { httpsUrl } from '../core/links.js';
import { columnFor, isTriggerLabel } from '../tasks/board.js';
import { assertRepoSlug, ownLogins } from './needs-you.js';
import type { BoardTask, PausedState, RetryPausedResult } from '../wire.js';

/** Only this many paused cards cost a `gh` comment read; the rest still show as paused, without a time. */
export const MAX_MARKER_READS = 30;
const MARKER_READ_CONCURRENCY = 4;

/** Shared by every repository in one list call, so the all-repositories view cannot multiply the cap. */
export interface MarkerReadBudget {
  remaining: number;
}

export const markerReadBudget = (): MarkerReadBudget => ({ remaining: MAX_MARKER_READS });

interface GhCommentLite {
  body?: string | null;
  author?: { login?: string } | null;
  createdAt?: string | null;
  submittedAt?: string | null;
}

/** The newest marker written by the factory's own login on issue/PR `number`; anyone else's is ignored. */
export async function ownRateLimitMarker(repoSlug: string, kind: 'issue' | 'pr', number: number, own: ReadonlySet<string>, gh: GhRunner): Promise<RateLimitedMarker | undefined> {
  const fields = kind === 'pr' ? 'comments,reviews' : 'comments';
  const out = await gh([kind, 'view', String(number), '--repo', repoSlug, '--json', fields]);
  const parsed = JSON.parse(out) as { comments?: GhCommentLite[]; reviews?: GhCommentLite[] };
  const entries = [...(parsed.comments ?? []), ...(kind === 'pr' ? (parsed.reviews ?? []) : [])]
    .flatMap((entry) => {
      if (!own.has((entry.author?.login ?? '').toLowerCase())) return [];
      const at = Date.parse(entry.createdAt ?? entry.submittedAt ?? '');
      if (Number.isNaN(at)) return [];
      const marker = parseRateLimitedMarker(entry.body ?? '');
      return marker === undefined ? [] : [{ at, marker }];
    })
    .sort((a, b) => b.at - a.at);
  return entries[0]?.marker;
}

export const pausedFrom = (marker: RateLimitedMarker | undefined): PausedState => ({
  reason: 'provider-limit',
  ...(marker !== undefined ? { until: marker.until.toISOString(), trigger: marker.trigger } : {}),
});

const refOf = (id: string): { kind: 'issue' | 'pr'; number: number } | undefined => {
  const issue = /^gh-(\d+)$/.exec(id);
  if (issue !== null) return { kind: 'issue', number: Number(issue[1]) };
  const pr = /^gh-pr-(\d+)$/.exec(id);
  return pr === null ? undefined : { kind: 'pr', number: Number(pr[1]) };
};

/** Fill `until`/`trigger` on every paused card from the factory's marker. A failed read leaves the card paused without a time. */
export async function withPausedTimes<T extends BoardTask>(repoSlug: string, tasks: T[], gh: GhRunner = defaultGhRunner, budget: MarkerReadBudget = markerReadBudget()): Promise<T[]> {
  const fetches = Math.min(tasks.filter((t) => t.paused !== undefined).length, budget.remaining);
  const paused = tasks.filter((t) => t.paused !== undefined).slice(0, fetches);
  if (paused.length === 0) return tasks;
  budget.remaining -= paused.length;
  const own = await ownLogins(gh, []);
  const found = new Map<T, PausedState>();
  for (let i = 0; i < paused.length; i += MARKER_READ_CONCURRENCY) {
    await Promise.all(
      paused.slice(i, i + MARKER_READ_CONCURRENCY).map(async (t) => {
        const ref = refOf(t.id);
        if (ref === undefined) return;
        found.set(t, pausedFrom(await ownRateLimitMarker(repoSlug, ref.kind, ref.number, own, gh).catch(() => undefined)));
      }),
    );
  }
  return tasks.map((t) => (found.has(t) ? { ...t, paused: found.get(t)! } : t));
}

interface GhPrLite {
  number: number;
  title: string;
  url?: string;
  labels?: Array<{ name: string }>;
}

/** Open GitHub pull requests parked by a provider limit, which `gh issue list` does not return. */
export async function pausedPullRequests(repoSlug: string, gh: GhRunner = defaultGhRunner): Promise<BoardTask[]> {
  const out = await gh(['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', '100', '--json', 'number,title,url,labels']);
  return (JSON.parse(out) as GhPrLite[]).flatMap((pr) => {
    const labels = (pr.labels ?? []).map((label) => label.name);
    if (!hasLabel(labels, GITHUB_RATE_LIMITED_LABEL)) return [];
    const url = httpsUrl(pr.url);
    return [{
      id: `gh-pr-${pr.number}`,
      title: pr.title,
      column: columnFor(labels.join(' ')),
      state: labels[0] ?? 'open',
      source: 'github' as const,
      paused: { reason: 'provider-limit' as const },
      ...(url !== undefined ? { url } : {}),
    }];
  });
}

/** Add paused PR cards, then fill marker times for paused issues and PRs under one shared budget. */
export async function withPausedTasks(repoSlug: string, tasks: BoardTask[], gh: GhRunner = defaultGhRunner, budget: MarkerReadBudget = markerReadBudget()): Promise<BoardTask[]> {
  const prs = await pausedPullRequests(repoSlug, gh).catch(() => []);
  const ids = new Set(tasks.map((task) => task.id));
  return withPausedTimes(repoSlug, [...tasks, ...prs.filter((pr) => !ids.has(pr.id))], gh, budget);
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
  try {
    // Establish the label before touching the issue. Unlike the shared best-effort helper, every
    // read/create failure surfaces: the hold must remain the durable state until the trigger lands.
    const repoLabels = (JSON.parse(await gh(['label', 'list', '--repo', repoSlug, '--limit', '1000', '--json', 'name'])) as Array<{ name: string }>).map((label) => label.name);
    if (!repoLabels.some((label) => label.toLowerCase() === trigger.toLowerCase())) {
      await gh(['label', 'create', trigger, '--repo', repoSlug]);
    }
    // GitHub sends no `labeled` event for a label already present. Remove any stale trigger while the
    // hold is still on, add the recorded trigger, and only then release the provider-limit hold.
    const stale = names.filter((name) => triggerLabels.some((candidate) => candidate.toLowerCase() === name.toLowerCase()) || isTriggerLabel(name));
    for (const label of stale) await edit('--remove-label', label);
    await edit('--add-label', trigger);
    for (const hold of held) await edit('--remove-label', hold);
  } catch (error) {
    throw new BadRequestError(`#${n} stays paused: ${failureReason(error)}`);
  }
  return { label: trigger };
}
