import { labelForms } from '../core/labels.js';
import { failureReason } from '../core/errors.js';
import { UsageCapError } from '../core/usage-cap.js';
import { failureOrCapComment } from './watch-shared.js';
import { classifyAuthor } from '../tasks/comment-trust.js';
import { incompleteCapState, reviewWatchLoop, reviewWatchOnce } from './review-watch.js';
import type { ReviewWatchLoopOptions, ReviewWatchOnceOptions, ReviewWatchPrimitives, ReviewWatchTick } from './review-watch.js';
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

export type MergeRequestWatchPrimitives = ReviewWatchPrimitives<MergeRequestWatchItem>;
export type MergeRequestWatchTick = ReviewWatchTick;
export type WatchMergeRequestsOnceOptions = ReviewWatchOnceOptions;
export type WatchMergeRequestsLoopOptions = ReviewWatchLoopOptions;

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
): Promise<{ attempts: number; capPosted: boolean; stop: boolean }> {
  const self = await glabUser(glab);
  const bodies: string[] = [];
  for (let page = 1; page <= NOTE_PAGES; page++) {
    const out = await glab([
      'api',
      `projects/${encodeProject(item.project)}/merge_requests/${item.iid}/notes?per_page=${NOTES_PER_PAGE}&page=${page}&sort=desc&order_by=created_at`,
    ]);
    const notes = JSON.parse(out) as GlabMrNoteItem[];
    if (!Array.isArray(notes)) throw new Error('the response is not a list of notes');
    // GitLab notes carry no association: the one trusted author is the glab user (Taskcell's own notes).
    for (const note of notes) {
      if (note.system || note.body === undefined || note.body === null) continue;
      if (classifyAuthor(note.author?.username ?? '', undefined, { botLogins: [self] }) === 'untrusted') continue;
      bodies.push(note.body);
    }
    if (notes.length < NOTES_PER_PAGE) break;
  }
  // The failure note that carries this attempt's marker is posted after this check: count it.
  return incompleteCapState(bodies, item.sha, hasMergeRequestReviewIncompleteMarker, MR_INCOMPLETE_CAP_MARKER_RE, 1);
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
          // Opened is glab's default; `--state` is not a `glab mr list` flag (the CI template's glab rejects it).
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
      // Without a count (no head SHA, or the notes or the user cannot be read) the cap does not apply on this sweep.
      let terminal = false;
      let capDue = false;
      if (incomplete && item.sha !== '') {
        try {
          const state = await incompleteReviewAttempts(glab, item);
          terminal = state.stop;
          capDue = terminal && !state.capPosted;
        } catch (countError) {
          log?.(`watch-mrs ${mrId(item)}: incomplete-attempt count failed -> retrying (${failureReason(countError)})`);
        }
      }
      const retryInstruction = terminal
        ? ` Re-add the "${opts.label}" label to re-trigger the review.`
        : '';
      // A usage-cap pause is not a failure and a re-poll would hit the cap again: one pause note, no re-queue (re-label after the reset).
      const capPause = error instanceof UsageCapError;
      if (capPause) terminal = true;
      const incompleteMarker = incomplete && item.sha !== '' ? `\n\n${mergeRequestReviewIncompleteMarker(item.sha)}` : '';
      // Once the cap note exists, a further incomplete attempt still gets its failure note, without a second cap marker.
      const capMarker = capDue ? `\n<!-- taskcell-mr-review-incomplete-cap: ${item.sha} -->` : '';
      try {
        await glab([
          'mr', 'note',
          String(item.iid),
          '--repo', item.project,
          // This note is written by the glab user, so a marker quoted in the error would count for the dedupe.
          '-m', neutralizeQuickActions(capPause
            ? failureOrCapComment('Taskcell MR review', error)
            : `Taskcell MR review failed: ${redactForPublish(stripReviewMarkers(String(error)))}${retryInstruction}${incompleteMarker}${capMarker}`),
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

/** Run one MR-watch poll: list, claim, review, and mark each ready MR. */
export function watchMergeRequestsOnce(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsOnceOptions = {},
): Promise<MergeRequestWatchTick> {
  return reviewWatchOnce(primitives, mrId, { phase: 'watch-mrs', ...opts });
}

/** Poll GitLab MRs until stopped, running the MR review loop for each ready MR. Returns the last tick so `--once` callers can report failures truthfully. */
export function watchMergeRequests(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions = {},
): Promise<MergeRequestWatchTick | undefined> {
  return reviewWatchLoop(primitives, mrId, { phase: 'watch-mrs', ...opts });
}
