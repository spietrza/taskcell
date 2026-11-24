import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { writeMarker } from '../core/comment-ledger.js';
import type { LedgerComment } from '../core/comment-ledger.js';
import { UsageCapError } from '../core/usage-cap.js';
import { INCOMPLETE_RETRY_LIMIT, incompleteCapState, reviewWatchLoop, reviewWatchOnce } from './review-watch.js';
import type { ReviewWatchPrimitives } from './review-watch.js';

interface Item {
  id: number;
}
const idOf = (item: Item): string => `h#${item.id}`;
const quiet = (over: Partial<ReviewWatchPrimitives<Item>> = {}): ReviewWatchPrimitives<Item> => ({
  listReady: async () => [],
  claim: async () => {},
  review: async () => {},
  markReviewed: async () => {},
  onFailure: async () => {},
  ...over,
});

const attempt = (author: LedgerComment['author'] = 'trusted'): LedgerComment => ({ body: writeMarker('pr-review-incomplete', 'abc'), author });
const cap = (head: string, author: LedgerComment['author'] = 'trusted'): LedgerComment => ({ body: writeMarker('pr-review-incomplete-cap', head), author });

describe('reviewWatchOnce (fake adapter)', () => {
  it('claims, reviews, and marks each ready item in order', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const tick = await reviewWatchOnce(
      quiet({
        listReady: async () => [{ id: 1 }],
        claim: async (i) => void order.push(`claim:${i.id}`),
        review: async (i) => void order.push(`review:${i.id}`),
        markReviewed: async (i) => void order.push(`mark:${i.id}`),
      }),
      idOf,
      { phase: 'watch-x', log: (l) => logs.push(l) },
    );
    expect(tick).toEqual({ reviewed: ['h#1'], failed: [], skipped: [] });
    expect(order).toEqual(['claim:1', 'review:1', 'mark:1']);
    expect(logs).toEqual(['watch-x: poll -> 1 ready', 'watch-x h#1: claim -> reviewing', 'watch-x h#1: reviewed -> marked']);
  });

  it('skips a claimed item and restores labels on review failure, even when the restore throws', async () => {
    const restored: number[] = [];
    const logs: string[] = [];
    const tick = await reviewWatchOnce(
      quiet({
        listReady: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
        claim: async (i) => {
          if (i.id === 1) throw new Error('claimed');
        },
        review: async () => {
          throw new Error('boom');
        },
        onFailure: async (i) => {
          restored.push(i.id);
          if (i.id === 3) throw new Error('restore boom');
        },
      }),
      idOf,
      { concurrency: 1, log: (l) => logs.push(l) },
    );
    expect(tick).toEqual({ reviewed: [], failed: ['h#2', 'h#3'], skipped: ['h#1'] });
    expect(restored).toEqual([2, 3]);
    expect(logs).toContain('watch h#2: failed -> retry later (boom)');
    expect(logs.some((l) => l.includes('watch h#3: restore failed -> manual label check'))).toBe(true);
  });

  it('reports list failures as failed in the tick', async () => {
    const tick = await reviewWatchOnce(quiet({ takeListFailures: () => ['h#9'] }), idOf);
    expect(tick.failed).toEqual(['h#9']);
  });

  it('does not count a usage-cap pause as failed, but still calls onFailure', async () => {
    const restored: number[] = [];
    const tick = await reviewWatchOnce(
      quiet({
        listReady: async () => [{ id: 1 }, { id: 2 }],
        review: async (i) => {
          throw i.id === 1 ? new UsageCapError('claude', 95, 90, new Date('2026-11-09T05:00:00Z')) : new Error('boom');
        },
        onFailure: async (i) => void restored.push(i.id),
      }),
      idOf,
      { concurrency: 1 },
    );
    expect(tick).toEqual({ reviewed: [], failed: ['h#2'], skipped: [] });
    expect(restored).toEqual([1, 2]);
  });
});

describe('incompleteCapState', () => {
  it('is below the cap with fewer attempts, and stops at the limit', () => {
    expect(incompleteCapState([attempt()], 'abc', 'pr').stop).toBe(false);
    const full = Array.from({ length: INCOMPLETE_RETRY_LIMIT }, () => attempt());
    expect(incompleteCapState(full, 'abc', 'pr')).toMatchObject({ attempts: 3, stop: true });
  });

  it('counts the pending attempt when asked', () => {
    const two = [attempt(), attempt()];
    expect(incompleteCapState(two, 'abc', 'pr').stop).toBe(false);
    expect(incompleteCapState(two, 'abc', 'pr', 1).stop).toBe(true);
  });

  it('stops once a cap marker for this head exists, and ignores one for another head', () => {
    expect(incompleteCapState([cap('abc')], 'abc', 'pr')).toMatchObject({ capPosted: true, stop: true });
    expect(incompleteCapState([cap('def')], 'abc', 'pr').stop).toBe(false);
  });

  it('ignores a cap marker from an untrusted author', () => {
    expect(incompleteCapState([cap('abc', 'untrusted'), attempt()], 'abc', 'pr')).toMatchObject({ capPosted: false, attempts: 1, stop: false });
  });
});

describe('reviewWatchLoop', () => {
  it('with once returns the tick, including list failures', async () => {
    const tick = await reviewWatchLoop(quiet({ takeListFailures: () => ['h#9'] }), idOf, { once: true });
    expect(tick?.failed).toEqual(['h#9']);
  });

  it('continuous ticks leave no abort listener behind on the signal', async () => {
    const controller = new AbortController();
    const listeners: number[] = [];
    const listReady = vi.fn(async (): Promise<Item[]> => {
      listeners.push(getEventListeners(controller.signal, 'abort').length);
      if (listeners.length === 12) controller.abort();
      return [];
    });
    await reviewWatchLoop(quiet({ listReady }), idOf, { signal: controller.signal, intervalMs: 0 });
    expect(listeners).toEqual(Array(12).fill(0));
  });
});
