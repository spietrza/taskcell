import { useEffect, useState } from 'react';
import { isHubMode, signOutOfHub } from './transport';

/** The GitHub login the hub signed this browser in as (src/hub/github-auth.ts), with a Sign out button.
 * Renders nothing under Tauri or when the hub runs without GitHub sign-in (`/auth/me` is not served). */
export function HubUser() {
  const [login, setLogin] = useState<string | null>(null);
  useEffect(() => {
    if (!isHubMode()) return;
    fetch('/auth/me')
      .then(async (res) => (res.ok ? ((await res.json()) as { login?: unknown }).login : null))
      .then((l) => setLogin(typeof l === 'string' ? l : null))
      .catch(() => setLogin(null));
  }, []);
  if (login === null) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{login}</span>
      <button onClick={signOutOfHub} className="rounded border border-border px-2 py-1 transition-colors hover:bg-muted">
        Sign out
      </button>
    </div>
  );
}
