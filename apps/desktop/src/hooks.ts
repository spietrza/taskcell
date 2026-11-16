import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { callerCapabilities, readAppConfigStrict } from './ipc';
import type { CallerCapabilities, CallerCapability } from './wire';
import { errorMessage } from './errors';
import type { AppConfig } from './taskcell-output';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Run an async fn on mount and whenever deps change, with the standard alive-guard + {data,error,loading}.
 * This is the one place a failed load becomes text (`errorMessage`). `reload()` re-runs without a dep change;
 * `keepPrevious` holds the last data while a re-run is in flight instead of blanking it; a failed re-run still clears it.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts: { keepPrevious?: boolean } = {},
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ data: opts.keepPrevious ? s.data : null, error: null, loading: true }));
    fn()
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((e) => {
        if (alive) setState({ data: null, error: errorMessage(e), loading: false });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, reload };
}

/**
 * Load a project's AppConfig into editable local state; reloads when the project changes.
 * `status` (S6 guard a/b): consumers that WRITE the config (Settings) must gate Save on 'ready' —
 * a save while 'loading' would write the {} seed over the file, and 'error' means the file exists
 * but does not parse (the hub's strict read), where a save would replace the user's hand-edited JSON.
 * Read-only consumers may ignore it (they just see defaults).
 */
export function useAppConfig(
  project: string,
): [AppConfig, Dispatch<SetStateAction<AppConfig>>, 'loading' | 'ready' | 'error'] {
  const [cfg, setCfg] = useState<AppConfig>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    setStatus('loading');
    readAppConfigStrict(project)
      .then((c) => {
        if (!live) return;
        setCfg(c);
        setStatus('ready');
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, [project]);
  return [cfg, setCfg, status];
}

/** What the hub says the caller may do (`caller_capabilities`), on the hub and, with `repoPath`, on that project.
 * `null` while loading or when it cannot be read: every gate then stays open and the hub's own refusal shows. */
export function useCallerCapabilities(repoPath?: string, refetchKey?: string): CallerCapabilities | null {
  const { data } = useAsync(() => callerCapabilities(repoPath), [repoPath, refetchKey]);
  return data;
}

/** The `disabled`/`title` of a button gated on one capability: closed (with the hub's reason as the tooltip) when refused. */
export function gateProps(cap: CallerCapability | undefined): { disabled?: true; title?: string } {
  return cap === undefined || cap.allowed ? {} : { disabled: true, ...(cap.reason !== undefined ? { title: cap.reason } : {}) };
}
