import { failureReason } from '../core/errors.js';
import { commentGithubIssue, defaultGhRunner, editGithubLabels } from './github.js';
import { GITHUB_WAITING_LABEL } from '../github-labels.js';
import type { GhRunner } from './github.js';
import type { Task, TaskRef } from './fetcher.js';

const MAX_NODES = 50;
const LOOKUP_ATTEMPTS = 3;

export const refText = (ref: TaskRef): string => `${ref.repo}#${ref.number}`;

/** owner/name with real name characters; rejects `..`-style segments before they reach an API path. */
const validRepo = (repo: string): boolean => /^[\w.-]+\/[\w.-]+$/.test(repo) && repo.split('/').every((part) => !/^\.+$/.test(part));

const REF_TOKEN = /^(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+))[.,;]*$/i;

/**
 * `Depends on` lines: `#N`, `owner/repo#N` or an issue/PR URL, separated by commas, spaces or "and"
 * (also `- Depends on:` and `**Depends on:**`). Reading stops at the first token that is not a
 * reference, so prose after the list (`#3 (unlike #4 ...)`) adds nothing.
 */
export function parseBodyDependencies(repo: string, body: string): TaskRef[] {
  const refs: TaskRef[] = [];
  for (const line of body.split('\n')) {
    const match = /^\s*(?:[-*]\s+)?[*_]*depends\s+on[*_]*:?[*_]*\s+(.+)$/i.exec(line);
    if (match === null) continue;
    for (const token of match[1]!.split(/[\s,]+/).filter((t) => t !== '')) {
      if (/^(and|&)$/i.test(token)) continue;
      const m = REF_TOKEN.exec(token);
      if (m === null) break;
      const target = m[1] ?? m[4] ?? repo;
      if (validRepo(target)) refs.push({ repo: target, number: Number(m[2] ?? m[3] ?? m[5]) });
    }
  }
  return refs;
}

/** `Start: YYYY-MM-DD` (month/day may be one digit; text after the date is ignored). */
export type StartDate = { date: Date } | { invalid: string };

/** undefined: no Start line. A Start line whose value begins with a digit but is no real date is `invalid`. */
export function parseStartDate(body: string): StartDate | undefined {
  const match = /^\s*(?:[-*]\s+)?[*_]*start[*_]*:[*_]*\s*(\d.*?)\s*$/im.exec(body);
  if (match === null) return undefined;
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s.*)?$/.exec(match[1]!);
  const [y, m, d] = [Number(parts?.[1]), Number(parts?.[2]), Number(parts?.[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (parts === null || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { invalid: `"Start: ${match[1]}" is not a valid YYYY-MM-DD date` };
  }
  return { date };
}

interface DepIssue {
  state?: string;
  state_reason?: string | null;
  body?: string | null;
  pull_request?: { merged_at?: string | null } | null;
}

const notFound = (error: unknown): boolean => /HTTP 404|Not Found/i.test(failureReason(error));

/** Retries a gh read: one transient 5xx must not park an issue. */
async function read(gh: GhRunner, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await gh(args);
    } catch (error) {
      if (attempt >= LOOKUP_ATTEMPTS || notFound(error)) throw error;
    }
  }
}

