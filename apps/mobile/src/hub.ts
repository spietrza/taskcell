// The app's one hub connection per session: one client factory, one shared `/events` stream, one "rejected" signal.
import { AppState } from 'react-native';
import { createHubClient, type CallArgs, type HubClient, type HubStreamHandlers, type HubSubscription } from '../../../packages/hub-client/src/client';
import { isHubSignInRequired, isHubTokenRejected } from '../../../packages/hub-client/src/hub-wire';
import type { Commands } from '../../../packages/hub-client/src/wire';
import { withOrigin } from './connect';
import type { Credentials } from './credentials';

/** The one place a hub client is built for a session's credentials. */
export const hubClient = (c: Credentials, fetchImpl?: typeof fetch): HubClient =>
  createHubClient({ baseUrl: c.url, token: c.token, fetch: withOrigin(c.url, fetchImpl) });

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export interface SessionHub {
  /** `call` reports a 401 through `onRejected`; `subscribe` shares one `/events` stream with every other subscriber. */
  client: HubClient;
  close: () => void;
}

/**
 * A hub client whose `subscribe` shares one `/events` stream (opened with the first subscriber, closed after the
 * last). A failed or closed stream reconnects with backoff, and when the app returns to the foreground; once it is
 * open again every subscriber gets `onOpen` (a catch-up: not called for the first open). A skipped frame is
 * delivered as `onReset`. A 401 (stream or RPC) stops retrying and calls `onRejected`; the stream's 401 also
 * reaches subscribers' `onError`. Other stream failures are retried, not reported.
 */
export function createSessionHub(c: Credentials, fetchImpl: typeof fetch | undefined, onRejected: () => void): SessionHub {
  const raw = hubClient(c, fetchImpl);
  const subs = new Set<HubStreamHandlers>();
  let stream: HubSubscription | undefined;
  let rejected = false;
  let catchUp = false; // a reconnect is waiting for its stream to open
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MIN_MS;
  let appState: { remove: () => void } | undefined;

  const each = (f: (h: HubStreamHandlers) => void): void => [...subs].forEach(f);
  const open = (): void => {
    stream = raw.subscribe({
      onOpen: () => {
        // The backoff resets on a frame, not here: a hub that opens the stream then closes it keeps backing off.
        if (!catchUp) return;
        catchUp = false;
        each((h) => h.onOpen?.());
      },
      onEvent: (name, payload) => {
        delay = RECONNECT_MIN_MS;
        each((h) => h.onEvent(name, payload));
      },
      onReset: () => {
        delay = RECONNECT_MIN_MS;
        each((h) => h.onReset?.());
      },
      onError: (message, detail) => {
        if (detail?.streamOpen) {
          // A skipped frame leaves the stream up; it may have been a `vanguard:changed`, so catch up once.
          delay = RECONNECT_MIN_MS;
          each((h) => h.onReset?.());
          return;
        }
        if (detail?.status === 401) {
          rejected = true;
          onRejected();
          each((h) => h.onError?.(message, detail));
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(reconnect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      },
    });
  };
  const reconnect = (): void => {
    if (rejected || subs.size === 0) return;
    clearTimeout(timer);
    stream?.();
    catchUp = true;
    open();
  };
  const stop = (): void => {
    clearTimeout(timer);
    stream?.();
    stream = undefined;
    appState?.remove();
    appState = undefined;
    catchUp = false;
    delay = RECONNECT_MIN_MS;
  };

  const subscribe = (handlers: HubStreamHandlers): HubSubscription => {
    subs.add(handlers);
    if (subs.size === 1 && !rejected) {
      open();
      appState = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        delay = RECONNECT_MIN_MS;
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

  async function call<K extends keyof Commands>(cmd: K, ...args: CallArgs<K>): Promise<Commands[K]['result']> {
    try {
      return await raw.call(cmd, ...args);
    } catch (err) {
      // `call` rejects with the hub's message; only the hub's own 401 bodies mean the session is no longer valid.
      const body = { error: { message: err } };
      if (isHubTokenRejected(body) || isHubSignInRequired(body)) {
        rejected = true;
        onRejected();
      }
      throw err;
    }
  }

  return { client: { request: raw.request, call, subscribe }, close: () => { subs.clear(); stop(); } };
}
