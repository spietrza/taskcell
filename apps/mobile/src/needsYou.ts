import { createHubClient } from '../../../packages/hub-client/src/client';
import { AppState } from 'react-native';
import type { NeedsYouItem, RepoReadFailure, RepoStamp } from '../../../packages/hub-client/src/wire';
import { withOrigin } from './connect';
import type { Credentials } from './credentials';

export type WaitingItem = NeedsYouItem & Partial<RepoStamp>;

export interface Row {
  id: string;
  /** What the item is, as the desktop Home captions it. */
  kind: string;
  title: string;
  repo: string;
  /** "3h ago"; '' when the hub gave no time. */
  age: string;
  /** The PR/issue page, or null when it has none (a hub-board card). */
  url: string | null;
  /** True for a state that is broken, not just waiting (shown in red). */
  alert: boolean;
}

export const kindLabel = (item: NeedsYouItem): string => {
  if (item.reason === 'changes requested') return 'Changes requested';
  if (item.reason.includes('verify-failed')) return 'Verify failed';
  if (item.kind === 'pr') return 'PR ready';
  return item.ask === 'too-vague' ? 'Too vague' : 'Question';
};

const parseTime = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

export function ageOf(iso: string | undefined, now: number): string {
  const ms = parseTime(iso);
  if (ms === -Infinity) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Hub items → rows, newest first (items with no time last, in the hub's order). */
export function toRows(items: readonly WaitingItem[], now: number = Date.now()): Row[] {
  return items
    .map((item, i) => ({ item, i, t: parseTime(item.updatedAt) }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t - a.t))
    .map(({ item }) => {
      const kind = kindLabel(item);
      return {
        id: `${item.repoPath ?? ''}|${item.id}`,
        kind,
        title: item.title,
        repo: item.repoSlug || item.repoName || '',
        age: ageOf(item.updatedAt, now),
        url: /^https:\/\//.test(item.url) ? item.url : null,
        alert: kind === 'Verify failed',
      };
    });
}

const hubClient = (c: Credentials, fetchImpl?: typeof fetch): ReturnType<typeof createHubClient> =>
  createHubClient({ baseUrl: c.url, token: c.token, fetch: withOrigin(c.url, fetchImpl) });

/** The same hub call the desktop Home makes: the waiting items of every repository, and the repositories that could not be read. */
export async function loadWaiting(c: Credentials, fetchImpl?: typeof fetch): Promise<{ items: WaitingItem[]; failures: RepoReadFailure[] }> {
  const { items, failures } = await hubClient(c, fetchImpl).call('list_needs_you_all');
  return { items, failures: failures ?? [] };
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * Call `onChange` on `vanguard:changed` (the desktop Home's trigger) and after a reset — not on every
 * `/events` frame, which a busy run floods. A failed or closed stream reconnects with backoff, and when the app
 * returns to the foreground; each reconnect calls `onChange` once to catch up. Returns a function that closes it.
 */
export function watchHub(c: Credentials, onChange: () => void, fetchImpl?: typeof fetch): () => void {
  const client = hubClient(c, fetchImpl);
  let stopped = false;
  let close: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MIN_MS;

  const open = (): void => {
    close = client.subscribe({
      onEvent: (name) => {
        delay = RECONNECT_MIN_MS;
        if (name === 'vanguard:changed') onChange();
      },
      onReset: () => {
        delay = RECONNECT_MIN_MS;
        onChange();
      },
      onError: () => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(reconnect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      },
    });
  };
  const reconnect = (): void => {
    if (stopped) return;
    clearTimeout(timer);
    close?.();
    open();
    onChange();
  };

  open();
  const appState = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    delay = RECONNECT_MIN_MS;
    reconnect();
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    close?.();
    appState.remove();
  };
}
