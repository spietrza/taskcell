import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubClient } from './client.js';
import { createHubSession, type StreamAdapter } from './session.js';
import { encodeError, encodeEvent, encodeResult, HUB_SIGN_IN_REQUIRED } from './hub-wire.js';
import type { HubStreamHandlers } from './client.js';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

/** A fake stream transport: every `open` is recorded so a test can drive its handlers. */
function fakeStream(): { adapter: StreamAdapter; opens: { handlers: HubStreamHandlers; closed: boolean }[] } {
  const opens: { handlers: HubStreamHandlers; closed: boolean }[] = [];
  const adapter: StreamAdapter = (handlers) => {
    const entry = { handlers, closed: false };
    opens.push(entry);
    return Object.defineProperty(() => { entry.closed = true; }, 'lastEventId', { get: () => undefined }) as ReturnType<StreamAdapter>;
  };
  return { adapter, opens };
}

const session = (stream: StreamAdapter, extra: Partial<Parameters<typeof createHubSession>[0]> = {}, fetchImpl?: typeof fetch) =>
  createHubSession({ client: createHubClient({ token: 't', fetch: fetchImpl ?? ((async () => json(200, encodeResult(1))) as typeof fetch) }), stream, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('hub session stream', () => {
  it('shares one stream among subscribers and closes it after the last', () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter);
    const a = s.subscribe({ onEvent: vi.fn() });
    const b = s.subscribe({ onEvent: vi.fn() });
    expect(opens).toHaveLength(1);
    a();
    expect(opens[0]!.closed).toBe(false);
    b();
    expect(opens[0]!.closed).toBe(true);
  });

  it('reconnects with doubling backoff, resetting on a frame, and calls onOpen as a catch-up', () => {
    const { adapter, opens } = fakeStream();
    const issue = vi.fn();
    const s = session(adapter, { onConnectionIssue: issue });
    const onOpen = vi.fn();
    s.subscribe({ onEvent: vi.fn(), onOpen });
    opens[0]!.handlers.onOpen?.();
    expect(onOpen).not.toHaveBeenCalled(); // the first open is no catch-up
    opens[0]!.handlers.onError?.('event stream closed');
    expect(issue).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(opens).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(opens).toHaveLength(2);
    expect(opens[0]!.closed).toBe(true);
    opens[1]!.handlers.onError?.('down'); // failed again before any frame: 2 s
    vi.advanceTimersByTime(1999);
    expect(opens).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(opens).toHaveLength(3);
    opens[2]!.handlers.onOpen?.();
    expect(onOpen).toHaveBeenCalledOnce();
    opens[2]!.handlers.onEvent('x', 1); // a frame resets the backoff
    opens[2]!.handlers.onError?.('down');
    vi.advanceTimersByTime(1000);
    expect(opens).toHaveLength(4);
  });

  it('caps the backoff', () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter, { minBackoffMs: 10, maxBackoffMs: 25 });
    s.subscribe({ onEvent: vi.fn() });
    for (const wait of [10, 20, 25, 25]) {
      opens.at(-1)!.handlers.onError?.('down');
      vi.advanceTimersByTime(wait);
    }
    expect(opens).toHaveLength(5);
  });

  it('treats a second open of the same stream (an adapter that reconnects itself) as a catch-up', () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter);
    const onOpen = vi.fn();
    s.subscribe({ onEvent: vi.fn(), onOpen });
    opens[0]!.handlers.onOpen?.();
    opens[0]!.handlers.onOpen?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('ignores callbacks from a superseded stream', () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter);
    const onEvent = vi.fn();
    s.subscribe({ onEvent });
    opens[0]!.handlers.onError?.('down');
    vi.advanceTimersByTime(1000);
    opens[0]!.handlers.onEvent('late', 1);
    opens[0]!.handlers.onError?.('late');
    vi.advanceTimersByTime(60000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(opens).toHaveLength(2);
  });

  it('delivers a skipped change frame, and a stream reset, as onReset', () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter);
    const onReset = vi.fn();
    s.subscribe({ onEvent: vi.fn(), onReset });
    opens[0]!.handlers.onError?.('too large', { streamOpen: true, event: 'vanguard:changed' });
    opens[0]!.handlers.onError?.('too large', { streamOpen: true, event: 'api:event' });
    opens[0]!.handlers.onReset?.();
    expect(onReset).toHaveBeenCalledTimes(2);
    expect(opens).toHaveLength(1);
  });

  it('reconnects when woken, and stops the wake trigger with the stream', () => {
    const { adapter, opens } = fakeStream();
    let fire = (): void => {};
    const unwake = vi.fn();
    const s = session(adapter, { wake: (f) => { fire = f; return unwake; } });
    const sub = s.subscribe({ onEvent: vi.fn() });
    fire();
    expect(opens).toHaveLength(2);
    sub();
    expect(unwake).toHaveBeenCalledOnce();
  });
});

