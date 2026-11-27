import { failureReason } from '../core/errors.js';
import { parseMarkers } from '../core/comment-ledger.js';
import { hasInFlightLabel, hasLabel, NEEDS_REVISION_LABEL } from '../core/labels.js';
import { GITLAB_RATE_LIMITED_LABEL, GITLAB_REVIEW_LABEL } from '../gitlab-labels.js';
import { defaultGlabRunner, encodeProject, glabUser } from '../tasks/gitlab.js';
import { isFactoryBranch } from '../worktree/manager.js';
import { escapeForComment } from '../approver/act.js';
import { ciLogTail } from './ci-watch.js';
import { glabNoteComment, postMergeRequestNote } from './mr-review.js';
import { ciFailedMarker, ciWatchCapMarker, conflictMarker, hasCiFailedMarker, hasConflictMarker, revisionCommits, triedLines } from './pr-feedback.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { GlabMrNoteItem, MergeRequestReviewTarget } from './mr-review.js';

/** Same caps as the GitHub watch: comments per MR before the next failing/conflicting head is left to a human. */
const MAX_CI_COMMENTS = 2;
const MAX_CONFLICT_COMMENTS = 2;
const PER_PAGE = 100;
const NOTE_PAGES = 5;

export interface MrCiWatchContext {
  project: string;
  dryRun: boolean;
  glab?: GlabRunner;
  log: (line: string) => void;
  /** Records a per-MR line (`ciFailed`, `conflicted`, `escalated`) or a failure (`failed`). */
  report: { ciFailed: string[]; conflicted: string[]; escalated: string[]; failed: string[] };
}

interface GlabMrRow {
  iid: number;
  source_branch?: string;
  sha?: string;
  target_branch?: string;
  draft?: boolean;
  labels?: string[];
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  source_project_id?: number;
  target_project_id?: number;
}

interface GlabPipeline { id: number; status?: string; sha?: string }
interface GlabJob { id: number; name?: string; web_url?: string; allow_failure?: boolean }

/** Labels that exempt an MR from the watch, in the flat form of `flat`. */
const SKIP_LABELS = [NEEDS_REVISION_LABEL, GITLAB_RATE_LIMITED_LABEL, GITLAB_REVIEW_LABEL, 'taskcell:reviewing'].map((l) => l.replace('::', ':'));

/** `taskcell::x` and `taskcell:x` are one label to the shared skip checks. */
const flat = (labels: readonly string[]): string[] => labels.map((l) => l.replace('::', ':'));

/** Bodies of Taskcell's own (glab user's) notes: only those can carry the markers this watch counts. */
async function ownBodies(glab: GlabRunner, project: string, iid: number, self: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= NOTE_PAGES; page++) {
    const notes = JSON.parse(await glab(['api', `projects/${encodeProject(project)}/merge_requests/${iid}/notes?per_page=${PER_PAGE}&page=${page}&sort=desc&order_by=created_at`])) as GlabMrNoteItem[];
    for (const note of notes) if (glabNoteComment(note, self).author === 'self') out.push(note.body ?? '');
    if (notes.length < PER_PAGE) break;
  }
  return out;
}

async function addLabel(glab: GlabRunner, project: string, iid: number, label: string): Promise<void> {
  await glab(['label', 'create', '--repo', project, '--name', label]).catch(() => undefined);
  await glab(['mr', 'update', String(iid), '--repo', project, '--label', label]);
}

/** A failed head's body: failed jobs with links and an escaped log tail (the log is agent-influenced text). */
async function failureBody(glab: GlabRunner, project: string, sha: string, jobs: GlabJob[]): Promise<string> {
  const parts = [`## CI failed on ${sha.slice(0, 7)}`, '', 'The pipeline failed on the current head:', ''];
  for (const job of jobs) parts.push(job.web_url ? `- ${escapeForComment(job.name ?? '')}: ${job.web_url}` : `- ${escapeForComment(job.name ?? '')}`);
  const logs: string[] = [];
  for (const job of jobs) {
    const tail = await glab(['api', `projects/${encodeProject(project)}/jobs/${job.id}/trace`]).then((t) => (t.trim() === '' ? undefined : ciLogTail(t)), () => undefined);
    if (tail !== undefined) logs.push(`Failed log of ${escapeForComment(job.name ?? '')}:\n\n\`\`\`\n${tail}\n\`\`\``);
  }
  return [...parts, ...(logs.length > 0 ? ['', ...logs] : []), '', ciFailedMarker(sha)].join('\n');
}

/**
 * Ask for a revision on open same-project factory MRs that conflict with their target branch or whose latest pipeline
 * on the current head failed: one comment per head, then `needs revision`; at two comments per kind, one escalation
 * comment and `taskcell::review` for a human. A conflict goes first. Comments come from the glab user, whose notes the
 * reviser trusts (`revise-pr`); notes of any other author never count toward a cap or a per-head dedupe.
 */
