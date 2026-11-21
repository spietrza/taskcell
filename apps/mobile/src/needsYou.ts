import { createHubClient } from '../../../packages/hub-client/src/client';
import { AppState } from 'react-native';
import type { CallerCapabilities, NeedsYouItem, RepoReadFailure, RepoStamp } from '../../../packages/hub-client/src/wire';
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
  /** The hub's item, kept so the detail sheet can act on it (its `repoPath` is the hub's, never typed). */
  item: WaitingItem;
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
        item,
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

/** The hub's `merge_needs_you`; the hub gates it (checks, state, role). Rejects with the hub's message. */
export async function mergeItem(c: Credentials, item: WaitingItem, fetchImpl?: typeof fetch): Promise<void> {
  await hubClient(c, fetchImpl).call('merge_needs_you', { repoPath: item.repoPath ?? '', id: item.id });
}

/** The hub's `reply_needs_you`. Rejects with the hub's message. */
export async function replyItem(c: Credentials, item: WaitingItem, body: string, fetchImpl?: typeof fetch): Promise<void> {
  await hubClient(c, fetchImpl).call('reply_needs_you', { repoPath: item.repoPath ?? '', id: item.id, kind: item.kind, body });
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * Call `onChange` on `vanguard:changed` (the desktop Home's trigger) and after a reset — not on every
 * `/events` frame, which a busy run floods. A failed or closed stream reconnects with backoff, and when the app
 * returns to the foreground; a reconnect catches up with one `onChange` once its stream opens. A 401
 * stops retrying and calls `onRejected`. Returns a function that closes it.
 */
export function watchHub(c: Credentials, onChange: () => void, fetchImpl?: typeof fetch, onRejected?: () => void): () => void {
  const client = hubClient(c, fetchImpl);
  let stopped = false;
  let rejected = false;
  let catchUp = false; // a reconnect is waiting for its stream to open
  let close: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MIN_MS;

  /** A frame arrived, so the stream is healthy: reset the backoff and reload. */
  const frameChanged = (): void => {
    delay = RECONNECT_MIN_MS;
    onChange();
  };
  const open = (): void => {
    close = client.subscribe({
      onOpen: () => {
        // The backoff resets on a frame, not here: a hub that opens the stream then closes it keeps backing off.
        if (!catchUp) return;
        catchUp = false;
        onChange(); // a quiet hub sends no frame, so the open itself is the catch-up
      },
      onEvent: (name) => {
        delay = RECONNECT_MIN_MS;
        if (name === 'vanguard:changed') onChange();
      },
      onReset: frameChanged,
      onError: (message, detail) => {
        if (stopped) return;
        if (detail?.streamOpen) {
          // A skipped frame leaves the stream up; it may have been a `vanguard:changed`, so catch up once.
          frameChanged();
          return;
        }
        if (detail?.status === 401) {
          rejected = true;
          onRejected?.();
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(reconnect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      },
    });
  };
  const reconnect = (): void => {
    if (stopped || rejected) return;
    clearTimeout(timer);
    close?.();
    catchUp = true;
    open();
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

/** What the hub says the caller may do on one project (`caller_capabilities`); null while unread or unreadable, which leaves every action open for the hub to refuse. */
export async function loadCapabilities(c: Credentials, repoPath: string, fetchImpl?: typeof fetch): Promise<CallerCapabilities['project'] | null> {
  try {
    return (await hubClient(c, fetchImpl).call('caller_capabilities', { repoPath })).project ?? null;
  } catch {
    return null;
  }
}

/** The hub's retry for a failed or paused task: `hub_task_retry` for a hub card, `retry_paused_task` for a GitHub issue (`gh-N`). Rejects with the hub's message. */
export async function rerunTask(c: Credentials, repoPath: string, taskId: string, fetchImpl?: typeof fetch): Promise<void> {
  const client = hubClient(c, fetchImpl);
  const gh = /^gh-(\d+)$/.exec(taskId)?.[1];
  if (gh !== undefined) await client.call('retry_paused_task', { repoPath, number: Number(gh) });
  else await client.call('hub_task_retry', { repoPath, id: taskId });
}
