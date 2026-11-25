import { test, expect, afterEach, vi } from 'vitest';
import { hub, subscribe, onHubRestart, onHubConnectionIssue, onHubConnectionRecovered, captureHubToken, watchHubToken, STREAM_EVENTS, type HubEventsListed } from './transport';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = (cmd: string, args?: Record<string, unknown>): Promise<any> => hub().call(cmd as 'list_runs', args as never);
const onStreamReset = (handler: () => void): Promise<() => void> => {
  const stop = hub().subscribe({ onEvent: () => {}, onReset: handler });
  return Promise.resolve(() => stop());
};

/** Minimal fake EventSource — jsdom doesn't implement one. Tracks every instance so a test can
 * assert how many were actually constructed (the "one shared EventSource" guarantee). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closed = false;
  readyState = 1; // OPEN; 2 is CLOSED — the browser gave up reconnecting (e.g. a 401 on /events)
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
  }
  removeEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(cb);
  }
  close(): void {
    this.closed = true;
  }
  emit(name: string, data: unknown): void {
    const payload = { data: JSON.stringify(data) } as MessageEvent;
    for (const cb of this.listeners.get(name) ?? []) cb(payload);
  }
}

/** The shared EventSource opens only once its `POST /events/session` settles (transport.ts). */
async function sourceOpened(): Promise<FakeEventSource> {
  for (let i = 0; i < 50 && FakeEventSource.instances.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  return FakeEventSource.instances[0]!;
}

/** Answers the events-session POST the way the hub does (the cookie itself is the browser's job). */
function stubSessionFetch(): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }),
  );
  return calls;
}

/** The events-session POST succeeds; every other fetch (the `/events` probe) answers with `probe`. */
function probeOnly(probe: () => Promise<Response>): (url: string) => Promise<Response> {
  return vi.fn(async (url: string) =>
    url === '/events/session' ? new Response(JSON.stringify({ result: null }), { status: 200 }) : probe(),
  );
}

afterEach(() => {
  // A fresh launch clears the module's "token refused" state, so one test's refusal does not mute the next.
  window.history.replaceState(null, '', '/#token=reset');
  captureHubToken();
  delete window.__TASKCELL_HUB__;
  delete window.__TASKCELL_MOCK__;
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  FakeEventSource.instances = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('mock mode answers from the fixtures in-browser: no fetch, no event stream', async () => {
  window.__TASKCELL_MOCK__ = true;
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  expect(await invoke('list_active')).toBeInstanceOf(Array);
  await subscribe('api:event', () => {});
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('without the mock or demo marker, invoke goes to the hub even with no hub marker', async () => {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  await invoke('list_runs', { repoPath: '/repo' });
  expect(fetchSpy).toHaveBeenCalledOnce();
});

test('T-90 hub invoke POSTs to /rpc/<cmd> with the args object and resolves result', async () => {
  window.sessionStorage.setItem('vanguard-hub-token', 'test-token');
  window.__TASKCELL_HUB__ = true;
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ result: { runs: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const result = await invoke('list_runs', { repoPath: '/repo' });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/rpc/list_runs');
  expect(calls[0].init.method).toBe('POST');
  expect((calls[0].init.headers as Record<string, string>)['x-vanguard-hub-token']).toBe('test-token');
  expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ repoPath: '/repo' });
  expect(result).toEqual({ runs: [] });
});

test('the launch URL fragment token moves into sessionStorage, leaves the address bar, and is sent', async () => {
  window.history.replaceState(null, '', '/runs?x=1#token=frag%26tok&keep=1');
  window.sessionStorage.setItem('vanguard-hub-token', 'stale-from-old-launch');
  window.__TASKCELL_HUB__ = true;
  captureHubToken();
  expect(window.sessionStorage.getItem('vanguard-hub-token')).toBe('frag&tok');
  expect(window.location.pathname + window.location.search + window.location.hash).toBe('/runs?x=1#keep=1');

  const headers: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      headers.push((init.headers as Record<string, string>)['x-vanguard-hub-token']!);
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }),
  );
  window.history.replaceState(null, '', '/'); // a later reload of the bare URL keeps the token
  await invoke('list_runs', {});
  expect(headers).toEqual(['frag&tok']);
});

