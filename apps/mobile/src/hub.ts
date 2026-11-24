// The app's one hub connection per session: one client factory, one session (shared `/events` stream, backoff,
// catch-up, "rejected" signal, live reads).
import { AppState } from 'react-native';
import { createHubClient, type HubClient } from '../../../packages/hub-client/src/client';
import { createHubSession, type HubSession } from '../../../packages/hub-client/src/session';
import { withOrigin } from './connect';
import type { Credentials } from './credentials';

/** The one place a hub client is built for a session's credentials. */
export const hubClient = (c: Credentials, fetchImpl?: typeof fetch): HubClient =>
  createHubClient({ baseUrl: c.url, token: c.token, fetch: withOrigin(c.url, fetchImpl) });

export interface SessionHub {
  client: HubSession;
  close: () => void;
}

/**
 * The hub session for `c`: the shared stream reconnects with backoff, also when the app returns to the foreground,
 * and every subscriber gets `onOpen` once it is open again (a catch-up). A 401 (stream or RPC) stops retrying and
 * calls `onRejected`.
 */
export function createSessionHub(c: Credentials, fetchImpl: typeof fetch | undefined, onRejected: () => void): SessionHub {
  const client = createHubSession({
    client: hubClient(c, fetchImpl),
    onRefused: onRejected,
    wake: (reconnect) => {
      const sub = AppState.addEventListener('change', (state) => state === 'active' && reconnect());
      return () => sub.remove();
    },
  });
  return { client, close: client.close };
}
