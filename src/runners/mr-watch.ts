import { labelForms } from '../core/labels.js';
import { fanOut } from '../pipeline/fan-out.js';
import { failureReason } from '../core/errors.js';
import { defaultGlabRunner, encodeProject, glabUser, neutralizeQuickActions } from '../tasks/gitlab.js';
import {
  MergeRequestReviewIncompleteError,
  hasMergeRequestReviewForHead,
  hasMergeRequestReviewIncompleteMarker,
  mergeRequestReviewIncompleteMarker,
} from './mr-review.js';
import { stripReviewMarkers } from './review-prompt.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { MergeRequestReviewTarget } from './mr-review.js';
import { redactForPublish } from '../core/secret-scan.js';

export interface MergeRequestWatchItem extends MergeRequestReviewTarget {
  title: string;
  draft: boolean;
  author: string;
  sha: string;
  labels: string[];
}

export interface MergeRequestWatchPrimitives {
  listReady: () => Promise<MergeRequestWatchItem[]>;
  claim: (item: MergeRequestWatchItem) => Promise<void>;
  review: (item: MergeRequestWatchItem) => Promise<void>;
  markReviewed: (item: MergeRequestWatchItem) => Promise<void>;
  onFailure: (item: MergeRequestWatchItem, error: unknown) => Promise<void>;
}

export interface MergeRequestWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface WatchMergeRequestsOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface WatchMergeRequestsLoopOptions extends WatchMergeRequestsOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

export interface GitLabMergeRequestWatchOptions {
  project: string;
  label: string;
  reviewingLabel: string;
  reviewedLabel: string;
  /** Only review MRs opened by this GitLab username (optional). */
  author?: string;
  glab?: GlabRunner;
  log?: (line: string) => void;
  reviewOne: (item: MergeRequestWatchItem) => Promise<void>;
}

interface GlabMrListItem {
  iid?: number;
  title?: string;
  draft?: boolean;
  author?: { username?: string } | null;
  sha?: string;
  labels?: string[];
}

interface GlabMrNoteItem {
  body?: string | null;
  system?: boolean;
  author?: { username?: string } | null;
}

const INCOMPLETE_RETRY_LIMIT = 3;
const NOTES_PER_PAGE = 100;
const NOTE_PAGES = 5;
const MR_INCOMPLETE_CAP_MARKER_RE = /^<!--[ \t]*taskcell-mr-review-incomplete-cap:[ \t]*([a-fA-F0-9]+)[ \t]*-->$/gm;

function mrId(item: MergeRequestWatchItem): string {
  return `${item.project}!${item.iid}`;
}

function isAutomationAuthor(username: string): boolean {
  const lower = username.toLowerCase();
  return lower.startsWith('vanguard') || lower.endsWith('[bot]') || lower === 'gitlab-ci-token';
}

function parseMrList(
  out: string,
  project: string,
  onlyAuthor?: string,
): MergeRequestWatchItem[] {
  const parsed = JSON.parse(out) as GlabMrListItem[];
  return parsed.flatMap((item) => {
    if (item.iid === undefined) return [];
    const author = item.author?.username ?? '';
    const mr: MergeRequestWatchItem = {
      project,
      iid: item.iid,
      title: item.title ?? '',
      draft: item.draft === true,
      author,
      sha: item.sha ?? '',
      labels: item.labels ?? [],
    };
    if (mr.draft) return [];
    if (isAutomationAuthor(author)) return [];
    if (onlyAuthor !== undefined && author !== onlyAuthor) return [];
    return [mr];
  });
}

function editMrLabels(
  glab: GlabRunner,
  project: string,
  iid: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['mr', 'update', String(iid), '--repo', project];
  for (const label of new Set((labels.remove ?? []).flatMap(labelForms))) args.push('--unlabel', label); // GitLab ignores an absent label
  for (const label of labels.add ?? []) args.push('--label', label);
  return glab(args);
}

