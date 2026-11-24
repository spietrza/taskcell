import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { INCOMPLETE_RETRY_LIMIT, incompleteCapState, reviewWatchLoop, reviewWatchOnce } from './review-watch.js';
import { classifyAuthor } from '../tasks/comment-trust.js';
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

  it('stops restoring the trigger label once the incomplete cap is reached', async () => {
    const bodies = Array.from({ length: INCOMPLETE_RETRY_LIMIT }, () => 'attempt abc');
    const relabelled: number[] = [];
    const tick = await reviewWatchOnce(
      quiet({
        listReady: async () => [{ id: 1 }],
        review: async () => {
          throw new Error('incomplete');
        },
        onFailure: async (i) => {
          if (!incompleteCapState(bodies, 'abc', (b, h) => b.endsWith(h), CAP_RE).stop) relabelled.push(i.id);
        },
      }),
      idOf,
    );
    expect(tick.failed).toEqual(['h#1']);
    expect(relabelled).toEqual([]);
  });
});

const CAP_RE = /^<!-- cap: ([a-f0-9]+) -->$/gm;
const isAttempt = (body: string, head: string): boolean => body === `attempt ${head}`;

describe('incompleteCapState', () => {
  it('is below the cap with fewer attempts, and stops at the limit', () => {
    expect(incompleteCapState(['attempt abc'], 'abc', isAttempt, CAP_RE).stop).toBe(false);
    const full = Array.from({ length: INCOMPLETE_RETRY_LIMIT }, () => 'attempt abc');
    expect(incompleteCapState(full, 'abc', isAttempt, CAP_RE)).toMatchObject({ attempts: 3, stop: true });
  });

  it('counts the pending attempt when asked', () => {
    const two = ['attempt abc', 'attempt abc'];
    expect(incompleteCapState(two, 'abc', isAttempt, CAP_RE).stop).toBe(false);
    expect(incompleteCapState(two, 'abc', isAttempt, CAP_RE, 1).stop).toBe(true);
  });

  it('stops once a cap marker for this head exists, and ignores one for another head', () => {
    expect(incompleteCapState(['<!-- cap: abc -->'], 'abc', isAttempt, CAP_RE)).toMatchObject({ capPosted: true, stop: true });
    expect(incompleteCapState(['<!-- cap: def -->'], 'abc', isAttempt, CAP_RE).stop).toBe(false);
  });

  it('ignores a cap marker from an untrusted author once the adapter filters by trust', () => {
    const notes = [
      { author: 'mallory', body: '<!-- cap: abc -->' },
      { author: 'taskcell-bot', body: 'attempt abc' },
    ];
    const trusted = notes.filter((n) => classifyAuthor(n.author, undefined, { botLogins: ['taskcell-bot'] }) !== 'untrusted').map((n) => n.body);
    expect(incompleteCapState(trusted, 'abc', isAttempt, CAP_RE)).toMatchObject({ capPosted: false, attempts: 1, stop: false });
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
