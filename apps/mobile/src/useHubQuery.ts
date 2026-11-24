import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubClient } from '../../../packages/hub-client/src/client';
import type { LiveRead } from '../../../packages/hub-client/src/session';
import { useHub } from './hubContext';

export type HubQuery<T extends object> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  // `error`: the last background reload failed; the rest is the last good read.
  | ({ status: 'ready'; error: string | null } & T);

/**
 * Read from the hub with the session's live read: again on `vanguard:changed`, a stream reset and a catch-up after a
 * reconnect, coalesced (`reload()` waits for the trailing read). Starts over (loading) when the session's client changes.
 */
export function useHubQuery<T extends object>(read: (client: HubClient) => Promise<T>): { state: HubQuery<T>; reload: () => Promise<void> } {
  const { client } = useHub();
  const [state, setState] = useState<HubQuery<T>>({ status: 'loading' });
  const readRef = useRef(read);
  readRef.current = read;
  const live = useRef<LiveRead | null>(null);

  const reload = useCallback((): Promise<void> => live.current?.reload() ?? Promise.resolve(), []);

  useEffect(() => {
    setState({ status: 'loading' });
    const mine = client.liveRead(() => readRef.current(client), {
      onData: (data) => setState({ status: 'ready', error: null, ...data }),
      // Keep a good read; only the first load has nothing to keep.
      onError: (error) => setState((prev) => (prev.status === 'ready' ? { ...prev, error } : { status: 'error', error })),
    });
    live.current = mine;
    return () => {
      mine.stop();
      if (live.current === mine) live.current = null;
    };
  }, [client]);

  return { state, reload };
}