/** undefined: 404. Only the caller knows whether that means "does not exist" or "not readable". */
async function getIssue(ref: TaskRef, gh: GhRunner): Promise<DepIssue | undefined> {
  try {
    return JSON.parse(await read(gh, ['api', `repos/${ref.repo}/issues/${ref.number}`])) as DepIssue;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

/** Native "blocked by" relations of an issue; each is resolved against the repo it lives in, never the current one. */
async function nativeBlockers(ref: TaskRef, gh: GhRunner): Promise<TaskRef[]> {
  let out: string;
  try {
    out = await read(gh, ['api', `repos/${ref.repo}/issues/${ref.number}/dependencies/blocked_by`, '--paginate']);
  } catch (error) {
    // Relationships unavailable on this host/plan: body lines are the fallback.
    if (notFound(error)) return [];
    throw error;
  }
  const parsed: unknown = out.trim() === '' ? [] : JSON.parse(out);
  const items = (Array.isArray(parsed) ? parsed : []) as { number: number; repository_url?: string; repository?: { full_name?: string } }[];
  return items.map((item) => {
    const repo = item.repository?.full_name ?? item.repository_url?.replace(/^.*\/repos\//, '');
    if (repo === undefined || !validRepo(repo)) throw new Error(`blocked-by #${item.number} of ${refText(ref)} names no repository`);
    return { repo, number: item.number };
  });
}

const same = (a: TaskRef, b: TaskRef): boolean => a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;

function dedupe(refs: TaskRef[]): TaskRef[] {
  return refs.filter((ref, i) => refs.findIndex((other) => same(other, ref)) === i);
}

export type DependencyVerdict =
  | { status: 'ready'; dependsOn: TaskRef[] }
  /** Unmet blockers and/or a future start date. */
  | { status: 'waiting'; blockers: TaskRef[]; startsAt?: Date; reason: string }
  /** Cycle, missing reference, blocker closed without completing, bad Start date: a human must fix the issue. */
  | { status: 'invalid'; reason: string }
  /** Lookup failed (403/SAML, unreadable cross-repo ref, network): not knowable, never silently skipped. */
  | { status: 'error'; reason: string };

type Walk = { problem: string } | { problem?: undefined; direct: Map<string, DepIssue> };

/** Depth-first walk from `self`; returns the direct dependencies' issues, or a missing/cyclic problem. */
async function walk(self: TaskRef, direct: TaskRef[], gh: GhRunner): Promise<Walk> {
  const fetched = new Map<string, DepIssue>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<string | undefined> => {
    for (const dep of refs) {
      if (path.some((p) => same(p, dep))) return `dependency cycle: ${[...path, dep].map(refText).join(' → ')}`;
      if (++visited > MAX_NODES) return `dependency chain too large (more than ${MAX_NODES} issues)`;
      const issue = await getIssue(dep, gh);
      if (issue === undefined) {
        // A 404 in another repo may just be a token that cannot read it: say so instead of "does not exist".
        if (dep.repo.toLowerCase() !== self.repo.toLowerCase()) throw new Error(`${refText(dep)} was not found or is not readable with this token (referenced by ${refText(ref)})`);
        return `${refText(dep)} does not exist (referenced by ${refText(ref)})`;
      }
      if (ref === self) fetched.set(refText(dep), issue);
      // A closed dependency's own blockers no longer matter.
      if (issue.state?.toLowerCase() === 'closed') continue;
      const next = dedupe([...(await nativeBlockers(dep, gh)), ...parseBodyDependencies(dep.repo, issue.body ?? '')]);
      const problem = await visit(dep, next, [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const problem = await visit(self, direct, [self]);
  return problem === undefined ? { direct: fetched } : { problem };
}

/**
 * Whether `task` (a GitHub issue of `repo`) may start. A dependency is met when closed as completed
 * (including legacy closes with no reason) or a merged PR; closed as not planned / an unmerged PR can
 * never be met and is `invalid`. Uses `task.dependsOn` when already filled, else native relations plus
 * body lines.
 */
export async function checkDependencies(repo: string, task: Task, gh: GhRunner = defaultGhRunner, now: Date = new Date()): Promise<DependencyVerdict> {
  const self: TaskRef = { repo, number: Number(task.ref ?? task.id.slice(task.id.indexOf('#') + 1)) };
  try {
    const direct = task.dependsOn ?? dedupe([...(await nativeBlockers(self, gh)), ...parseBodyDependencies(repo, task.description)]);
    const start = parseStartDate(task.description);
    if (start !== undefined && 'invalid' in start) return { status: 'invalid', reason: start.invalid };
    const walked = await walk(self, direct, gh);
    if (walked.problem !== undefined) return { status: 'invalid', reason: walked.problem };
    const blockers: TaskRef[] = [];
    for (const ref of direct) {
      const issue = walked.direct.get(refText(ref))!;
      const isPr = issue.pull_request != null;
      const merged = isPr && issue.pull_request?.merged_at != null;
      const closed = issue.state?.toLowerCase() === 'closed';
      if (merged || (!isPr && closed && issue.state_reason?.toLowerCase() !== 'not_planned')) continue;
      if (closed) return { status: 'invalid', reason: `${refText(ref)} was closed without being completed (${isPr ? 'PR not merged' : 'not planned'})` };
      blockers.push(ref);
    }
    const startsAt = start !== undefined && start.date.getTime() > now.getTime() ? start.date : undefined;
    if (blockers.length === 0 && startsAt === undefined) return { status: 'ready', dependsOn: direct };
    const parts = [
      ...(blockers.length > 0 ? [`waiting for ${blockers.map(refText).join(', ')}`] : []),
      ...(startsAt !== undefined ? [`start date ${startsAt.toISOString().slice(0, 10)}`] : []),
    ];
    return { status: 'waiting', blockers, ...(startsAt !== undefined ? { startsAt } : {}), reason: parts.join('; ') };
  } catch (error) {
    return { status: 'error', reason: `dependency lookup failed: ${failureReason(error)}` };
  }
}

/** Hidden marker on the wait comment: names the label the resume sweep restores. */
export const waitingMarker = (trigger: string): string => `<!-- vanguard:waiting trigger="${trigger}" -->`;
export const WAITING_MARKER_RE = /<!-- vanguard:waiting trigger="([^"]+)" -->/;

export interface DependencyGateOptions {
  repo: string;
  /** The trigger label that started this run; removed while the issue waits and restored by the resume sweep. */
  trigger: string;
  /** Label for a cycle or missing reference (omitted ⇒ the issue is only commented and un-triggered). */
  needsInfoLabel?: string;
  gh?: GhRunner;
  now?: Date;
  log?: (line: string) => void;
}

const RESUME_NOTE = (trigger: string): string =>
  `The scheduled resume sweep (\`resume-rate-limited\`, e.g. taskcell-resume.yml) re-applies \`${trigger}\` and drops \`${GITHUB_WAITING_LABEL}\` once this is resolved; if no such sweep runs for this repo, re-apply the label by hand.\n\n${waitingMarker(trigger)}`;

/**
 * Keep issues whose dependencies are unmet (or whose `Start:` date is ahead) from starting. Waiting and
 * lookup-failed issues swap the trigger label for `vanguard:waiting` (one comment, not repeated while the
 * label is present); `resume-rate-limited` swaps it back once the blockers are done. Cycles and missing
 * references go to needs-info. Ready issues leave the gate with a stale waiting label removed, so a
 * later sweep cannot start them a second time. Issues without dependencies pass through untouched.
 */
export async function applyDependencyGate(tasks: Task[], opts: DependencyGateOptions): Promise<Task[]> {
  const gh = opts.gh ?? defaultGhRunner;
  const log = opts.log ?? console.log;
  const ready: Task[] = [];
  for (const task of tasks) {
    const verdict = await checkDependencies(opts.repo, task, gh, opts.now);
    const waitingBefore = task.labels.includes(GITHUB_WAITING_LABEL);
    if (verdict.status === 'ready') {
      ready.push({ ...task, dependsOn: verdict.dependsOn, labels: task.labels.filter((l) => l !== GITHUB_WAITING_LABEL) });
      if (waitingBefore) await editGithubLabels(opts.repo, task.id, { remove: [GITHUB_WAITING_LABEL] }, gh).catch(() => undefined);
      continue;
    }
    // Comment first: if it fails nothing has moved and the next run retries with the trigger intact.
    const park = async (add: string | undefined, body: string | undefined, remove: string[]): Promise<void> => {
      if (body !== undefined) await commentGithubIssue(opts.repo, task.id, body, gh);
      if (add === GITHUB_WAITING_LABEL) await gh(['label', 'create', add, '--repo', opts.repo, '--force']).catch(() => undefined);
      await editGithubLabels(opts.repo, task.id, { remove: [opts.trigger, ...remove], ...(add !== undefined ? { add: [add] } : {}) }, gh);
    };
    try {
      log(`taskcell: ${task.id} skipped -> ${verdict.status === 'waiting' ? '' : verdict.status === 'invalid' ? 'needs info: ' : ''}${verdict.reason}`);
      if (verdict.status === 'invalid') {
        await park(opts.needsInfoLabel, `Vanguard cannot start this issue: ${verdict.reason}. Fix it and re-apply \`${opts.trigger}\`.`, waitingBefore ? [GITHUB_WAITING_LABEL] : []);
      } else if (verdict.status === 'error') {
        await park(GITHUB_WAITING_LABEL, waitingBefore ? undefined : `Vanguard could not check this issue's dependencies: ${verdict.reason}. It is labelled \`${GITHUB_WAITING_LABEL}\` and will not start until the check succeeds and its dependencies are met. ${RESUME_NOTE(opts.trigger)}`, []);
      } else {
        const what = [
          ...(verdict.blockers.length > 0 ? [`is blocked by ${verdict.blockers.map(refText).join(', ')}`] : []),
          ...(verdict.startsAt !== undefined ? [`has a start date of ${verdict.startsAt.toISOString().slice(0, 10)}`] : []),
        ].join(' and ');
        await park(GITHUB_WAITING_LABEL, waitingBefore ? undefined : `Vanguard will not start this issue yet: it ${what}. It is labelled \`${GITHUB_WAITING_LABEL}\`. ${RESUME_NOTE(opts.trigger)}`, []);
      }
    } catch (error) {
      log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
    }
  }
  return ready;
}