export async function watchMrCiFailures(ctx: MrCiWatchContext): Promise<void> {
  const { project, dryRun, log, report } = ctx;
  const glab = ctx.glab ?? defaultGlabRunner;
  const self = await glabUser(glab).catch(() => undefined);
  if (self === undefined) {
    log('watch-mrs ci-watch: skipped -> cannot read the glab user (its notes are the only ones the watch trusts)');
    return;
  }
  const rows = JSON.parse(await glab(['api', `projects/${encodeProject(project)}/merge_requests?state=opened&per_page=${PER_PAGE}`])) as GlabMrRow[];
  const mrs = rows.filter((mr) => isFactoryBranch(mr.source_branch) && mr.source_project_id === mr.target_project_id);
  for (const mr of mrs) {
    const id = `${project}!${mr.iid}`;
    const target: MergeRequestReviewTarget = { project, iid: mr.iid };
    const say = (line: string): void => log(`watch-mrs ${id}: ci-watch ${line}`);
    const labels = flat(mr.labels ?? []);
    const lower = labels.map((n) => n.toLowerCase());
    if (mr.draft === true || hasInFlightLabel(labels) || SKIP_LABELS.some((l) => hasLabel(lower, l))) continue;
    try {
      const head = mr.sha ?? '';
      if (head === '') continue;
      const bodies = await ownBodies(glab, project, mr.iid, self);
      const escalate = async (which: 'ci' | 'base', found: string[]): Promise<void> => {
        const [max, what] = which === 'ci' ? [MAX_CI_COMMENTS, 'CI-failure comments'] : [MAX_CONFLICT_COMMENTS, 'base-merge comments'];
        const line = `${id}: CI watch gave up on ${head.slice(0, 7)} (${which})`;
        if (dryRun) {
          report.escalated.push(`${line} (dry-run)`);
          return;
        }
        if (bodies.some((b) => b.includes(ciWatchCapMarker(which)))) return;
        const body = [`## CI watch stopped on ${head.slice(0, 7)}`, '', `This MR already got ${max} ${what}, so the CI watch will not ask for another revision. A human needs to take over.`, '', ...found.map((f) => `- ${f}`), '', 'What was tried:', '', ...triedLines(revisionCommits(bodies)), '', ciWatchCapMarker(which)].join('\n');
        await postMergeRequestNote(target, body, glab);
        await addLabel(glab, project, mr.iid, GITLAB_REVIEW_LABEL);
        say('commented and handed to a human (cap reached)');
        report.escalated.push(line);
      };
      // Conflict first: the revise round is merge-only. `checking` / `unchecked` leaves the conflict state unknown: CI only.
      const conflicting = mr.has_conflicts === true || mr.detailed_merge_status === 'conflict';
      if (conflicting) {
        if (bodies.filter(hasConflictMarker).length >= MAX_CONFLICT_COMMENTS) {
          say(`skip -> already ${MAX_CONFLICT_COMMENTS} conflict comments, left to a human`);
          await escalate('base', [escapeForComment(mr.target_branch ?? 'the base')]);
          continue;
        }
        const base = escapeForComment(mr.target_branch ?? 'the base');
        const line = `${id}: conflicts with ${base} on ${head.slice(0, 7)}`;
        if (dryRun) {
          report.conflicted.push(`${line} (dry-run)`);
          continue;
        }
        const marker = conflictMarker(head);
        const posted = !bodies.some((b) => parseMarkers<string>('base-conflict', b).includes(head));
        if (posted) await postMergeRequestNote(target, [`## Conflicts with ${base} on ${head.slice(0, 7)}`, '', `This branch conflicts with ${base}. Merge the base into it and resolve the conflicts.`, '', marker].join('\n'), glab);
        await addLabel(glab, project, mr.iid, NEEDS_REVISION_LABEL);
        say(`${posted ? 'commented and ' : ''}added ${NEEDS_REVISION_LABEL}`);
        if (posted) report.conflicted.push(line);
        continue;
      }
      const pipelines = JSON.parse(await glab(['api', `projects/${encodeProject(project)}/pipelines?sha=${head}&per_page=1&order_by=id&sort=desc`])) as GlabPipeline[];
      const latest = pipelines[0];
      if (latest === undefined || latest.status !== 'failed') {
        say('skip -> latest pipeline on this head has not failed');
        continue;
      }
      const jobs = (JSON.parse(await glab(['api', `projects/${encodeProject(project)}/pipelines/${latest.id}/jobs?scope[]=failed&per_page=${PER_PAGE}`])) as GlabJob[]).filter((j) => j.allow_failure !== true);
      if (bodies.filter(hasCiFailedMarker).length >= MAX_CI_COMMENTS) {
        say(`skip -> already ${MAX_CI_COMMENTS} CI-failure comments`);
        await escalate('ci', jobs.map((j) => (j.web_url ? `${escapeForComment(j.name ?? '')}: ${j.web_url}` : escapeForComment(j.name ?? ''))));
        continue;
      }
      const line = `${id}: CI failed on ${head.slice(0, 7)}`;
      if (dryRun) {
        report.ciFailed.push(`${line} (dry-run)`);
        continue;
      }
      const posted = !bodies.some((b) => parseMarkers<string>('ci-failed', b).includes(head));
      if (posted) await postMergeRequestNote(target, await failureBody(glab, project, head, jobs), glab);
      await addLabel(glab, project, mr.iid, NEEDS_REVISION_LABEL);
      say(`${posted ? 'commented and ' : ''}added ${NEEDS_REVISION_LABEL}`);
      if (posted) report.ciFailed.push(line);
    } catch (error) {
      log(`watch-mrs ${id}: ci-watch failed -> ${failureReason(error)}`);
      report.failed.push(id);
    }
  }
}