test('without a launch fragment or stored token, hub calls send an empty token', async () => {
  window.__TASKCELL_HUB__ = true;
  const headers: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      headers.push((init.headers as Record<string, string>)['x-vanguard-hub-token']!);
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }),
  );
  await invoke('list_runs', {});
  expect(headers).toEqual(['']);
});

test('T-91 an error body rejects with the message string', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'repoPath is required', kind: 'bad-request' } }), { status: 400 }),
    ),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBe('repoPath is required');
  expect(typeof err).toBe('string');
  expect(String(err)).toBe('repoPath is required'); // matches Tauri's Err(String) rendering
});

test('T-92 a network failure rejects with a string', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(typeof err).toBe('string');
  expect(err).toContain('Failed to fetch');
});

test('T-92b a non-JSON response also rejects with a string', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>not json</html>', { status: 200 })),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(typeof err).toBe('string');
});

test('T-93 one shared EventSource, handlers routed by event name', async () => {
  window.sessionStorage.setItem('vanguard-hub-token', 'a&b');
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const sessionCalls = stubSessionFetch();
  const aEvents: unknown[] = [];
  const bEvents: unknown[] = [];
  const unlistenA = await subscribe<{ x: number }>('api:event', (e) => aEvents.push(e.payload));
  const unlistenB = await subscribe<{ y: number }>('spawn:output', (e) => bEvents.push(e.payload));

  const es = await sourceOpened();
  expect(FakeEventSource.instances).toHaveLength(1); // shared, not one per subscriber
  expect(es.url).toBe('/events'); // the token never goes into the URL
  expect(sessionCalls).toHaveLength(1);
  expect(sessionCalls[0]!.url).toBe('/events/session');
  expect(sessionCalls[0]!.init?.method).toBe('POST');
  expect((sessionCalls[0]!.init?.headers as Record<string, string>)['x-vanguard-hub-token']).toBe('a&b');
  es.emit('api:event', { x: 1 });
  es.emit('spawn:output', { y: 2 });
  expect(aEvents).toEqual([{ x: 1 }]);
  expect(bEvents).toEqual([{ y: 2 }]);

  unlistenA();
  unlistenB();
});

test('a live read re-reads after the browser reconnects the event stream (catch-up), on a change and on a reset', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubSessionFetch();
  let reads = 0;
  const live = hub().liveRead(async () => ++reads, { onData: () => {}, changed: (p) => p === '/repo' });
  const es = await sourceOpened();
  es.emit('open', {}); // the first open: the read at start covers it
  await new Promise((r) => setTimeout(r, 0));
  expect(reads).toBe(1);
  es.emit('error', {}); // a transient drop: the browser retries by itself
  es.emit('open', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(reads).toBe(2);
  es.emit('vanguard:changed', '/other');
  es.emit('vanguard:changed', '/repo');
  await new Promise((r) => setTimeout(r, 0));
  expect(reads).toBe(3);
  es.emit('stream-reset', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(reads).toBe(4);
  live.stop();
  expect(es.closed).toBe(true);
});

test('T-94 unsubscribe closes the source when the last handler leaves', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubSessionFetch();
  const unlistenA = await subscribe('api:event', () => {});
  const unlistenB = await subscribe('spawn:output', () => {});
  const es = await sourceOpened();

  unlistenA();
  expect(es.closed).toBe(false); // event-b's handler still live

  unlistenB();
  expect(es.closed).toBe(true);
});

test.each([null, {}, { projects: [] }])('hub invoke rejects malformed success body %j', async (body) => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  await expect(invoke('list_projects')).rejects.toBe('hub response body is missing "result"');
});

test.each([false, 0, '', null])('hub invoke preserves result %j', async (result) => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 })));
  await expect(invoke('list_projects')).resolves.toBe(result);
});

test('T-95 a stream-reset frame triggers every registered resync callback (#491)', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubSessionFetch();
  const calls: string[] = [];
  const unlistenA = await onStreamReset(() => calls.push('a'));
  const unlistenB = await onStreamReset(() => calls.push('b'));

  const es = await sourceOpened();
  es.emit('stream-reset', {});
  expect(calls).toEqual(['a', 'b']);

  unlistenA();
  unlistenB();
});

