import { describe, expect, it, vi } from 'vitest';
import { tailRun, type RunLogEvent, type RunTailClient } from './runTail.js';

const ev = (id: number, event = 'note', data: unknown = `line ${id}`, ts = new Date().toISOString()): RunLogEvent => ({ id, ts, event, data });
const end = (id: number, ts?: string): RunLogEvent => ev(id, 'api:event', { runId: 'x', event: { type: 'run-end' } }, ts);

function fake(page = 2000) {
  let log: RunLogEvent[] = [];
  const reads: number[] = [];
  let emit: (name: string, payload: unknown) => void = () => {};
  const client = {
    call: vi.fn(async (_cmd: string, args: { after: number }) => {
      reads.push(args.after);
      const rest = log.filter((e) => e.id > args.after);
      const events = rest.slice(0, page);
      return { events, nextAfter: events.at(-1)?.id ?? args.after, hasMore: rest.length > page, truncated: false };
    }),
    subscribe: vi.fn((h: { onEvent: typeof emit }) => {
      emit = h.onEvent;
      return Object.assign(() => {}, { lastEventId: undefined });
    }),
  } as unknown as RunTailClient;
  return { client, reads, set: (l: RunLogEvent[]) => void (log = l), emit: (n: string, p: unknown) => emit(n, p) };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('tailRun', () => {
  it('pages with after/hasMore past the first page and ends at the terminal event', async () => {
    const f = fake(500);
    f.set([...Array.from({ length: 1199 }, (_, i) => ev(i + 1)), end(1200)]);
    const onEvents = vi.fn();
    const onEnd = vi.fn();
    tailRun(f.client, { repoPath: '/r', taskId: 't' }, { onEvents, onEnd, onError: vi.fn() });
    await settle();
    expect(f.reads).toEqual([0, 500, 1000]);
    expect(onEvents.mock.calls.at(-1)![0]).toHaveLength(1200);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('keeps only the newest `keep` events', async () => {
    const f = fake();
    f.set(Array.from({ length: 80 }, (_, i) => ev(i + 1)));
    const onEvents = vi.fn();
    tailRun(f.client, { repoPath: '/r', taskId: 't', keep: 50 }, { onEvents, onEnd: vi.fn(), onError: vi.fn() });
    await settle();
    const last = onEvents.mock.calls.at(-1)![0] as RunLogEvent[];
    expect(last).toHaveLength(50);
    expect(last[0]!.id).toBe(31);
  });

  it("reads only on events of its run, or its repo's change", async () => {
    const f = fake();
    f.set([ev(1)]);
    tailRun(f.client, { repoPath: '/r', taskId: 'gh-5' }, { onEvents: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });
    await settle();
    const before = f.reads.length;
    f.emit('vanguard:changed', '/other');
    f.emit('api:event', { runId: 'y', event: { type: 'stage-start' } });
    await settle();
    expect(f.reads.length).toBe(before);
    f.emit('api:event', { runId: 'y', event: { type: 'run-start', taskId: 'gh-5' } });
    await settle();
    expect(f.reads.length).toBe(before + 1);
    f.emit('api:event', { runId: 'y', event: { type: 'stage-start' } });
    f.emit('vanguard:changed', '/r');
    await settle();
    expect(f.reads.length).toBeGreaterThan(before + 1);
  });

  it("drops an older run's ended log and reads again from the start", async () => {
    const f = fake();
    f.set([ev(1), end(2, '2026-07-06T10:01:00Z')]);
    const onEnd = vi.fn();
    const onEvents = vi.fn();
    tailRun(f.client, { repoPath: '/r', taskId: 't', activeSince: Date.parse('2026-07-06T11:00:00Z') }, { onEvents, onEnd, onError: vi.fn() });
    await settle();
    expect(onEnd).not.toHaveBeenCalled();
    f.set([ev(1)]);
    f.emit('vanguard:changed', '/r');
    await settle();
    expect(f.reads.at(-1)).toBe(0);
    expect(onEvents.mock.calls.at(-1)![0]).toHaveLength(1);
  });

  it('follow: false reads once without subscribing', async () => {
    const f = fake();
    f.set([ev(1)]);
    tailRun(f.client, { repoPath: '/r', taskId: 't', follow: false }, { onEvents: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });
    await settle();
    expect(f.client.subscribe).not.toHaveBeenCalled();
    expect(f.reads).toEqual([0]);
  });
});