async function hasExistingReviewForHead(
  glab: GlabRunner,
  item: MergeRequestWatchItem,
  log?: (line: string) => void,
): Promise<boolean> {
  if (item.sha === '') {
    // glab mr list omitted sha — dedup disabled; MR may be re-reviewed on each poll
    log?.(`watch-mrs ${mrId(item)}: sha absent, dedup disabled`);
    return false;
  }
  try {
    return await hasMergeRequestReviewForHead(item, item.sha, glab);
  } catch (err) {
    // best-effort: transient failure → re-review rather than skip
    log?.(`watch-mrs ${mrId(item)}: dedup check failed (${String(err)}), will re-review`);
    return false;
  }
}

async function incompleteReviewAttempts(
  glab: GlabRunner,
  item: MergeRequestWatchItem,
): Promise<{ attempts: number; capPosted: boolean }> {
  const self = await glabUser(glab);
  let attempts = 0;
  let capPosted = false;
  for (let page = 1; page <= NOTE_PAGES; page++) {
    const out = await glab([
      'api',
      `projects/${encodeProject(item.project)}/merge_requests/${item.iid}/notes?per_page=${NOTES_PER_PAGE}&page=${page}&sort=desc&order_by=created_at`,
    ]);
    const notes = JSON.parse(out) as GlabMrNoteItem[];
    if (!Array.isArray(notes)) throw new Error('the response is not a list of notes');
    attempts += notes.filter(
      (note) =>
        !note.system &&
        note.author?.username === self &&
        note.body !== undefined &&
        note.body !== null &&
        hasMergeRequestReviewIncompleteMarker(note.body, item.sha),
    ).length;
    capPosted ||= notes.some(
      (note) =>
        !note.system &&
        note.author?.username === self &&
        note.body !== undefined &&
        note.body !== null &&
        Array.from(note.body.matchAll(MR_INCOMPLETE_CAP_MARKER_RE)).some((match) => match[1] === item.sha),
    );
    if (notes.length < NOTES_PER_PAGE) break;
  }
  return { attempts, capPosted };
}

/**
 * GitLab-backed MR review watch primitives. Scoped labels (`taskcell::reviewing`,
 * `taskcell::reviewed`) replace each other automatically on the GitLab side.
 */