test('T-96 a stream-reset also reaches a named subscription\'s resync sibling, not its own handler', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubSessionFetch();
  const changed: unknown[] = [];
  const resyncs: number[] = [];
  const unlistenChanged = await subscribe<string>('vanguard:changed', (e) => changed.push(e.payload));
  const unlistenReset = await onStreamReset(() => resyncs.push(1));

  const es = await sourceOpened();
  expect(FakeEventSource.instances).toHaveLength(1); // still one shared source
  es.emit('stream-reset', {});
  expect(resyncs).toEqual([1]);
  expect(changed).toEqual([]); // stream-reset never reaches a named handler as a payload

  es.emit('vanguard:changed', '/repo');
  expect(changed).toEqual(['/repo']);

  unlistenChanged();
  unlistenReset();
});

test('a permanently closed SSE stream probes before deciding: the hub\'s own token rejection notifies onHubRestart', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    probeOnly(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401 }),
    ),
  );
  const restarts: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  const es = await sourceOpened();

  es.emit('error', {}); // still OPEN: a transient drop the browser retries on its own
  expect(restarts).toEqual([]);

  es.readyState = 2;
  es.emit('error', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(restarts).toEqual([1]);

  unlistenSub();
  unlistenRestart();
});

test('a 403 on /events (the Host check, not the hub\'s own token) notifies onHubConnectionIssue, not onHubRestart', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    probeOnly(async () =>
      new Response(JSON.stringify({ error: { message: 'Host not allowed', kind: 'bad-request' } }), { status: 403 }),
    ),
  );
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  const es = await sourceOpened();

  es.readyState = 2;
  es.emit('error', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(restarts).toEqual([]);

  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test('a network error probing /events (a proxy 502, connection dropped) notifies onHubConnectionIssue, not onHubRestart', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', probeOnly(async () => { throw new TypeError('network error'); }));
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  const es = await sourceOpened();

  es.readyState = 2;
  es.emit('error', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(restarts).toEqual([]);

  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test.each([
  ['a Host-check 403', 403, { error: { message: 'Host not allowed', kind: 'bad-request' } }],
  ['a reverse proxy 401', 401, { message: 'proxy login required' }],
  ['a proxy 502', 502, {}],
])('a failed events-session request (%s) notifies onHubConnectionIssue and opens no stream', async (_label, status, body) => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  for (let i = 0; i < 10 && issues.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(restarts).toEqual([]);
  expect(FakeEventSource.instances).toHaveLength(0);
  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test('the hub\'s own token rejection on the events-session request notifies onHubRestart', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401 })),
  );
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  for (let i = 0; i < 10 && restarts.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  expect(restarts).toEqual([1]);
  expect(issues).toEqual([]);
  expect(FakeEventSource.instances).toHaveLength(0);
  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test('onHubConnectionIssue is a no-op outside hub mode', async () => {
  const unlisten = await onHubConnectionIssue(() => {
    throw new Error('must not be called under Tauri');
  });
  expect(() => unlisten()).not.toThrow();
});

test('a 401 from /rpc/<cmd> also notifies onHubRestart, and still rejects with the message', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401 }),
    ),
  );
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));

  await expect(invoke('list_runs', {})).rejects.toBe('invalid hub token');
  expect(restarts).toEqual([1]);

  unlisten();
});

test("a 401 that isn't the hub's own envelope (a reverse proxy's) does not claim the hub restarted", async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Unauthorized', kind: 'bad-request' } }), { status: 401 })),
  );
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));

  await expect(invoke('list_runs', {})).rejects.toBe('Unauthorized');
  expect(restarts).toEqual([]);

  unlisten();
});

test('onHubRestart is a no-op outside hub mode', async () => {
  const unlisten = await onHubRestart(() => {
    throw new Error('must not be called under Tauri');
  });
  expect(() => unlisten()).not.toThrow();
});

test('T-97 onStreamReset is a no-op outside hub mode', async () => {
  const unlisten = await onStreamReset(() => {
    throw new Error('must not be called under Tauri');
  });
  expect(() => unlisten()).not.toThrow();
});

