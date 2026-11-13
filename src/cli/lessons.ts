import { appendLessonRecords, readLessons } from '../core/lessons.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { defaultGlabRunner, neutralizeQuickActions } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import { distilLessons, fetchMrHistory, fetchPrHistory, hasSomethingToLearn, renderLessonComment } from '../runners/pr-lesson.js';
import type { LessonModel } from '../runners/pr-lesson.js';
import { VANGUARD_BRANCH_PREFIX } from '../worktree/manager.js';

/** Cheap by default: the lesson is one short completion over text already reviewed. */
export const LESSON_MODEL_DEFAULT = 'haiku';

export type LessonsCommand =
  | {
      kind: 'lessons';
      action: 'record';
      repoPath: string;
      repoSlug: string;
      prNumber: number;
      /** repoSlug is a GitLab project path and prNumber an MR iid. */
      gitlab?: true;
      model?: string;
      feedbackAuthors?: string[];
      dryRun: boolean;
      branch?: string;
    }
  | { kind: 'lessons'; action: 'list'; repoPath: string; json: boolean; branch?: string }
  | { kind: 'lessons'; action: 'dismiss'; repoPath: string; id: string; branch?: string };

export interface LessonsDeps {
  gh?: GhRunner;
  glab?: GlabRunner;
  model?: LessonModel;
  now?: Date;
}

/** The real model: the same no-tools agent-SDK completion the desktop chat uses (subscription auth). */
async function sdkLessonModel(model: string): Promise<LessonModel> {
  const [{ runComplete }, { query }] = await Promise.all([import('../api/complete.js'), import('@anthropic-ai/claude-agent-sdk')]);
  return async ({ system, prompt }) => {
    const res = await runComplete({ system, model, messages: [{ role: 'user', content: prompt }] }, {
      query: (params) => query(params as Parameters<typeof query>[0]),
    });
    if (res.error !== undefined) throw new Error(`lesson model call failed: ${res.error.message}`);
    return res.text ?? '';
  };
}

export async function lessonsCommand(cmd: LessonsCommand, deps: LessonsDeps = {}): Promise<void> {
  const branchOpt = cmd.branch !== undefined ? { branch: cmd.branch } : {};
  if (cmd.action === 'list') {
    const lessons = await readLessons(cmd.repoPath, branchOpt);
    if (cmd.json) {
      console.log(JSON.stringify(lessons, null, 2));
      return;
    }
    if (lessons.length === 0) console.log('No lessons yet.');
    for (const l of lessons) console.log(`${l.id}  #${l.prNumber}  ${l.rule}${l.paths.length > 0 ? `  [${l.paths.join(', ')}]` : ''}`);
    return;
  }
  if (cmd.action === 'dismiss') {
    const known = await readLessons(cmd.repoPath, branchOpt);
    if (!known.some((l) => l.id === cmd.id)) throw new Error(`No live lesson with id ${cmd.id} (see \`taskcell lessons list\`).`);
    await appendLessonRecords(cmd.repoPath, [{ kind: 'dismiss', id: cmd.id, timestamp: (deps.now ?? new Date()).toISOString() }], branchOpt);
    console.log(`Dismissed lesson ${cmd.id}; it is no longer injected into runs.`);
    return;
  }

  const gh = deps.gh ?? defaultGhRunner;
  const glab = deps.glab ?? defaultGlabRunner;
  const authorOpt = cmd.feedbackAuthors !== undefined ? { allowedAuthors: cmd.feedbackAuthors } : {};
  const history =
    cmd.gitlab === true
      ? await fetchMrHistory(cmd.repoSlug, cmd.prNumber, { glab, ...authorOpt })
      : await fetchPrHistory(cmd.repoSlug, cmd.prNumber, { gh, ...authorOpt });
  // A fork or human MR's reviews quote text its author controls; only factory MRs may teach later runs.
  if ('factory' in history && !history.factory) {
    console.log(`MR !${history.number}: not a same-project ${VANGUARD_BRANCH_PREFIX}* MR, no lesson.`);
    return;
  }
  if (!hasSomethingToLearn(history)) {
    console.log(`PR #${history.number}: clean first-round merge, no lesson.`);
    return;
  }
  const model = deps.model ?? (await sdkLessonModel(cmd.model ?? LESSON_MODEL_DEFAULT));
  const lessons = await distilLessons(history, model, deps.now);
  if (lessons.length === 0) {
    console.log(`PR #${history.number}: the model found nothing worth keeping.`);
    return;
  }
  if (cmd.dryRun) {
    console.log(JSON.stringify(lessons, null, 2));
    return;
  }
  const res = await appendLessonRecords(cmd.repoPath, lessons, branchOpt);
  console.log(`PR #${history.number}: ${lessons.length} lesson(s), ${res.pushed} new on ${res.branch}.`);
  // A re-run (or a reopened-and-closed PR) must not post a second comment.
  if (!history.hasLessonComment) {
    const body = renderLessonComment(lessons);
    if (cmd.gitlab === true) await glab(['mr', 'note', 'create', String(history.number), '--repo', cmd.repoSlug, '-m', neutralizeQuickActions(body)]);
    else await gh(['pr', 'comment', String(history.number), '--repo', cmd.repoSlug, '--body', body]);
  }
}
