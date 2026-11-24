// Transport seam between the UI and its backend. The hub is the only product backend: the UI calls
// `POST /rpc/<cmd>` and reads the `/events` SSE stream, in a browser and in the desktop window alike
// (the desktop app starts a local hub and loads the UI the hub serves — apps/desktop/README.md,
// "Local hub"). The one exception is the in-browser fixture backend (dev/mockBackend.ts), which answers
// every command without a hub: demo mode, and the dev server's mock (`window.__TASKCELL_MOCK__`).
import {
  decodeEvent,
  encodeError,
  encodeResult,
  STREAM_RESET_EVENT,
  HUB_TOKEN_HEADER,
  HUB_EVENTS_SESSION_PATH,
  HUB_TOKEN_FRAGMENT_PARAM,
  HUB_TOKEN_REJECTED,
  isHubTokenRejected,
} from './hub-wire';
import { createHubClient, type HubClient, type HubResponse, type HubSubscription } from '../../../packages/hub-client/src/client';
import { createHubSession, type HubSession, type StreamAdapter } from '../../../packages/hub-client/src/session';

/** Stops a `subscribe()` listener. */
export type UnlistenFn = () => void;

declare global {
  interface Window {
    __TASKCELL_HUB__?: boolean;
    __TASKCELL_HUB_FLEET__?: boolean;
    __TASKCELL_DEMO__?: boolean;
    __TASKCELL_MOCK__?: boolean;
  }
}

/** Demo mode: `hub --demo` (server-injected marker) or `?demo=1` (the empty Home's "Try the demo
 * project"). Every command is answered in-browser from the bundled fixtures (dev/mockBackend.ts), so
 * nothing reaches a repo, remote or the hub, and there is no event stream. */
export function isDemoMode(): boolean {
  return window.__TASKCELL_DEMO__ === true || new URLSearchParams(window.location.search).get('demo') === '1';
}

/** The dev server's fixture mock (main.tsx sets the marker): the same in-browser path as demo mode,
 * but every fixture write succeeds instead of being refused. */
function isMockMode(): boolean {
  return window.__TASKCELL_MOCK__ === true;
}

/** Commands are answered in-browser from dev/mockBackend.ts: no hub, no event stream. */
function usesFixtureBackend(): boolean {
  return isDemoMode() || isMockMode();
}

// Fleet spawns programs — remote code execution on a reachable server — so only the desktop app's own
// loopback hub enables it (it injects `__TASKCELL_HUB_FLEET__`, src/hub/static.ts); src/hub/rpc.ts rejects
// the underlying calls on every other hub too.
export function canUseFleet(): boolean {
  return window.__TASKCELL_HUB_FLEET__ === true;
}

/** A hub restart mints a fresh per-launch token (src/hub/server.ts), so the one this tab holds
 * stops working: `/rpc/*` answers 401 and `/events` answers 401, which makes the browser close the
 * `EventSource` for good instead of reconnecting. Nothing the page can do fixes that — only opening
 * the new launch URL the hub printed hands it the new token — so both signals land here and the UI
 * says so (App.tsx) rather than going quietly stale. */
const restartHandlers = new Set<() => void>();
/** Anything else that kills `/events` for good — a 403 from the Host check, a reverse proxy's 502,
 * a network drop the probe below can't attribute to the hub's own token — gets this neutral signal
 * instead of the (wrong, misleading) "the hub restarted" wording. */
const connectionIssueHandlers = new Set<() => void>();

const HUB_TOKEN_STORAGE_KEY = 'vanguard-hub-token';

function fragmentToken(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(HUB_TOKEN_FRAGMENT_PARAM);
}

/** Move the launch URL's `#token=…` (src/cli/hub.ts) into sessionStorage and strip it from the
 * address bar, so it is neither bookmarked nor left in history. The server never sees a fragment and
 * never serves the token, so this is the only way a browser page gets one. No-op without the
 * fragment. A fresh launch URL overwrites a stored token from an earlier hub launch. */