test('a token added to an open page\'s address is stripped too (demo mode makes no hub call that would)', () => {
  window.history.replaceState(null, '', '/?demo=1');
  watchHubToken();
  window.history.replaceState(null, '', '/?demo=1#token=late');
  window.dispatchEvent(new Event('hashchange'));
  expect(window.location.search + window.location.hash).toBe('?demo=1');
  expect(window.sessionStorage.getItem('vanguard-hub-token')).not.toBe('late');
  // Outside demo the listener leaves the fragment: the next hub call captures a pasted launch URL, so the tab reconnects in place.
  window.history.replaceState(null, '', '/#token=pasted');
  window.dispatchEvent(new Event('hashchange'));
  expect(window.location.hash).toBe('#token=pasted');
  captureHubToken();
  expect(window.sessionStorage.getItem('vanguard-hub-token')).toBe('pasted');
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** A hub that accepts exactly `valid()`; records the token each call offered. */
function stubTokenHub(valid: () => string): string[] {
  const offered: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>)['x-vanguard-hub-token']!;
      offered.push(token);
      return token === valid()
        ? new Response(JSON.stringify({ result: 'ok' }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401 });
    }),
  );
  return offered;
}

/** Open the page with its launch URL: the tab holds `token`, nothing pending, nothing refused. */
function launchWith(token: string): void {
  window.__TASKCELL_HUB__ = true;
  window.history.replaceState(null, '', `/#token=${token}`);
  captureHubToken();
}

test('a #token link followed on an open page does not replace a working token: requests keep the held one', async () => {
  launchWith('good');
  const offered = stubTokenHub(() => 'good');
  // A link in rendered Markdown (a spec, a comment), seen first by a hub call…
  window.history.replaceState(null, '', '/?screen=runs#token=evil&keep=1');
  await invoke('list_runs', {});
  expect(window.location.search + window.location.hash).toBe('?screen=runs#keep=1');
  // …or first by the address-bar listener.
  watchHubToken();
  window.history.replaceState(null, '', '/#token=evil2');
  window.dispatchEvent(new Event('hashchange'));
  expect(window.location.hash).toBe('');
  await invoke('list_runs', {});
  expect(offered).toEqual(['good', 'good']);
  expect(window.sessionStorage.getItem('vanguard-hub-token')).toBe('good');
});

test('a launch URL pasted after a hub restart, before the tab has seen a 401, reconnects on the next call without another paste', async () => {
  launchWith('old');
  let valid = 'old';
  const offered = stubTokenHub(() => valid);
  await invoke('list_runs', {});
  valid = 'new'; // the hub restarted; this tab has not asked it anything since
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));
  window.history.replaceState(null, '', '/#token=new');
  await expect(invoke('list_runs', {})).resolves.toBe('ok');
  expect(offered).toEqual(['old', 'old', 'new']);
  expect(restarts).toEqual([]);
  expect(window.sessionStorage.getItem('vanguard-hub-token')).toBe('new');
  expect(window.location.hash).toBe('');
  await invoke('list_runs', {});
  expect(offered.at(-1)).toBe('new');
  unlisten();
});

test('two calls in flight when the pasted token is taken both retry with it; no false restart', async () => {
  launchWith('old');
  let valid = 'old';
  const offered = stubTokenHub(() => valid);
  await invoke('list_runs', {});
  valid = 'new';
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));
  window.history.replaceState(null, '', '/#token=new');
  await expect(Promise.all([invoke('list_runs', {}), invoke('list_runs', {})])).resolves.toEqual(['ok', 'ok']);
  expect(offered).toEqual(['old', 'old', 'old', 'new', 'new']);
  expect(restarts).toEqual([]);
  unlisten();
});

test('a refused tab stores a pasted launch URL at once; a pending token that is also refused is tried once, then reported', async () => {
  launchWith('old');
  let valid = 'other';
  const offered = stubTokenHub(() => valid);
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));
  window.history.replaceState(null, '', '/#token=evil'); // pending: the held token has not been refused yet
  await expect(invoke('list_runs', {})).rejects.toBe('invalid hub token');
  expect(offered).toEqual(['old', 'evil']);
  expect(restarts).toEqual([1]);
  valid = 'fresh';
  window.history.replaceState(null, '', '/#token=fresh');
  await expect(invoke('list_runs', {})).resolves.toBe('ok');
  expect(offered.at(-1)).toBe('fresh');
  unlisten();
});

