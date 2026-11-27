import { defaultGlabRunner, encodeProject, glabUser, neutralizeQuickActions } from '../tasks/gitlab.js';
import { redactForPublish } from '../core/secret-scan.js';
import { omitGeneratedFiles, labelNames } from './review-prompt.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { FeedbackItem, PullRequestFeedback, ReviewThread } from './pr-feedback.js';
import type { PullRequestForReview } from './pr-review.js';
import type { MergeRequestReviewTarget } from './mr-review.js';

const PER_PAGE = 100;
/** Pages of discussions read (newest data is not guaranteed first); more is logged as truncated. */
const PAGES = 5;

interface GlabMr {
  iid?: number;
  title?: string;
  description?: string | null;
  web_url?: string;
  author?: { username?: string } | null;
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  labels?: Array<string | { name?: string }> | null;
  source_project_id?: number;
  target_project_id?: number;
}

interface GlabDiscussionNote {
  body?: string | null;
  author?: { username?: string } | null;
  created_at?: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
}

interface GlabDiscussion {
  id?: string;
  individual_note?: boolean;
  notes?: GlabDiscussionNote[];
}

export const mrApiPath = (target: MergeRequestReviewTarget, rest = ''): string => `projects/${encodeProject(target.project)}/merge_requests/${target.iid}${rest}`;

/** An MR's own host as `https://host/group/project.git` (the push remote), from its web URL. */
export function projectRemoteOf(webUrl: string): { remote: string; host: string } | undefined {
  try {
    const url = new URL(webUrl);
    const at = url.pathname.indexOf('/-/merge_requests/');
    if (url.protocol !== 'https:' || at === -1) return undefined;
    return { remote: `${url.origin}${url.pathname.slice(0, at)}.git`, host: url.host };
  } catch {
    return undefined;
  }
}

/**
 * Read an MR as the reviser's PullRequestForReview plus its feedback. GitLab notes carry no association, so the
 * trust model is fail-closed: the glab user's own notes are MEMBER (they hold Taskcell's markers and the CI
 * watch's asks), every other author is `NONE`, which only `--feedback-authors` lifts.
 */
export async function fetchMergeRequestFeedback(
  target: MergeRequestReviewTarget,
  glab: GlabRunner = defaultGlabRunner,
  log?: (line: string) => void,
): Promise<{ pr: PullRequestForReview; fb: PullRequestFeedback; ownLogin: string }> {
  const iid = String(target.iid);
  const [mr, diff, self] = await Promise.all([
    glab(['api', mrApiPath(target)]).then((out) => JSON.parse(out) as GlabMr),
    glab(['mr', 'diff', iid, '--repo', target.project]),
    glabUser(glab),
  ]);
  const sha = mr.sha ?? '';
  const headCommittedDate = sha === ''
    ? ''
    : await glab(['api', `projects/${encodeProject(target.project)}/repository/commits/${sha}`])
      .then((out) => (JSON.parse(out) as { committed_date?: string }).committed_date ?? '')
      .catch(() => '');
  const owner = (name: string | undefined): string => (name !== undefined && name.toLowerCase() === self.toLowerCase() ? 'MEMBER' : 'NONE');
  const item = (note: GlabDiscussionNote, source: FeedbackItem['source'], thread?: { id: string; resolved: boolean }): FeedbackItem => ({
    source,
    ...(thread !== undefined ? { threadId: thread.id, isResolved: thread.resolved } : {}),
    author: note.author?.username ?? '',
    authorAssociation: owner(note.author?.username),
    body: note.body ?? '',
    createdAt: note.created_at ?? '',
  });
  const items: FeedbackItem[] = [];
  const threads: ReviewThread[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const discussions = JSON.parse(await glab(['api', mrApiPath(target, `/discussions?per_page=${PER_PAGE}&page=${page}`)])) as GlabDiscussion[];
    if (!Array.isArray(discussions)) throw new Error('the discussions response is not a list');
    for (const d of discussions) {
      const notes = (d.notes ?? []).filter((n) => n.system !== true);
      if (d.individual_note !== true && d.id !== undefined && notes.some((n) => n.resolvable === true)) {
        const resolved = notes.filter((n) => n.resolvable === true).every((n) => n.resolved === true);
        const threadItems = notes.map((n) => item(n, 'thread', { id: d.id!, resolved }));
        threads.push({ id: d.id, isResolved: resolved, items: threadItems });
        items.push(...threadItems);
      } else {
        items.push(...notes.map((n) => item(n, 'comment')));
      }
    }
    if (discussions.length < PER_PAGE) break;
    if (page === PAGES) log?.(`revise-mr ${target.project}!${target.iid}: discussions truncated at ${PAGES * PER_PAGE}`);
  }
  const source = mr.source_project_id;
  const pr: PullRequestForReview = {
    repoSlug: target.project,
    number: target.iid,
    title: mr.title ?? '',
    body: mr.description ?? '',
    url: mr.web_url ?? '',
    author: mr.author?.username ?? '',
    headRefName: mr.source_branch ?? '',
    headRefOid: sha,
    baseRefName: mr.target_branch ?? '',
    isCrossRepository: source !== undefined && mr.target_project_id !== undefined && source !== mr.target_project_id,
    headRepositoryOwner: '',
    diff: omitGeneratedFiles(diff),
    labels: labelNames(mr.labels),
  };
  return { pr, fb: { headRefOid: sha, headCommittedDate, isDraft: false, items, threads }, ownLogin: self };
}

/** Reply on an MR discussion, then resolve it. */
export async function replyAndResolveMrThread(
  target: MergeRequestReviewTarget,
  discussionId: string,
  body: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  const path = mrApiPath(target, `/discussions/${discussionId}`);
  await glab(['api', '--method', 'POST', `${path}/notes`, '-f', `body=${neutralizeQuickActions(redactForPublish(body))}`]);
  await glab(['api', '--method', 'PUT', path, '-f', 'resolved=true']);
}