function stripFragmentToken(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.delete(HUB_TOKEN_FRAGMENT_PARAM);
  const rest = params.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${rest === '' ? '' : `#${rest}`}`);
}

/** The hub answered the held token with its own 401; cleared when a new token is stored. */
let heldTokenRefused = false;

/** A new token is stored: the refusal is over, and the session's stream, stopped by it, reopens. */
function tokenRenewed(): void {
  heldTokenRefused = false;
  current?.session.resume();
}

/** A fragment token that turned up on an open page whose own token had not been refused: kept in memory
 * only, and used if the hub then refuses the held one (`adoptPendingToken`). */
let pendingToken: string | null = null;

/** `launch`: the fragment the page was opened with, always stored. A fragment that turns up on an open page
 * is stored at once by a tab with no token or a refused one (a pasted launch URL reconnects it). A tab whose
 * token may still work only remembers it: a `#token=…` link in rendered Markdown (a spec, a comment) cannot
 * replace a working token, and a launch URL pasted after a hub restart is taken on the first 401. */
function takeFragmentToken(launch: boolean): void {
  const token = fragmentToken();
  if (token === null) return;
  if (launch || !holdsWorkingToken()) {
    try {
      window.sessionStorage.setItem(HUB_TOKEN_STORAGE_KEY, token);
    } catch {
      return; // Storage blocked: keep the fragment, `hubToken()` reads it from there instead.
    }
    tokenRenewed();
    pendingToken = null;
  } else {
    pendingToken = token;
  }
  stripFragmentToken();
}

/** The hub refused the held token: switch to the pending one, if any. True when the caller should retry. */
function adoptPendingToken(): boolean {
  const token = pendingToken;
  pendingToken = null;
  if (token === null) return false;
  try {
    window.sessionStorage.setItem(HUB_TOKEN_STORAGE_KEY, token);
  } catch {
    return false;
  }
  tokenRenewed();
  return true;
}

export function captureHubToken(): void {
  restartShown = false; // a fresh launch shows no banner yet
  takeFragmentToken(true);
}

function holdsWorkingToken(): boolean {
  if (heldTokenRefused) return false;
  try {
    return (window.sessionStorage.getItem(HUB_TOKEN_STORAGE_KEY) ?? '') !== '';
  } catch {
    return false;
  }
}

/** `captureHubToken` now, and a check on every later change of the fragment: demo mode makes no hub call that
 * would strip a token added to an open page's address. */
export function watchHubToken(): void {
  captureHubToken();
  // Outside demo a tab with no token or a refused one leaves the fragment for the next hub call to capture
  // (`hubToken`), so it reconnects in place; a tab holding a token takes it off the address at once, as pending.
  window.addEventListener('hashchange', () => {
    if (fragmentToken() === null) return;
    if (isDemoMode()) stripFragmentToken();
    else if (holdsWorkingToken()) takeFragmentToken(false);
  });
}

/** Addresses of the demo's made-up repository: nothing real is behind them. */
export const DEMO_REPO_URL = 'https://github.com/demo-org/storefront';
export function isDemoLink(href: string): boolean {
  return isDemoMode() && href.startsWith(DEMO_REPO_URL);
}

/** This tab's token, or '' when it has none — the hub answers 401 either way, which is the signal
 * below. */
function hubToken(): string {
  takeFragmentToken(false);
  const fromFragment = fragmentToken();
  if (fromFragment !== null) return fromFragment;
  try {
    return window.sessionStorage.getItem(HUB_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Server mode: the session is gone (expired, revoked, signed out) — go to the sign-in page. */
function redirectToSignIn(): void {
  window.location.assign('/sign-in');
}

/** Server mode only: is someone signed in? Better Auth answers `/api/auth/get-session` with the
 * session or null; loopback mounts no OAuth and answers null, so there is nothing to sign out of. */
export async function hubSignedIn(): Promise<boolean> {
  if (usesFixtureBackend()) return false;
  try {
    const response = await fetch('/api/auth/get-session');
    return response.ok && (await response.json()) !== null;
  } catch {
    return false;
  }
}

export async function hubSignOut(): Promise<void> {
  await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  redirectToSignIn();
}

function notify(handlers: Set<() => void>): void {
  for (const h of handlers) h();
}

/** This page told the person the hub refused its token (the restart banner is up). */
let restartShown = false;

function notifyHubRestarted(): void {
  heldTokenRefused = true;
  restartShown = true;
  notify(restartHandlers);
}

/** A refused tab took a new launch URL and the hub answered: reload, so the banner goes and the event stream,
 * closed for good by the 401, reopens with every screen's data (the new token stays in sessionStorage). */
function reloadAfterReconnect(): void {
  if (!restartShown) return;
  restartShown = false;
  window.location.reload();
}

function notifyHubConnectionIssue(): void {
  notify(connectionIssueHandlers);
}

function onHubSignal(handlers: Set<() => void>, handler: () => void): Promise<UnlistenFn> {
  handlers.add(handler);
  return Promise.resolve(() => {
    handlers.delete(handler);
  });
}

/** Register a callback for "this page's hub token is dead, reload". */
export function onHubRestart(handler: () => void): Promise<UnlistenFn> {
  return onHubSignal(restartHandlers, handler);
}

/** Register a callback for "the hub connection is down, for some reason other than this page's own
 * token being dead" — a 403 from the Host check, a reverse proxy's 502, a plain network drop. */
export function onHubConnectionIssue(handler: () => void): Promise<UnlistenFn> {
  return onHubSignal(connectionIssueHandlers, handler);
}

/** `/events` closing tells a browser `EventSource` only that the connection is dead, never why —
 * `readyState` has no status code or body. Re-probe the same URL with a plain `fetch`, which does: the session
 * tells the hub's own `HUB_TOKEN_REJECTED` envelope on a 401 ("reload fixes this") from any other status (a
 * Host-check 403, a reverse proxy's 502) or a thrown network error, which is just a dead connection. */
async function probeEvents(): Promise<{ status?: number; body?: unknown }> {
  try {
    const response = await fetch('/events');
    if (response.status !== 401) {
      void response.body?.cancel();
      return { status: response.status };
    }
    return { status: 401, body: await response.json().catch(() => ({})) }; // an unreadable body is not the hub's own envelope
  } catch {
    return {};
  }
}

const rawClient = createHubClient({ token: hubToken });

/** `POST /rpc/<cmd>` with this tab's token. */
async function hubRequest(cmd: string, args?: Record<string, unknown>): Promise<HubResponse> {
  const sent = hubToken();
  // A refused token stays refused until a new one arrives (a pasted launch URL, captured just above): asking the hub
  // again only fills its audit log with refused sign-ins. The restart banner is already up.
  if (heldTokenRefused) return encodeError({ message: HUB_TOKEN_REJECTED, kind: 'bad-request' }, 401);
  let response = await rawClient.request(cmd, args);
  // The hub refused the held token while a pasted one waits (the hub restarted): take it and ask once more.
  // A call that was in flight when another one took it finds the stored token changed, and asks again too.
  if (response.status === 401 && isHubTokenRejected(response.body) && (adoptPendingToken() || hubToken() !== sent)) {
    response = await rawClient.request(cmd, args);
  }
  if (response.status >= 200 && response.status < 300) reloadAfterReconnect();
  return response;
}

/** Trade the token for the `/events` cookie; on failure the status and body, for the session to classify. */
async function openEventsSession(): Promise<{ ok: true } | { ok: false; status?: number; body?: unknown }> {
  try {
    const response = await fetch(HUB_EVENTS_SESSION_PATH, { method: 'POST', headers: { [HUB_TOKEN_HEADER]: hubToken() } });
    if (response.ok) {
      void response.body?.cancel();
      return { ok: true };
    }
    if (response.status === 401) return { ok: false, status: 401, body: await response.json().catch(() => ({})) }; // an unreadable body is not the hub's own envelope
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, status: response.status };
  } catch {
    return { ok: false };
  }
}

/** The events the UI listens to by name: an `EventSource` needs each registered (`stream-reset` apart). */
const STREAM_EVENTS = ['vanguard:changed', 'api:event', 'vanguard:clone-progress', 'spawn:output', 'spawn:exit'];
const EVENT_SOURCE_CLOSED = 2;

/**
 * The stream adapter of a browser: an `EventSource('/events')` authenticated by the cookie `POST /events/session`
 * sets (so the token never goes into the URL). The browser retries a dropped connection itself; each re-open is
 * reported as `onOpen` and the session turns it into a catch-up. It gives up for good (CLOSED) on a 401 or a
 * failed handshake, which is probed (`probeEvents`) because `EventSource` never says why; the session then
 * classifies the status and retries with backoff.
 */
const eventSourceStream: StreamAdapter = (handlers) => {
  let closed = false;
  let source: EventSource | undefined;
  const failed = (status?: number, body?: unknown): void => {
    if (!closed) handlers.onError?.(status === undefined ? 'event stream failed' : `request failed with status ${status}`, { ...(status !== undefined ? { status } : {}), ...(body !== undefined ? { body } : {}) });
  };
  void (async () => {
    if (heldTokenRefused) return failed(401, encodeError({ message: HUB_TOKEN_REJECTED, kind: 'bad-request' }, 401).body);
    hubToken(); // takes a pasted launch URL
    let outcome = await openEventsSession();
    // As for an RPC: a refused token with a pasted one waiting is retried once with that one.
    if (!outcome.ok && isHubTokenRejected(outcome.body) && adoptPendingToken()) outcome = await openEventsSession();
    if (closed) return;
    if (!outcome.ok) return failed(outcome.status, outcome.body);
    const es = new EventSource('/events');
    source = es;
    es.addEventListener('open', () => handlers.onOpen?.());
    es.addEventListener(STREAM_RESET_EVENT, () => handlers.onReset?.());
    for (const name of STREAM_EVENTS) {
      es.addEventListener(name, (ev) => {
        const decoded = decodeEvent(name, (ev as MessageEvent).data);
        if (!decoded.reset) handlers.onEvent(name, decoded.payload);
      });
    }
    es.addEventListener('error', () => {
      if (es.readyState !== EVENT_SOURCE_CLOSED) return;
      void probeEvents().then(({ status, body }) => failed(status, body));
    });
  })();
  return Object.defineProperty(
    () => {
      closed = true;
      source?.close();
    },
    'lastEventId',
    { get: () => undefined },
  ) as HubSubscription;
};

/** Answers every command from the in-browser fixtures (dev/mockBackend.ts) and has no event stream. */
function fixtureClient(demo: boolean): Pick<HubClient, 'request' | 'subscribe'> {
  return {
    request: async (cmd, args) => {
      const { handle, handleDemo } = await import('./dev/mockBackend');
      try {
        return { status: 200, body: encodeResult(await (demo ? handleDemo(cmd, args) : handle(cmd, args))) };
      } catch (err) {
        return encodeError({ message: err instanceof Error ? err.message : String(err), kind: 'bad-request' });
      }
    },
    subscribe: () => Object.assign(() => {}, { lastEventId: undefined }),
  };
}

function createSession(mode: 'hub' | 'demo' | 'mock'): HubSession {
  return createHubSession({
    client: mode === 'hub' ? { request: hubRequest, subscribe: eventSourceStream } : fixtureClient(mode === 'demo'),
    onRefused: (reason) => (reason === 'sign-in-required' ? redirectToSignIn() : notifyHubRestarted()),
    onConnectionIssue: notifyHubConnectionIssue,
  });
}

let current: { mode: 'hub' | 'demo' | 'mock'; session: HubSession } | undefined;

/** The page's one hub session: the shared stream, typed `call`, live reads and the refusal signals. In demo mode and
 *  the dev server's mock it is the same session over the fixture adapter (no hub, no stream). */
export function hub(): HubSession {
  const mode = isDemoMode() ? 'demo' : isMockMode() ? 'mock' : 'hub';
  if (current?.mode !== mode) {
    current?.session.close();
    current = { mode, session: createSession(mode) };
  }
  return current.session;
}

/** Listen to one named event of the shared stream. */
export function subscribe<T>(name: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  const stop = hub().subscribe({ onEvent: (n, payload) => n === name && handler({ payload: payload as T }) });
  return Promise.resolve(() => stop());
}
