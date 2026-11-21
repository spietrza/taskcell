import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { revokeSession } from './connect';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';
import { disablePush, enablePush, pushWanted, setPushWanted } from './push';

interface Session {
  /** False until the keychain has been read. */
  ready: boolean;
  credentials: Credentials | null;
  connect: (credentials: Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }): ReactNode {
  const [ready, setReady] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  useEffect(() => {
    void loadCredentials()
      .then(setCredentials)
      .catch(() => setCredentials(null))
      .finally(() => setReady(true));
  }, []);

  // Permission is asked once the app is connected (never at first launch), unless Notifications was switched off.
  const connectedTo = credentials ? `${credentials.url}|${credentials.token}` : null;
  useEffect(() => {
    if (!credentials) return;
    void pushWanted().then(async (wanted) => {
      if (wanted && (await enablePush(credentials, fetchImpl)) === 'denied') await setPushWanted(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedTo]);

  const connect = useCallback(async (next: Credentials): Promise<void> => {
    await saveCredentials(next);
    setCredentials(next);
  }, []);
  const disconnect = useCallback(async (): Promise<void> => {
    // The push token goes first, while the session can still name it; then sign out on the hub
    // (a member session is revoked there), then clear the keychain.
    if (credentials) {
      await disablePush(credentials, fetchImpl);
      await revokeSession(credentials, fetchImpl);
    }
    await clearCredentials();
    await setPushWanted(true);
    setCredentials(null);
  }, [credentials, fetchImpl]);

  const value = useMemo(() => ({ ready, credentials, connect, disconnect }), [ready, credentials, connect, disconnect]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