test('a refused tab stops asking the hub until a new launch URL arrives, then reconnects', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  launchWith('old');
  const offered = stubTokenHub(() => 'new');
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));
  await expect(invoke('list_runs', {})).rejects.toBe('invalid hub token');
  // Later calls (polling) and the event stream send nothing: no refused sign-in lines in the audit log.
  await expect(invoke('list_runs', {})).rejects.toBe('invalid hub token');
  const unsub = await subscribe('api:event', () => {});
  await new Promise((r) => setTimeout(r, 0));
  expect(offered).toEqual(['old']);
  expect(restarts).toEqual([1]);
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload, hash: '#token=new', pathname: '/', search: '' });
  window.history.replaceState(null, '', '/#token=new');
  await expect(invoke('list_runs', {})).resolves.toBe('ok');
  expect(offered).toEqual(['old', 'new', 'new']); // the call, and the stream's session request reopened by the new token
  // Reconnected: one reload clears the banner and reopens the event stream.
  expect(reload).toHaveBeenCalledTimes(1);
  unsub();
  unlisten();
});

test("a proxy's non-JSON 401 on the events-session request is a connection issue: the hub's token is not blamed and calls keep going", async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const fetchSpy = vi.fn(async (url: string) => (url === '/events/session' ? new Response('<html>login</html>', { status: 401 }) : new Response(JSON.stringify({ result: 'ok' }), { status: 200 })));
  vi.stubGlobal('fetch', fetchSpy);
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  for (let i = 0; i < 10 && issues.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(restarts).toEqual([]);
  await expect(invoke('list_runs', {})).resolves.toBe('ok');
  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test('the connection-recovered signal fires once the stream re-opens after a connection issue', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  let sessions = 0;
  vi.stubGlobal('fetch', vi.fn(async () => (++sessions === 1 ? new Response('{}', { status: 502 }) : new Response('{}', { status: 200 }))));
  const issues: number[] = [];
  const recovered: number[] = [];
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenRecovered = await onHubConnectionRecovered(() => recovered.push(1));
  const unlistenSub = await subscribe('api:event', () => {});
  for (let i = 0; i < 10 && issues.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(recovered).toEqual([]);
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1), { timeout: 3000 }); // the session's backoff retry (1 s)
  const es = FakeEventSource.instances[0]!;
  es.emit('open', {});
  expect(recovered).toEqual([1]);
  unlistenSub();
  unlistenRecovered();
  unlistenIssue();
});

test('every hub event name is registered on the EventSource', async () => {
  const listed: HubEventsListed = true; // typecheck: fails when a key of the hub `Events` is missing from STREAM_EVENTS
  expect(listed).toBe(true);
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const unlistenSub = await subscribe('api:event', () => {});
  const es = await sourceOpened();
  for (const name of STREAM_EVENTS) expect(es.listeners.has(name)).toBe(true);
  unlistenSub();
});

test('a fixture error reaches the caller as the bare message, as a hub error does', async () => {
  window.__TASKCELL_MOCK__ = true;
  const backend = await import('./dev/mockBackend');
  vi.spyOn(backend, 'handle').mockRejectedValueOnce(new Error('boom'));
  await expect(invoke('list_active')).rejects.toBe('boom');
  vi.restoreAllMocks();
});

test('a fixture fault is a 500 `internal`, a thrown string a 400 `bad-request` (the hub shape)', async () => {
  window.__TASKCELL_MOCK__ = true;
  const backend = await import('./dev/mockBackend');
  vi.spyOn(backend, 'handle').mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce('nope');
  expect(await hub().request('list_active', undefined)).toEqual({ status: 500, body: { error: { message: 'boom', kind: 'internal' } } });
  expect(await hub().request('list_active', undefined)).toEqual({ status: 400, body: { error: { message: 'nope', kind: 'bad-request' } } });
  vi.restoreAllMocks();
});