export function gitlabMergeRequestWatchPrimitives(
  opts: GitLabMergeRequestWatchOptions,
): MergeRequestWatchPrimitives {
  const glab = opts.glab ?? defaultGlabRunner;
  const log = opts.log;
  return {
    listReady: async () => {
      // A trigger label renamed from `vanguard` to `taskcell`: list under both spellings, so an MR still carrying the old one runs.
      const listed = new Map<number, MergeRequestWatchItem>();
      for (const form of labelForms(opts.label)) {
        const listArgs = [
          'mr', 'list',
          '--repo', opts.project,
          '--state', 'opened',
          '--label', form,
          '--output', 'json',
        ];
        if (opts.author !== undefined) listArgs.push('--author', opts.author);
        for (const item of parseMrList(await glab(listArgs), opts.project, opts.author)) listed.set(item.iid, item);
      }
      const candidates = [...listed.values()];
      // glab mr list may omit sha; enrich from mr view so dedup works correctly.
      const enriched = await Promise.all(
        candidates.map(async (item): Promise<MergeRequestWatchItem> => {
          if (item.sha !== '') return item;
          try {
            const view = JSON.parse(
              await glab(['mr', 'view', String(item.iid), '--repo', opts.project, '--output', 'json']),
            ) as { sha?: string };
            return { ...item, sha: view.sha ?? '' };
          } catch {
            return item;
          }
        }),
      );
      const ready = await Promise.all(
        enriched.map(async (item): Promise<MergeRequestWatchItem | undefined> =>
          (await hasExistingReviewForHead(glab, item, log)) ? undefined : item,
        ),
      );
      return ready.filter((item): item is MergeRequestWatchItem => item !== undefined);
    },
    claim: (item) =>
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.label],
        add: [opts.reviewingLabel],
      }).then(() => {}),
    review: (item) => opts.reviewOne(item),
    markReviewed: (item) =>
      // Explicitly remove reviewingLabel for robustness when non-scoped labels are configured.
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.reviewingLabel],
        add: [opts.reviewedLabel],
      }).then(() => {}),
    onFailure: async (item, error) => {
      const incomplete = error instanceof MergeRequestReviewIncompleteError;
      // Without a count (no head SHA, or the notes or the user cannot be read) the retries have no bound, so an
      // incomplete review then waits for a human to re-add the label instead of running again every poll.
      let terminal = incomplete;
      let capDue = false;
      if (incomplete && item.sha !== '') {
        try {
          const state = await incompleteReviewAttempts(glab, item);
          terminal = state.capPosted || state.attempts + 1 >= INCOMPLETE_RETRY_LIMIT;
          capDue = terminal && !state.capPosted;
        } catch (countError) {
          log?.(`watch-mrs ${mrId(item)}: incomplete-attempt count failed -> not retrying (${failureReason(countError)})`);
        }
      }
      const retryInstruction = terminal
        ? ` Re-add the "${opts.label}" label to re-trigger the review.`
        : '';
      const incompleteMarker = incomplete && item.sha !== '' ? `\n\n${mergeRequestReviewIncompleteMarker(item.sha)}` : '';
      // Once the cap note exists, a further incomplete attempt still gets its failure note, without a second cap marker.
      const capMarker = capDue ? `\n<!-- taskcell-mr-review-incomplete-cap: ${item.sha} -->` : '';
      try {
        await glab([
          'mr', 'note', 'create',
          String(item.iid),
          '--repo', item.project,
          // This note is written by the glab user, so a marker quoted in the error would count for the dedupe.
          '-m', neutralizeQuickActions(`Taskcell MR review failed: ${redactForPublish(stripReviewMarkers(String(error)))}${retryInstruction}${incompleteMarker}${capMarker}`),
        ]);
      } catch {
        // note posting is best-effort; always fix the labels
        terminal = false;
      }
      await editMrLabels(glab, item.project, item.iid, {
        remove: [opts.reviewingLabel],
        ...(terminal ? {} : { add: [opts.label] }),
      });
    },
  };
}

type MrWatchKind = 'reviewed' | 'failed' | 'skipped';

/** Run one MR-watch poll: list, claim, review, and mark each ready MR. */
export async function watchMergeRequestsOnce(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsOnceOptions = {},
): Promise<MergeRequestWatchTick> {
  const phase = opts.phase ?? 'watch-mrs';
  const ready = await primitives.listReady();
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: MrWatchKind }> => {
      const id = mrId(item);
      try {
        await primitives.claim(item);
        opts.log?.(`${phase} ${id}: claim -> reviewing`);
      } catch {
        opts.log?.(`${phase} ${id}: skipped -> already claimed`);
        return { id, kind: 'skipped' };
      }
      try {
        await primitives.review(item);
        await primitives.markReviewed(item);
        opts.log?.(`${phase} ${id}: reviewed -> marked`);
        return { id, kind: 'reviewed' };
      } catch (error) {
        try {
          await primitives.onFailure(item, error);
        } catch (restoreError) {
          opts.log?.(`${phase} ${id}: restore failed -> manual label check (${failureReason(restoreError)})`);
        }
        opts.log?.(`${phase} ${id}: failed -> retry later (${failureReason(error)})`);
        return { id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: MrWatchKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { reviewed: ids('reviewed'), failed: ids('failed'), skipped: ids('skipped') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    // Detach on the timer path too, or a long-lived signal gains one listener per tick.
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Poll GitLab MRs until stopped, running the MR review loop for each ready MR. */
export async function watchMergeRequests(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchMergeRequestsOnce(primitives, opts);
    opts.log?.(
      `watch-mrs: ${tick.reviewed.length} reviewed, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`,
    );
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}
