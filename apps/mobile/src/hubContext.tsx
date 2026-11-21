import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HubClient } from '../../../packages/hub-client/src/client';
import type { Credentials } from './credentials';
import { createSessionHub } from './hub';

/** What a screen gets from the session: the one client (and its one event stream) and the one "rejected" state. */
export interface Hub {
  credentials: Credentials;
  client: HubClient;
  /** The hub answered 401 on an RPC or on the stream: the token or session is no longer valid. */
  rejected: boolean;
}

export const HubContext = createContext<Hub | null>(null);

/** One hub connection per `credentials`; null while not connected. */
export function useHubConnection(credentials: Credentials | null, fetchImpl?: typeof fetch): Hub | null {
  const [rejected, setRejected] = useState(false);
  const conn = useMemo(() => (credentials ? createSessionHub(credentials, fetchImpl, () => setRejected(true)) : null), [credentials, fetchImpl]);
  useEffect(() => {
    setRejected(false);
    return () => conn?.close();
  }, [conn]);
  return useMemo(() => (credentials && conn ? { credentials, client: conn.client, rejected } : null), [credentials, conn, rejected]);
}

/** Provides one hub connection for `credentials` (SessionProvider does this for the signed-in session). */
export function HubProvider({ credentials, fetchImpl, children }: { credentials: Credentials; fetchImpl?: typeof fetch; children: ReactNode }): ReactNode {
  return <HubContext.Provider value={useHubConnection(credentials, fetchImpl)}>{children}</HubContext.Provider>;
}

export function useHub(): Hub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error('useHub needs a connected session');
  return hub;
}
