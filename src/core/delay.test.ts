import { describe, it, expect } from 'vitest';
import { delay } from './delay.js';

describe('delay', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    await expect(delay(60_000, AbortSignal.abort())).resolves.toBeUndefined();
  });

  it('resolves early on abort', async () => {
    const controller = new AbortController();
    const pending = delay(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
