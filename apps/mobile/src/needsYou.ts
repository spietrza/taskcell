import type { HubClient } from '../../../packages/hub-client/src/client';
import { agoWords, needsYouAlert, needsYouCaption } from '../../../packages/hub-client/src/needs-you-caption';
import type { CallerCapabilities, NeedsYouItem, RepoReadFailure, RepoStamp } from '../../../packages/hub-client/src/wire';

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

const parseTime = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

export function ageOf(iso: string | undefined, now: number): string {
  const ms = parseTime(iso);
  return ms === -Infinity ? '' : agoWords(now - ms);
}

/** Hub items → rows, newest first (items with no time last, in the hub's order). */
export function toRows(items: readonly WaitingItem[], now: number = Date.now()): Row[] {
  return items
    .map((item, i) => ({ item, i, t: parseTime(item.updatedAt) }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t - a.t))
    .map(({ item }) => ({
      id: `${item.repoPath ?? ''}|${item.id}`,
      kind: needsYouCaption(item),
      title: item.title,
      repo: item.repoSlug || item.repoName || '',
      age: ageOf(item.updatedAt, now),
      url: /^https:\/\//.test(item.url) ? item.url : null,
      alert: needsYouAlert(item),
      item,
    }));
}

/** The same hub call the desktop Home makes: the waiting items of every repository, and the repositories that could not be read. */
export async function loadWaiting(client: HubClient): Promise<{ items: WaitingItem[]; failures: RepoReadFailure[] }> {
  const { items, failures } = await client.call('list_needs_you_all');
  return { items, failures: failures ?? [] };
}

/** The hub's `merge_needs_you`; the hub gates it (checks, state, role). Rejects with the hub's message. */
export async function mergeItem(client: HubClient, item: WaitingItem): Promise<void> {
  await client.call('merge_needs_you', { repoPath: item.repoPath ?? '', id: item.id });
}

/** The hub's `reply_needs_you`. Rejects with the hub's message. */
export async function replyItem(client: HubClient, item: WaitingItem, body: string): Promise<void> {
  await client.call('reply_needs_you', { repoPath: item.repoPath ?? '', id: item.id, kind: item.kind, body });
}

/** The hub's `rereview_pr`: puts an open factory PR back through review. Rejects with the hub's message. */
export async function rereviewItem(client: HubClient, item: WaitingItem): Promise<void> {
  await client.call('rereview_pr', { repoPath: item.repoPath ?? '', id: item.id });
}

/** What the hub says the caller may do on one project (`caller_capabilities`); null while unread or unreadable, which leaves every action open for the hub to refuse. */
export async function loadCapabilities(client: HubClient, repoPath: string): Promise<CallerCapabilities['project'] | null> {
  try {
    return (await client.call('caller_capabilities', { repoPath })).project ?? null;
  } catch {
    return null;
  }
}

/** The hub's retry for a failed or paused task: `hub_task_retry` for a hub card, `retry_paused_task` for a GitHub issue (`gh-N`). Rejects with the hub's message. */
export async function rerunTask(client: HubClient, repoPath: string, taskId: string): Promise<void> {
  const gh = /^gh-(\d+)$/.exec(taskId)?.[1];
  if (gh !== undefined) await client.call('retry_paused_task', { repoPath, number: Number(gh) });
  else await client.call('hub_task_retry', { repoPath, id: taskId });
}
