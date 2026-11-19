import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';

interface Session {
  /** False until the keychain has been read. */
  ready: boolean;
  credentials: Credentials | null;
  connect: (credentials: Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
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
    await clearCredentials();
    setCredentials(null);
  }, []);

  const value = useMemo(() => ({ ready, credentials, connect, disconnect }), [ready, credentials, connect, disconnect]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