describe('hub session refusal', () => {
  it('signals token-refused on a stream 401 and stops retrying', async () => {
    const refused = vi.fn();
    const fake = vi.fn(async () => json(401, encodeError({ message: 'invalid hub token', kind: 'bad-request' }, 401).body));
    const client = createHubClient({ token: 't', fetch: fake as unknown as typeof fetch });
    const s = createHubSession({ client, onRefused: refused });
    const onError = vi.fn();
    s.subscribe({ onEvent: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(refused).toHaveBeenCalledWith('token-refused');
    expect(s.refused).toBe('token-refused');
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake).toHaveBeenCalledOnce();
  });

  it('signals sign-in-required on a stream or RPC 401 with that body', async () => {
    const refused = vi.fn();
    const body = { error: { message: HUB_SIGN_IN_REQUIRED } };
    const s = createHubSession({ client: createHubClient({ token: 't', fetch: (async () => json(401, body)) as typeof fetch }), onRefused: refused });
    await expect(s.call('caller_capabilities')).rejects.toBe(HUB_SIGN_IN_REQUIRED);
    expect(refused).toHaveBeenCalledWith('sign-in-required');
    const s2 = createHubSession({ client: createHubClient({ token: 't', fetch: (async () => json(401, body)) as typeof fetch }), onRefused: refused });
    s2.subscribe({ onEvent: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it("does not treat a proxy's 401 as a refusal: the stream is retried", async () => {
    const refused = vi.fn();
    const issue = vi.fn();
    const fake = vi.fn(async () => json(401, { error: { message: 'proxy auth' } }));
    const s = createHubSession({ client: createHubClient({ token: 't', fetch: fake as unknown as typeof fetch }), onRefused: refused, onConnectionIssue: issue });
    s.subscribe({ onEvent: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refused).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalled();
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('resumes the stream once a call succeeds after a refusal', async () => {
    const { adapter, opens } = fakeStream();
    let ok = false;
    const fetchImpl = (async () => (ok ? json(200, encodeResult(1)) : json(401, { error: { message: 'invalid hub token' } }))) as typeof fetch;
    const s = session(adapter, {}, fetchImpl);
    s.subscribe({ onEvent: vi.fn() });
    await expect(s.call('caller_capabilities')).rejects.toBe('invalid hub token');
    expect(s.refused).toBe('token-refused');
    ok = true;
    await s.call('caller_capabilities');
    expect(s.refused).toBeUndefined();
    expect(opens).toHaveLength(2);
  });
});

describe('hub session over a fake fetch stream', () => {
  it('reconnects after the stream closes and delivers the catch-up and a reset', async () => {
    let n = 0;
    const fake = vi.fn(async () => new Response(++n === 1 ? encodeEvent(1, 'vanguard:changed', 'r') : encodeEvent(undefined, 'stream-reset', null)));
    const s = createHubSession({ client: createHubClient({ token: 't', fetch: fake as unknown as typeof fetch }) });
    const events: unknown[] = [];
    const onOpen = vi.fn();
    const onReset = vi.fn();
    s.subscribe({ onEvent: (name, p) => events.push([name, p]), onOpen, onReset });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([['vanguard:changed', 'r']]);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
    s.close();
  });
});

describe('hub session live read', () => {
  const setup = () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter);
    let calls = 0;
    const releases: (() => void)[] = [];
    const read = vi.fn(() => new Promise<number>((resolve) => { const k = ++calls; releases.push(() => resolve(k)); }));
    const data: number[] = [];
    const errors: string[] = [];
    const live = s.liveRead(read, { onData: (d) => data.push(d), onError: (e) => errors.push(e) });
    return { s, opens, read, releases, data, errors, live };
  };

  it('reads at once, and again on change, reset and catch-up', async () => {
    const { opens, read, releases, data } = setup();
    expect(read).toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.advanceTimersByTimeAsync(0);
    opens[0]!.handlers.onEvent('vanguard:changed', 'r');
    expect(read).toHaveBeenCalledTimes(2);
    releases[1]!();
    await vi.advanceTimersByTimeAsync(0);
    opens[0]!.handlers.onReset?.();
    releases[2]!();
    await vi.advanceTimersByTimeAsync(0);
    opens[0]!.handlers.onEvent('other', 1); // not a change
    expect(read).toHaveBeenCalledTimes(3);
    opens[0]!.handlers.onError?.('down');
    vi.advanceTimersByTime(1000);
    opens[1]!.handlers.onOpen?.(); // the catch-up after the reconnect
    expect(read).toHaveBeenCalledTimes(4);
    releases[3]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(data).toEqual([1, 2, 3, 4]);
  });

  it('coalesces changes arriving mid-read into one trailing read', async () => {
    const { opens, read, releases, data, live } = setup();
    opens[0]!.handlers.onEvent('vanguard:changed', 'r');
    opens[0]!.handlers.onEvent('vanguard:changed', 'r');
    opens[0]!.handlers.onReset?.();
    const pulled = live.reload();
    expect(read).toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    releases[1]!();
    await pulled;
    expect(read).toHaveBeenCalledTimes(2);
    expect(data).toEqual([1, 2]);
  });

  it('keeps going after a failed read, and delivers nothing after stop', async () => {
    const { opens, releases, errors, data, live, s } = setup();
    void releases; // first read never answers; make the next fail instead
    const failing = createHubSession({ client: createHubClient({ token: 't', fetch: (async () => json(200, encodeResult(1))) as typeof fetch }), stream: fakeStream().adapter });
    const onError = vi.fn();
    const onData = vi.fn();
    const reads = [Promise.reject('boom'), Promise.resolve(7)];
    const l = failing.liveRead(() => reads.shift()!, { onData, onError });
    await l.reload();
    await l.reload();
    expect(onError).toHaveBeenCalledWith('boom');
    expect(onData).toHaveBeenCalledWith(7);
    live.stop();
    releases[0]!();
    await vi.advanceTimersByTimeAsync(0);
    opens[0]!.handlers.onEvent('vanguard:changed', 'r');
    expect(data).toEqual([]);
    expect(errors).toEqual([]);
    expect(opens[0]!.closed).toBe(true);
    s.close();
  });

  it('filters changes and polls on a timer, gated by shouldPoll', async () => {
    const { adapter, opens } = fakeStream();
    const s = session(adapter);
    const read = vi.fn(async () => 1);
    let visible = true;
    s.liveRead(read, { onData: () => {}, changed: (p) => p === 'mine', pollMs: 100, shouldPoll: () => visible });
    await vi.advanceTimersByTimeAsync(0);
    opens[0]!.handlers.onEvent('vanguard:changed', 'other');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    opens[0]!.handlers.onEvent('vanguard:changed', 'mine');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(3);
    visible = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
