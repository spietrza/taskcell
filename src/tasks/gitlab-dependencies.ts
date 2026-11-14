import { hasLabel, withoutLabel } from '../core/labels.js';
import { failureReason } from '../core/errors.js';
import { fanOut } from '../pipeline/fan-out.js';
import { GITLAB_WAITING_LABEL } from '../gitlab-labels.js';
import { directiveLines, parseStartDate, refText } from './dependencies.js';
import { commentGitlabIssue, defaultGlabRunner, editGitlabLabels, encodeProject } from './gitlab.js';
import type { StartDate } from './dependencies.js';
import type { GlabRunner } from './gitlab.js';
import type { Task, TaskRef } from './fetcher.js';

const MAX_NODES = 50;
const CHECK_CONCURRENCY = 4;

/** `group[/subgroup]/project` with real name characters; rejects `..`-style segments before they reach an API path. */
const validProject = (project: string): boolean => /^[\w.-]+(?:\/[\w.-]+)+$/.test(project) && project.split('/').every((part) => !/^\.+$/.test(part));

const REF_TOKEN = /^(?:([\w.-]+(?:\/[\w.-]+)+)#(\d+)|#(\d+))[.,;]*$/;

/** `Depends on #N` / `Depends on group/project#N` lines (lists separated by commas, spaces or "and"); stops at the first non-reference token. */
export function parseGitlabBodyDependencies(project: string, body: string): TaskRef[] {
  const refs: TaskRef[] = [];
  for (const line of directiveLines(body)) {
    const match = /^(?:[-*]\s+)?[*_]*depends\s+on[*_:]*\s+(.+)$/i.exec(line);
    if (match === null) continue;
    for (const token of match[1]!.split(/[\s,]+/).filter((t) => t !== '')) {
      if (/^(and|&)$/i.test(token)) continue;
      const m = REF_TOKEN.exec(token);
      if (m === null) break;
      const target = m[1] ?? project;
      if (validProject(target)) refs.push({ repo: target, number: Number(m[2] ?? m[3]) });
    }
  }
  return refs;
}

interface GitlabDepIssue {
  state?: string;
  start_date?: string | null;
}
interface GitlabLink {
  iid: number;
  link_type?: string;
  references?: { full?: string };
}

const same = (a: TaskRef, b: TaskRef): boolean => a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
const dedupe = (refs: TaskRef[]): TaskRef[] => refs.filter((ref, i) => refs.findIndex((other) => same(other, ref)) === i);
const notFound = (error: unknown): boolean => /\b404\b/.test(failureReason(error));
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const api = (ref: TaskRef, suffix = ''): string => `projects/${encodeProject(ref.repo)}/issues/${ref.number}${suffix}`;

async function getIssue(ref: TaskRef, glab: GlabRunner): Promise<GitlabDepIssue | 'missing'> {
  try {
    return JSON.parse(await glab(['api', api(ref)])) as GitlabDepIssue;
  } catch (error) {
    if (notFound(error)) return 'missing';
    throw error;
  }
}

/** Linked issues of type "is blocked by", each resolved against the project it lives in. */
async function nativeBlockers(ref: TaskRef, glab: GlabRunner): Promise<TaskRef[]> {
  let out: string;
  try {
    out = await glab(['api', api(ref, '/links')]);
  } catch (error) {
    if (notFound(error)) return []; // links unavailable: body lines are the fallback
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

export type GitlabDependencyVerdict =
  | { status: 'ready'; dependsOn: TaskRef[] }
  | { status: 'waiting'; blockers: TaskRef[]; startsAt?: Date; reason: string }
  /** Cycle, missing reference or bad Start date: a human must fix the issue. */
  | { status: 'invalid'; reason: string }
  | { status: 'error'; reason: string };

type Walk = { problem: string } | { problem?: undefined; direct: Map<string, GitlabDepIssue> };

/** Depth-first walk; beyond the root only native links are followed (a dependency's body may be written by anyone). */
async function walk(self: TaskRef, direct: TaskRef[], glab: GlabRunner): Promise<Walk> {
  const fetched = new Map<string, GitlabDepIssue>();
  const seen = new Set<string>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<string | undefined> => {
    for (const dep of refs) {
      if (path.some((p) => same(p, dep))) return `dependency cycle: ${[...path, dep].map(refText).join(' → ')}`;
      const key = refText(dep).toLowerCase();
      if (ref !== self && seen.has(key)) continue;
      if (++visited > MAX_NODES) return `dependency chain too large (more than ${MAX_NODES} issues)`;
      const issue = fetched.get(key) ?? (await getIssue(dep, glab));
      if (issue === 'missing') {
        if (dep.repo.toLowerCase() !== self.repo.toLowerCase()) {
          throw new Error(`${refText(dep)} was not found or is not readable with this token (referenced by ${refText(ref)})`);
        }
        return `${refText(dep)} does not exist (referenced by ${refText(ref)})`;
      }
      if (ref === self) fetched.set(refText(dep), issue);
      seen.add(key);
      if (issue.state?.toLowerCase() === 'closed') continue;
      const problem = await visit(dep, await nativeBlockers(dep, glab), [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const problem = await visit(self, direct, [self]);
  return problem === undefined ? { direct: fetched } : { problem };
}

/** The issue's own start date (`start_date`, where the API returns one), else the `Start:` line. */
function startDate(issue: GitlabDepIssue, body: string): StartDate | undefined {
  const native = /^(\d{4})-(\d{2})-(\d{2})/.exec(issue.start_date ?? '');
  if (native !== null) return { date: new Date(Date.UTC(Number(native[1]), Number(native[2]) - 1, Number(native[3]))) };
  return parseStartDate(body);
}

/**
 * Whether `task` (a GitLab issue of `project`) may start. A dependency is met when closed. Uses
 * `task.dependsOn` when already filled, else "is blocked by" links plus body lines.
 */
export async function checkGitlabDependencies(project: string, task: Task, glab: GlabRunner = defaultGlabRunner, now: Date = new Date()): Promise<GitlabDependencyVerdict> {
  const self: TaskRef = { repo: project, number: Number(task.ref ?? task.id.slice(task.id.indexOf('#') + 1)) };
  try {
    const own = await getIssue(self, glab);
    const direct = task.dependsOn ?? dedupe([...(await nativeBlockers(self, glab)), ...parseGitlabBodyDependencies(project, task.description)]);
    const start = startDate(own === 'missing' ? {} : own, task.description);
    if (start !== undefined && 'invalid' in start) return { status: 'invalid', reason: start.invalid };
    const walked = await walk(self, direct, glab);
    if (walked.problem !== undefined) return { status: 'invalid', reason: walked.problem };
    const blockers = direct.filter((ref) => walked.direct.get(refText(ref))?.state?.toLowerCase() !== 'closed');
    const startsAt = start !== undefined && start.date.getTime() > now.getTime() ? start.date : undefined;
    if (blockers.length === 0 && startsAt === undefined) return { status: 'ready', dependsOn: direct };
    const parts = [
      ...(blockers.length > 0 ? [`waiting for ${blockers.map(refText).join(', ')}`] : []),
      ...(startsAt !== undefined ? [`start date ${isoDay(startsAt)}`] : []),
    ];
    return { status: 'waiting', blockers, ...(startsAt !== undefined ? { startsAt } : {}), reason: parts.join('; ') };
  } catch (error) {
    return { status: 'error', reason: `dependency lookup failed: ${failureReason(error)}` };
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

/**
 * Keeps GitLab issues with unmet dependencies (or a future start date) from starting. A waiting issue
 * keeps its trigger label, gains `taskcell::waiting` and one comment, and starts on the first poll
 * after the blockers close, with no human step. Cycles and missing references go to needs-info with
 * the reason. A failed lookup skips the issue for this poll.
 */
export async function applyGitlabDependencyGate(tasks: Task[], opts: GitlabDependencyGateOptions): Promise<Task[]> {
  const glab = opts.glab ?? defaultGlabRunner;
  const log = opts.log ?? console.log;
  const checked = await fanOut(tasks, (task) => checkGitlabDependencies(opts.project, task, glab, opts.now), { concurrency: CHECK_CONCURRENCY });
  const ready: Task[] = [];
  for (const outcome of checked) {
    const task = outcome.item;
    const verdict: GitlabDependencyVerdict = outcome.status === 'fulfilled' ? outcome.value : { status: 'error', reason: failureReason(outcome.reason) };
    const waitingBefore = hasLabel(task.labels, GITLAB_WAITING_LABEL);
    if (verdict.status === 'ready') {
      ready.push({ ...task, dependsOn: verdict.dependsOn, labels: withoutLabel(task.labels, GITLAB_WAITING_LABEL) });
      if (waitingBefore) await editGitlabLabels(opts.project, task.id, { remove: [GITLAB_WAITING_LABEL] }, glab).catch(() => undefined);
      continue;
    }
    log(`taskcell: ${task.id} skipped -> ${verdict.status === 'invalid' ? 'needs info: ' : ''}${verdict.reason}`);
    if (verdict.status === 'error') continue;
    try {
      if (verdict.status === 'invalid') {
        await commentGitlabIssue(opts.project, task.id, `Taskcell cannot start this issue: ${verdict.reason}. Fix it and re-apply \`${opts.trigger}\`.`, glab);
        await editGitlabLabels(opts.project, task.id, { remove: [opts.trigger, GITLAB_WAITING_LABEL], ...(opts.needsInfoLabel !== undefined ? { add: [opts.needsInfoLabel] } : {}) }, glab);
      } else if (!waitingBefore) {
        const what = [
          ...(verdict.blockers.length > 0 ? [`is blocked by ${verdict.blockers.map(refText).join(', ')}`] : []),
          ...(verdict.startsAt !== undefined ? [`has a start date of ${isoDay(verdict.startsAt)}`] : []),
        ].join(' and ');
        await commentGitlabIssue(opts.project, task.id, `Taskcell will not start this issue yet: it ${what}. It is labelled \`${GITLAB_WAITING_LABEL}\` and starts on a later poll once that is resolved.`, glab);
        await glab(['label', 'create', '--repo', opts.project, '--name', GITLAB_WAITING_LABEL]).catch(() => undefined);
        await editGitlabLabels(opts.project, task.id, { add: [GITLAB_WAITING_LABEL] }, glab);
      }
    } catch (error) {
      log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
    }
  }
  return ready;
}
