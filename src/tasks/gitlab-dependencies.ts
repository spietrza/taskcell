import { hasLabel, withoutLabel } from '../core/labels.js';
import { failureReason } from '../core/errors.js';
import { GITLAB_WAITING_LABEL } from '../gitlab-labels.js';
import { dedupeRefs, escalatesToNeedsInfo, evaluateDependencies, invalidStart, isSilentError, lookupFailed, parseStartDate, postUnlessRepeated, readWithRetry, runDependencyGate, waitingClause } from './dependency-gate.js';
import { directiveLines, refText } from './dependencies.js';
import { commentGitlabIssue, defaultGlabRunner, editGitlabLabels, encodeProject, glabUser, neutralizeQuickActions } from './gitlab.js';
import type { DependencyVerdict, StartDate, WalkAdapter } from './dependency-gate.js';
import type { GitLabNote, GlabRunner } from './gitlab.js';
import type { Task, TaskRef } from './fetcher.js';

/** `group[/subgroup]/project` with real name characters; rejects `..`-style segments before they reach an API path. */
const validProject = (project: string): boolean => /^[\w.-]+(?:\/[\w.-]+)+$/.test(project) && project.split('/').every((part) => !/^\.+$/.test(part));

/** `#N`, `group/project#N` or an issue URL. The `!N` and merge-request URL forms match only so they can be refused. */
const REF_TOKEN = /^(?:([\w.-]+(?:\/[\w.-]+)+)?([#!])(\d+)|https?:\/\/([\w.-]+(?::\d+)?)\/([\w.-]+(?:\/[\w.-]+)+?)\/(?:-\/)?(issues|merge_requests)\/(\d+)\/?)[.,;]*$/i;

interface Declared {
  refs: TaskRef[];
  /** References that can never be a dependency (a merge request, an issue on another instance). */
  problems: string[];
}

/**
 * `Depends on` lines (lists separated by commas, spaces or "and"). Reading a line stops at the first
 * token that is no reference at all (prose); a merge request or an issue URL of another host (`host`,
 * when known) is reported and the rest of the line is still read.
 */
function parseDirectives(project: string, body: string, host?: string): Declared {
  const declared: Declared = { refs: [], problems: [] };
  for (const line of directiveLines(body)) {
    const match = /^(?:[-*]\s+)?[*_]*depends\s+on[*_:]*\s+(.+)$/i.exec(line);
    if (match === null) continue;
    for (const token of match[1]!.split(/[\s,]+/).filter((t) => t !== '')) {
      if (/^(and|&)$/i.test(token)) continue;
      const m = REF_TOKEN.exec(token);
      if (m === null) break;
      const text = token.replace(/[.,;]+$/, '');
      if (m[2] === '!' || m[6]?.toLowerCase() === 'merge_requests') {
        declared.problems.push(`merge requests cannot be dependencies (${text}); name an issue instead`);
      } else if (m[4] !== undefined && host !== undefined && m[4].toLowerCase() !== host) {
        declared.problems.push(`${text} is on another GitLab instance`);
      } else {
        const target = m[1] ?? m[5] ?? project;
        if (validProject(target)) declared.refs.push({ repo: target, number: Number(m[3] ?? m[7]) });
      }
    }
  }
  return declared;
}

/** The issue references of `Depends on` lines: `#N`, `group/project#N` or an issue URL (of `host`, when given). */
export function parseGitlabBodyDependencies(project: string, body: string, host?: string): TaskRef[] {
  return parseDirectives(project, body, host).refs;
}

interface GitlabDepIssue {
  state?: string;
  moved_to_id?: number | null;
  duplicated_to_id?: number | null;
}
interface GitlabLink {
  iid: number;
  link_type?: string;
  references?: { full?: string };
}

const api = (ref: TaskRef, suffix = ''): string => `projects/${encodeProject(ref.repo)}/issues/${ref.number}${suffix}`;
const selfRef = (project: string, task: Task): TaskRef => ({ repo: project, number: Number(task.ref ?? task.id.slice(task.id.indexOf('#') + 1)) });

/**
 * The HTTP status glab reports (`... (HTTP 404)`), if any. Read from stderr when the runner gives one:
 * the error message also carries the command line, where an issue number or a path can hold any digits.
 */
const httpStatus = (error: unknown): number | undefined => {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const match = /\bHTTP (\d{3})\b/.exec(typeof stderr === 'string' ? stderr : failureReason(error));
  return match === null ? undefined : Number(match[1]);
};

/** Retries a glab read with backoff: one transient 5xx must not hold an issue. A 4xx is final. */
const read = (glab: GlabRunner, args: string[]): Promise<string> =>
  readWithRetry(() => glab(args), (error) => {
    const status = httpStatus(error);
    return status !== undefined && status >= 400 && status < 500;
  });

async function getIssue(ref: TaskRef, glab: GlabRunner): Promise<GitlabDepIssue | 'missing'> {
  try {
    return JSON.parse(await read(glab, ['api', api(ref)])) as GitlabDepIssue;
  } catch (error) {
    if (httpStatus(error) === 404) return 'missing';
    throw error;
  }
}

/** Linked issues of type "is blocked by", each resolved against the project it lives in. */
async function nativeBlockers(ref: TaskRef, glab: GlabRunner): Promise<TaskRef[]> {
  let out: string;
  try {
    out = await read(glab, ['api', api(ref, '/links')]);
  } catch (error) {
    if (httpStatus(error) === 404) return []; // links unavailable: body lines are the fallback
    throw error;
  }
  const parsed: unknown = out.trim() === '' ? [] : JSON.parse(out);
  const links = (Array.isArray(parsed) ? parsed : []) as GitlabLink[];
  return links
    .filter((link) => link.link_type === 'is_blocked_by')
    .map((link) => {
      const project = /^(.+)#\d+$/.exec(link.references?.full ?? '')?.[1];
      if (project === undefined || !validProject(project)) throw new Error(`blocked-by #${link.iid} of ${refText(ref)} names no project`);
      return { repo: project, number: link.iid };
    });
}

export type GitlabDependencyVerdict = DependencyVerdict;

/** The GitLab side of the shared walk: reads issues and "is blocked by" links through `glab`. */
const gitlabAdapter = (self: TaskRef, glab: GlabRunner): WalkAdapter<GitlabDepIssue> => ({
  text: refText,
  async fetch(dep, referencedBy) {
    const issue = await getIssue(dep, glab);
    if (issue !== 'missing') return { issue };
    // A 404 in another project may just be a token that cannot read it: say so instead of "does not exist".
    if (dep.repo.toLowerCase() !== self.repo.toLowerCase()) return { problem: `${refText(dep)} was not found or is not readable with this token (referenced by ${refText(referencedBy)})` };
    return { problem: `${refText(dep)} does not exist (referenced by ${refText(referencedBy)})` };
  },
  finished: (issue) => issue.state?.toLowerCase() === 'closed',
  blockers: (ref) => nativeBlockers(ref, glab),
  judge(issue, ref) {
    if (issue.state?.toLowerCase() !== 'closed') return 'open';
    if (issue.moved_to_id != null || issue.duplicated_to_id != null) {
      return { invalid: `${refText(ref)} was closed without being completed (${issue.moved_to_id != null ? 'moved' : 'duplicate'})` };
    }
    return 'met';
  },
});

/** The issue's own start date (`start_date`, where the API returns one), else the `Start:` line; both validated the same way. */
function startDate(task: Task): StartDate | undefined {
  return (task.startDate !== undefined ? parseStartDate(`Start: ${task.startDate.slice(0, 10)}`) : undefined) ?? parseStartDate(task.description);
}

/**
 * Whether `task` (a GitLab issue of `project`) may start. A dependency is met when closed; one that
 * was moved or closed as a duplicate can never be met and is `invalid`, as is a merge request. Uses
 * `task.dependsOn` when already filled, else "is blocked by" links plus body lines.
 */
export async function checkGitlabDependencies(project: string, task: Task, glab: GlabRunner = defaultGlabRunner, now: Date = new Date()): Promise<GitlabDependencyVerdict> {
  const self = selfRef(project, task);
  try {
    const declared = parseDirectives(project, task.description, task.url !== undefined && URL.canParse(task.url) ? new URL(task.url).host : undefined);
    if (declared.problems.length > 0) return { status: 'invalid', reason: declared.problems.join('; ') };
    const start = startDate(task);
    const bad = invalidStart(start);
    if (bad !== undefined) return bad;
    const adapter = gitlabAdapter(self, glab);
    const direct = task.dependsOn ?? dedupeRefs(adapter, [...(await nativeBlockers(self, glab)), ...declared.refs]);
    return await evaluateDependencies(adapter, { self, direct, start, now });
  } catch (error) {
    return lookupFailed(error);
  }
}

export interface GitlabDependencyGateOptions {
  project: string;
  /** The trigger label; kept while the issue waits (the next poll re-checks it), removed on needs-info. */
  trigger: string;
  needsInfoLabel?: string;
  glab?: GlabRunner;
  now?: Date;
  log?: (line: string) => void;
}

/** Text the issue author or a CLI controls, as inline code without `@`: it can neither mention anyone nor render markup. */
const quoted = (text: string): string => `\`${text.replace(/[\`@]/g, '').replace(/\s+/g, ' ').trim()}\``;

/** The newest note by the user glab runs as, '' when there is none (a marker is plain text anyone can paste). */
async function newestOwnNote(project: string, task: Task, glab: GlabRunner): Promise<string> {
  const notes = JSON.parse(await glab(['api', api(selfRef(project, task), '/notes?sort=desc&order_by=created_at&per_page=100')])) as GitLabNote[];
  const own = notes.filter((note) => !note.system);
  if (own.length === 0) return '';
  const me = (await glabUser(glab)).toLowerCase();
  return own.find((note) => note.author.username.toLowerCase() === me)?.body.trim() ?? '';
}

/**
 * Keeps GitLab issues with unmet dependencies (or a future start date) from starting. A waiting issue
 * keeps its trigger label, gains `taskcell::waiting` and one note (not repeated while the label is
 * present or when the newest note by the bot already says the same), and starts on the first poll
 * after the blockers close, with no human step. A failed lookup is held the same way with its reason
 * and checked again on every poll, however often it fails; only a real invalid dependency (a cycle, a
 * missing or unreadable reference, a merge request, a blocker moved or closed as a duplicate, a bad
 * date) goes to needs-info. An issue that declares nothing and whose links cannot be read is neither
 * held nor commented on: it stays triggered for the next poll. `taskcell::waiting` is a scoped label,
 * so a trigger label in the same scope would be removed by adding it: such an issue is held by the note alone.
 */
export async function applyGitlabDependencyGate(tasks: Task[], opts: GitlabDependencyGateOptions): Promise<Task[]> {
  const glab = opts.glab ?? defaultGlabRunner;
  const log = opts.log ?? console.log;
  const scopedTrigger = /^(?:taskcell|vanguard)::/i.test(opts.trigger);
  return runDependencyGate(tasks, {
    check: (task) => checkGitlabDependencies(opts.project, task, glab, opts.now),
    async release(task, verdict) {
      const waitingBefore = hasLabel(task.labels, GITLAB_WAITING_LABEL);
      if (waitingBefore) await editGitlabLabels(opts.project, task.id, { remove: [GITLAB_WAITING_LABEL] }, glab).catch(() => undefined);
      return { ...task, dependsOn: verdict.dependsOn, labels: withoutLabel(task.labels, GITLAB_WAITING_LABEL) };
    },
    async hold(task, verdict) {
      if (verdict.status === 'ready') return;
      const waitingBefore = hasLabel(task.labels, GITLAB_WAITING_LABEL);
      if (isSilentError(verdict, parseGitlabBodyDependencies(opts.project, task.description).length > 0 || startDate(task) !== undefined)) {
        // Only the links read failed and the issue declares nothing: do not hold (or comment on) an issue
        // that most likely has no dependencies; it stays triggered for the next poll.
        log(`taskcell: ${task.id} skipped this poll -> ${verdict.reason}`);
        return;
      }
      if (verdict.status === 'waiting' && waitingBefore) {
        log(`taskcell: ${task.id} skipped -> ${verdict.reason}`);
        return;
      }
      try {
        const newest = await newestOwnNote(opts.project, task, glab);
        log(`taskcell: ${task.id} skipped -> ${escalatesToNeedsInfo(verdict) ? 'needs info: ' : ''}${verdict.reason}`);
        // Note first: if it fails nothing has moved and the next poll retries. A body identical to the
        // newest note by the bot is not posted again (a label edit that failed last poll).
        const hold = async (body: string, labels: { add?: string[]; remove?: string[] }): Promise<void> => {
          await postUnlessRepeated(body, newest, (published) => neutralizeQuickActions(published).trim(), (text) => commentGitlabIssue(opts.project, task.id, text, glab));
          await editGitlabLabels(opts.project, task.id, labels, glab);
        };
        if (verdict.status === 'invalid') {
          await hold(`Taskcell cannot start this issue: ${quoted(verdict.reason)}. Fix it and re-apply \`${opts.trigger}\`.`, {
            remove: [opts.trigger, GITLAB_WAITING_LABEL],
            ...(opts.needsInfoLabel !== undefined ? { add: [opts.needsInfoLabel] } : {}),
          });
          return;
        }
        // Created before the note: `glab issue update --label` silently skips a label the project lacks.
        if (!scopedTrigger) await glab(['label', 'create', '--repo', opts.project, '--name', GITLAB_WAITING_LABEL]).catch(() => undefined);
        const held = scopedTrigger ? `It keeps \`${opts.trigger}\`` : `It is labelled \`${GITLAB_WAITING_LABEL}\``;
        await hold(
          verdict.status === 'error'
            ? `Taskcell could not check this issue's dependencies: ${quoted(verdict.reason)}. ${held} and is checked again on every poll until the check succeeds.`
            : `Taskcell will not start this issue yet: it ${waitingClause(verdict, refText)}. ${held} and starts on a later poll once that is resolved.`,
          scopedTrigger ? {} : { add: [GITLAB_WAITING_LABEL] },
        );
      } catch (error) {
        log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
      }
    },
  });
}
