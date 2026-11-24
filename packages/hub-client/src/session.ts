// The hub session shared by the desktop UI and the mobile app: one `/events` stream shared by every subscriber,
// reconnect with backoff and a catch-up signal once it is open again, a "refused" signal (token refused /
// sign-in required), a typed `call`, and `liveRead` (a read re-run on change, reset and reconnect, coalesced).
// The stream transport is the adapter at the seam: `client.subscribe` (fetch-SSE with the token header), a
// browser `EventSource` with the cookie session, or the desktop's in-browser fixtures (no stream at all).
// Runs in React Native: no DOM, Tauri or Node imports.
import type { Commands } from './wire.js';
import { decodeResponse, isHubSignInRequired, isHubTokenRejected, STREAM_RESET_EVENT } from './hub-wire.js';
import type { CallArgs, HubClient, HubStreamHandlers, HubSubscription } from './client.js';

/** Opens one stream; the adapter at the session's seam (the same shape as `HubClient.subscribe`). */
export type StreamAdapter = (handlers: HubStreamHandlers) => HubSubscription;

/** Why the hub no longer accepts this session: its token is dead, or the server-mode login is gone. */
export type RefusedReason = 'token-refused' | 'sign-in-required';

export interface HubSessionOptions {
  /** The RPC seam (and the default stream). */
  client: Pick<HubClient, 'request' | 'subscribe'>;
  /** Overrides `client.subscribe` as the stream transport. */
  stream?: StreamAdapter;
  /** Called when the hub refuses the session; the stream is not retried (a refused call lifts it when a call succeeds again). */
  onRefused?: (reason: RefusedReason) => void;
  /** Called when the stream fails for a reason other than a refusal (it is retried with backoff). */
  onConnectionIssue?: () => void;
  /** Starts a trigger for an immediate reconnect (the app returning to the foreground); returns its stop. */
  wake?: (reconnect: () => void) => () => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface LiveReadOptions<T> {
  onData: (data: T) => void;
  /** The last read failed; keep what `onData` last delivered. */
  onError?: (error: string) => void;
  /** Skip the read at start (the caller has just made one); later triggers still read. Default true. */
  initial?: boolean;
  /** Which `vanguard:changed` payloads re-run the read; default all. */
  changed?: (payload: unknown) => boolean;
  /** Re-run every `pollMs` too, for data the hub raises no event for; `shouldPoll` gates a tick (hidden page). */
  pollMs?: number;
  shouldPoll?: () => boolean;
}

export interface LiveRead {
  /** Read now; a read in flight gets one trailing read, and the promise waits for it. */
  reload: () => Promise<void>;
  stop: () => void;
}

export interface HubSession extends HubClient {
  /** Run `read` now and again on `vanguard:changed`, a stream reset and a catch-up after a reconnect. Reads are
   *  coalesced (a trigger mid-read gives one trailing read); nothing is delivered after `stop`. */
  liveRead<T>(read: () => Promise<T>, options: LiveReadOptions<T>): LiveRead;
  /** The reason the hub refused this session (a refused call is lifted when a call is answered again). */
  readonly refused: RefusedReason | undefined;
  /** A new token is in place: lift a refusal and reopen the stream it stopped. */
  resume(): void;
  onRefused(handler: (reason: RefusedReason) => void): () => void;
  onConnectionIssue(handler: () => void): () => void;
  /** Drop every subscriber and close the stream. */
  close(): void;
}

const CHANGED_EVENT = 'vanguard:changed';

/** A stream 401: the hub's own bodies by name; no body (not read) counts as a refused token; a proxy's does not. */
function refusal(body: unknown): RefusedReason | undefined {
  if (isHubSignInRequired(body)) return 'sign-in-required';
  if (body === undefined || isHubTokenRejected(body)) return 'token-refused';
  return undefined;
}

export function createHubSession(options: HubSessionOptions): HubSession {
  const { client } = options;
  const open = options.stream ?? client.subscribe;
  const minDelay = options.minBackoffMs ?? 1000;
  const maxDelay = options.maxBackoffMs ?? 30000;
  const subs = new Set<HubStreamHandlers>();
  const refusedHandlers = new Set<(reason: RefusedReason) => void>();
  const issueHandlers = new Set<() => void>();
  if (options.onRefused) refusedHandlers.add(options.onRefused);
  if (options.onConnectionIssue) issueHandlers.add(options.onConnectionIssue);
  let stream: HubSubscription | undefined;
  let generation = 0; // a superseded stream's callbacks are ignored
  let refused: RefusedReason | undefined;
  let refusedByCall = false; // only a refused call is lifted by a later answered one; a refused stream stays stopped
  let catchUp = false; // a reconnect is waiting for its stream to open
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = minDelay;
  let unwake: (() => void) | undefined;

  const each = (f: (h: HubStreamHandlers) => void): void => [...subs].forEach(f);
  const refuse = (reason: RefusedReason, byCall = false): void => {
    const again = refused === reason; // already told: a refused tab keeps asking nothing, and says nothing twice
    refused = reason;
    refusedByCall = byCall;
    clearTimeout(timer);
    if (!again) refusedHandlers.forEach((h) => h(reason));
  };

  const openStream = (): void => {
    const mine = ++generation;
    let opened = false;
    stream = open({
      onOpen: () => {
        if (mine !== generation) return;
        // The backoff resets on a frame, not here: a hub that opens the stream then closes it keeps backing off.
        // An adapter that reconnects by itself (EventSource) opens the same stream again: that is a catch-up too.
        const again = catchUp || opened;
        opened = true;
        catchUp = false;
        if (again) each((h) => h.onOpen?.());
      },
      onEvent: (name, payload) => {
        if (mine !== generation) return;
        delay = minDelay;
        each((h) => h.onEvent(name, payload));
      },
      onReset: () => {
        if (mine !== generation) return;
        delay = minDelay;
        each((h) => h.onReset?.());
      },
      onError: (message, detail) => {
        if (mine !== generation) return;
        if (detail?.streamOpen) {
          // A skipped frame leaves the stream up; it may have been a `vanguard:changed` (or a reset, or of unknown name), so catch up once.
          delay = minDelay;
          if (!detail.event || detail.event === CHANGED_EVENT || detail.event === STREAM_RESET_EVENT) each((h) => h.onReset?.());
          return;
        }
        const reason = detail?.status === 401 ? refusal(detail.body) : undefined;
        if (reason) {
          refuse(reason);
          each((h) => h.onError?.(message, detail));
          return;
        }
        issueHandlers.forEach((h) => h());
        clearTimeout(timer);
        timer = setTimeout(reconnect, delay);
        delay = Math.min(delay * 2, maxDelay);
      },
    });
  };
  function reconnect(): void {
    if (refused || subs.size === 0) return;
    clearTimeout(timer);
    stream?.();
    catchUp = true;
    openStream();
  }
  const stop = (): void => {
    generation++;
    clearTimeout(timer);
    stream?.();
    stream = undefined;
    unwake?.();
    unwake = undefined;
    catchUp = false;
    delay = minDelay;
  };

  const subscribe = (handlers: HubStreamHandlers): HubSubscription => {
    subs.add(handlers);
    if (subs.size === 1 && !stream && !refused) {
      openStream();
      unwake = options.wake?.(() => {
        delay = minDelay;
        reconnect();
      });
    }
    return Object.defineProperty(
      () => {
        subs.delete(handlers);
        if (subs.size === 0) stop();
      },
      'lastEventId',
      { get: () => stream?.lastEventId },
    ) as HubSubscription;
  };

  const resume = (): void => {
    if (!refused) return;
    refused = undefined;
    if (subs.size > 0) reconnect();
  };

  const request: HubClient['request'] = async (cmd, args) => {
    const response = await client.request(cmd, args);
    if (response.status === 401) {
      // Only the hub's own 401 bodies mean the session is no longer valid; a reverse proxy's is a different problem.
      if (isHubTokenRejected(response.body)) refuse('token-refused', true);
      else if (isHubSignInRequired(response.body)) refuse('sign-in-required', true);
    } else if (response.status >= 200 && response.status < 300 && refused && refusedByCall) {
      // The hub accepts the session again (a new token): resume the stream the refusal stopped.
      resume();
    }
    return response;
  };

  async function call<K extends keyof Commands>(cmd: K, ...args: CallArgs<K>): Promise<Commands[K]['result']> {
    const { status, body } = await request(cmd, args[0] as Record<string, unknown> | undefined);
    return decodeResponse<Commands[K]['result']>(status, body);
  }

  function liveRead<T>(read: () => Promise<T>, o: LiveReadOptions<T>): LiveRead {
    let stopped = false;
    let busy = false;
    let again = false; // a trigger arrived mid-read: one trailing read
    let running: Promise<void> | undefined;
    const reload = (): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (busy) {
        again = true;
        return running ?? Promise.resolve(); // the pull waits for the trailing read too
      }
      busy = true;
      running = (async (): Promise<void> => {
        try {
          do {
            again = false;
            try {
              const data = await read();
              if (stopped) return;
              o.onData(data);
            } catch (err) {
              if (stopped) return;
              o.onError?.(String(err));
            }
          } while (again && !stopped);
        } finally {
          busy = false;
        }
      })();
      return running;
    };
    const sub = subscribe({
      onEvent: (name, payload) => {
        if (name === CHANGED_EVENT && (o.changed?.(payload) ?? true)) void reload();
      },
      onReset: () => void reload(),
      onOpen: () => void reload(),
    });
    const poll = o.pollMs === undefined ? undefined : setInterval(() => (o.shouldPoll?.() ?? true) && void reload(), o.pollMs);
    if (o.initial !== false) void reload();
    return {
      reload,
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(poll);
        sub();
      },
    };
  }

  return {
    request,
    call,
    subscribe,
    liveRead,
    get refused() {
      return refused;
    },
    resume,
    onRefused: (h) => {
      refusedHandlers.add(h);
      return () => void refusedHandlers.delete(h);
    },
    onConnectionIssue: (h) => {
      issueHandlers.add(h);
      return () => void issueHandlers.delete(h);
    },
    close: () => {
      subs.clear();
      stop();
    },
  };
}
