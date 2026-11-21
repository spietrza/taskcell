import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { revokeSession } from './connect';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';

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

  const connect = useCallback(async (next: Credentials): Promise<void> => {
    await saveCredentials(next);
    setCredentials(next);
  }, []);
  const disconnect = useCallback(async (): Promise<void> => {
    // Sign out on the hub first (a member session is revoked there), then clear the keychain.
    if (credentials) await revokeSession(credentials, fetchImpl);
    await clearCredentials();
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
