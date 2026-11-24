import { fanOut } from '../pipeline/fan-out.js';
import { failureReason } from '../core/errors.js';

/** The host-neutral review loop: poll → claim → review → mark → restore-on-failure, shared by watch-prs and watch-mrs. */
export interface ReviewWatchPrimitives<T> {
  listReady: () => Promise<T[]>;
  claim: (item: T) => Promise<void>;
  review: (item: T) => Promise<void>;
  markReviewed: (item: T) => Promise<void>;
  onFailure: (item: T, error: unknown) => Promise<void>;
  /** Item ids the last listReady() could not decide on; counted as failed. */
  takeListFailures?: () => string[];
}

export interface ReviewWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface ReviewWatchOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface ReviewWatchLoopOptions extends ReviewWatchOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Incomplete-review attempts per head, and the passes a failed pinned review gets in one run: one budget. */
export const INCOMPLETE_RETRY_LIMIT = 3;

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // Detach on the timer path too, or a long-lived signal gains one listener per tick.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The incomplete-review cap policy. `trustedBodies` are the bodies of notes whose author the host
 * adapter classified as trusted (an untrusted author's marker never counts); `pending` is 1 when the
 * current failure's own marker is posted after this check, else 0.
 */
export function incompleteCapState(
  trustedBodies: readonly string[],
  head: string,
  isAttemptMarker: (body: string, head: string) => boolean,
  capMarkerRe: RegExp,
  pending = 0,
): { attempts: number; capPosted: boolean; stop: boolean } {
  const attempts = trustedBodies.filter((body) => isAttemptMarker(body, head)).length;
  const capPosted = trustedBodies.some((body) => Array.from(body.matchAll(capMarkerRe)).some((match) => match[1] === head));
  return { attempts, capPosted, stop: capPosted || attempts + pending >= INCOMPLETE_RETRY_LIMIT };
}

type Kind = 'reviewed' | 'failed' | 'skipped';

/** Run one review-watch poll: list, claim, review, and mark each ready item. */
export async function reviewWatchOnce<T>(
  primitives: ReviewWatchPrimitives<T>,
  idOf: (item: T) => string,
  opts: ReviewWatchOnceOptions = {},
): Promise<ReviewWatchTick> {
  const phase = opts.phase ?? 'watch';
  const ready = await primitives.listReady();
  const listFailed = primitives.takeListFailures?.() ?? [];
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: Kind }> => {
      const id = idOf(item);
      try {
        await primitives.claim(item);
        opts.log?.(`${phase} ${id}: claim -> reviewing`);
      } catch {
        opts.log?.(`${phase} ${id}: skipped -> already claimed`);
        return { id, kind: 'skipped' };
      }

      try {
        await primitives.review(item);
        await primitives.markReviewed(item);
        opts.log?.(`${phase} ${id}: reviewed -> marked`);
        return { id, kind: 'reviewed' };
      } catch (error) {
        try {
          await primitives.onFailure(item, error);
        } catch (restoreError) {
          opts.log?.(`${phase} ${id}: restore failed -> manual label check (${failureReason(restoreError)})`);
        }
        opts.log?.(`${phase} ${id}: failed -> retry later (${failureReason(error)})`);
        return { id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: Kind): string[] =>
    results.flatMap((outcome) => (outcome.status === 'fulfilled' && outcome.value.kind === kind ? [outcome.value.id] : []));
  return { reviewed: ids('reviewed'), failed: [...listFailed, ...ids('failed')], skipped: ids('skipped') };
}

/** Poll until stopped. Returns the last tick so `--once` callers can report failures truthfully. */
export async function reviewWatchLoop<T>(
  primitives: ReviewWatchPrimitives<T>,
  idOf: (item: T) => string,
  opts: ReviewWatchLoopOptions = {},
): Promise<ReviewWatchTick | undefined> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const phase = opts.phase ?? 'watch';
  let last: ReviewWatchTick | undefined;
  for (;;) {
    if (opts.signal?.aborted === true) return last;
    last = await reviewWatchOnce(primitives, idOf, opts);
    opts.log?.(`${phase}: ${last.reviewed.length} reviewed, ${last.failed.length} failed, ${last.skipped.length} skipped.`);
    if (opts.once === true) return last;
    await delay(intervalMs, opts.signal);
  }
}
