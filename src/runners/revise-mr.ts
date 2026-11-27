import { REVIEW_TRIGGER_LABEL, labelForms } from '../core/labels.js';
import { GITLAB_GATE_CONFIG_LABEL, GITLAB_MR_REVIEWED_LABEL, GITLAB_RATE_LIMITED_LABEL, GITLAB_REVIEW_LABEL, GITLAB_REVISING_LABEL, GITLAB_SECRET_BLOCKED_LABEL } from '../gitlab-labels.js';
import { GitLabTaskFetcher, addMrFailureLabel, addMrGateLabel, defaultGlabRunner, neutralizeQuickActions } from '../tasks/gitlab.js';
import { redactForPublish } from '../core/secret-scan.js';
import { fetchMergeRequestFeedback, projectRemoteOf, replyAndResolveMrThread } from './mr-feedback.js';
import { parseMergeRequestRef, postMergeRequestNote } from './mr-review.js';
import { runReviseChange } from './revise-pr.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { MergeRequestReviewTarget } from './mr-review.js';
import type { ReviseForge, ReviseGithubPrDeps, ReviseGithubPrResult } from './revise-pr.js';

export interface ReviseMrDeps extends ReviseGithubPrDeps {
  /** GitLab project path for a bare MR iid (`--gitlab-project`). */
  project?: string;
  glab?: GlabRunner;
}

/** `glab mr update`: GitLab ignores an absent label on `--unlabel`; a label is created first when `ensure` names it. */
async function updateMr(glab: GlabRunner, t: MergeRequestReviewTarget, extra: string[]): Promise<void> {
  if (extra.length > 0) await glab(['mr', 'update', String(t.iid), '--repo', t.project, ...extra]);
}

/** The GitLab side of a revision round. Scoped `taskcell::*` labels replace each other, so the hand-back also lands the state. */
export function gitlabForge(target: MergeRequestReviewTarget, glab: GlabRunner = defaultGlabRunner): ReviseForge {
  const push: { host?: string; remote?: string } = {};
  return {
    kind: 'gitlab',
    id: `${target.project}!${target.iid}`,
    repoSlug: target.project,
    number: target.iid,
    labels: { revising: GITLAB_REVISING_LABEL, review: GITLAB_REVIEW_LABEL, rateLimited: GITLAB_RATE_LIMITED_LABEL, secretBlocked: GITLAB_SECRET_BLOCKED_LABEL },
    push,
    fetch: async (log) => {
      const read = await fetchMergeRequestFeedback(target, glab, log);
      // Push with GITLAB_TOKEN to the MR's own project URL: a CI checkout's origin embeds the job token, which usually may not push.
      const where = projectRemoteOf(read.pr.url);
      if (where !== undefined && (process.env['GITLAB_TOKEN'] ?? '') !== '') {
        push.host = where.host;
        push.remote = where.remote;
      }
      return read;
    },
    notice: (body) => postMergeRequestNote(target, body, glab),
    comment: (body) => postMergeRequestNote(target, body, glab),
    editLabels: async (labels) => {
      for (const label of labels.ensure ?? []) if ((labels.add ?? []).includes(label)) await glab(['label', 'create', '--repo', target.project, '--name', label]).catch(() => undefined);
      await updateMr(glab, target, [
        ...[...new Set((labels.remove ?? []).flatMap(labelForms))].flatMap((l) => ['--unlabel', l]),
        ...(labels.add ?? []).flatMap((l) => ['--label', l]),
      ]);
    },
    flagSecretBlocked: () => addMrFailureLabel(target.project, target.iid, GITLAB_SECRET_BLOCKED_LABEL, glab),
    flagGateConfig: () => addMrGateLabel(target.project, target.iid, GITLAB_GATE_CONFIG_LABEL, glab),
    markReady: async () => { await updateMr(glab, target, ['--ready']); },
    // The review watch polls by the trigger label: drop the reviewed marker and add the trigger back.
    requestReReview: async (log) => {
      try {
        await updateMr(glab, target, ['--unlabel', GITLAB_MR_REVIEWED_LABEL, '--unlabel', REVIEW_TRIGGER_LABEL]);
        await updateMr(glab, target, ['--label', REVIEW_TRIGGER_LABEL]);
        log(`revise-pr ${target.project}!${target.iid}: labels -> re-review (${REVIEW_TRIGGER_LABEL})`);
      } catch (err) {
        log(`revise-pr ${target.project}!${target.iid}: re-review label -> manual label check (${err instanceof Error ? err.message : String(err)})`);
      }
    },
    setBody: (body) => updateMr(glab, target, ['--description', neutralizeQuickActions(redactForPublish(body))]),
    replyAndResolve: (threadId, body) => replyAndResolveMrThread(target, threadId, body, glab),
    fetchTask: (taskId) => new GitLabTaskFetcher(target.project, glab).fetch(taskId),
    tokenProvider: () => async () => process.env['GITLAB_TOKEN'],
  };
}

/**
 * One revision round on a GitLab MR, with the behaviour of `runRevisePullRequest`. Trust is fail-closed: only the glab
 * user's own CI-watch notes and the logins in `feedbackAuthors` become change requests.
 */
export async function runReviseMergeRequest(ref: string, deps: ReviseMrDeps): Promise<ReviseGithubPrResult> {
  return runReviseChange(gitlabForge(parseMergeRequestRef(ref, deps.project), deps.glab ?? defaultGlabRunner), deps);
}
