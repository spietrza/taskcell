import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubClient } from '../../../packages/hub-client/src/client';
import { useHub } from './hubContext';

export type HubQuery<T extends object> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  // `error`: the last background reload failed; the rest is the last good read.
  | ({ status: 'ready'; error: string | null } & T);

/**
 * Read from the hub, and again on `vanguard:changed`, a stream reset and a catch-up after a reconnect. Reads are
 * coalesced: a change arriving mid-read gives one trailing read, and `reload()` waits for it. A response for an
 * older connection is dropped. Starts over (loading) when the session's client changes.
 */
export function useHubQuery<T extends object>(read: (client: HubClient) => Promise<T>): { state: HubQuery<T>; reload: () => Promise<void> } {
  const { client } = useHub();
  const [state, setState] = useState<HubQuery<T>>({ status: 'loading' });
  const readRef = useRef(read);
  readRef.current = read;
  const busy = useRef(false);
  const again = useRef(false); // a change arrived mid-read: one trailing read
  const running = useRef<Promise<void> | null>(null); // the read in flight, trailing read included
  const generation = useRef(0); // a response for an older client/mount is dropped

  const reload = useCallback((): Promise<void> => {
    if (busy.current) {
      again.current = true;
      return running.current ?? Promise.resolve(); // the pull waits for the trailing read too
    }
    busy.current = true;
    const mine = generation.current;
    const run = (async (): Promise<void> => {
      try {
        do {
          again.current = false;
          try {
            const data = await readRef.current(client);
            if (mine !== generation.current) return;
            setState({ status: 'ready', error: null, ...data });
          } catch (err) {
            if (mine !== generation.current) return;
            // Keep a good read; only the first load has nothing to keep.
            setState((prev) => (prev.status === 'ready' ? { ...prev, error: String(err) } : { status: 'error', error: String(err) }));
          }
        } while (again.current && mine === generation.current);
      } finally {
        if (mine === generation.current) busy.current = false;
      }
    })();
    running.current = run;
    return run;
  }, [client]);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setState({ status: 'loading' });
    void reload();
    const stop = client.subscribe({
      onEvent: (name) => {
        if (name === 'vanguard:changed') void reload();
      },
      onReset: () => void reload(),
      onOpen: () => void reload(),
    });
    return () => {
      generation.current += 1;
      stop();
    };
  }, [client, reload]);

  return { state, reload };
}
