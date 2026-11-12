import { failureReason } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import { fanOut } from '../pipeline/fan-out.js';
import { classifyAuthor } from './comment-trust.js';
import { commentGithubIssue, defaultGhRunner, editGithubLabels } from './github.js';
import { GITHUB_WAITING_LABEL } from '../github-labels.js';
import type { GhRunner } from './github.js';
import type { Task, TaskRef } from './fetcher.js';

const MAX_NODES = 50;
const LOOKUP_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
/** Issues checked at once by the gate (each check is one or more `gh api` reads). */
const CHECK_CONCURRENCY = 4;

export const refText = (ref: TaskRef): string => `${ref.repo}#${ref.number}`;

/** A GitHub task's issue number: `ref`, else the part of the id after `#`. */
const issueNumber = (task: Task): string => task.ref ?? task.id.slice(task.id.indexOf('#') + 1);

/** owner/name with real name characters; rejects `..`-style segments before they reach an API path. */
const validRepo = (repo: string): boolean => /^[\w.-]+\/[\w.-]+$/.test(repo) && repo.split('/').every((part) => !/^\.+$/.test(part));

const REF_TOKEN = /^(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+))[.,;]*$/i;

/**
 * Trimmed body lines that can carry a directive: fenced code blocks and `>` quotes are skipped, so an
 * example or a quoted reply never declares a dependency or a start date.
 */
function directiveLines(body: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && !line.startsWith('>')) lines.push(line);
  }
  return lines;
}

/**
 * `Depends on` lines: `#N`, `owner/repo#N` or an issue/PR URL, separated by commas, spaces or "and"
 * (also `- Depends on:` and `**Depends on:**`). Reading stops at the first token that is not a
 * reference, so prose after the list (`#3 (unlike #4 ...)`) adds nothing.
 */
export function parseBodyDependencies(repo: string, body: string): TaskRef[] {
  const refs: TaskRef[] = [];
  for (const line of directiveLines(body)) {
    const match = /^(?:[-*]\s+)?[*_]*depends\s+on[*_:]*\s+(.+)$/i.exec(line);
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

/**
 * undefined: no Start line. Only a value shaped like a date (`YYYY-…`) counts, so `Start: 3 workers`
 * or `Start: 10:30` is prose; such a value that is no real date is `invalid`.
 */
export function parseStartDate(body: string): StartDate | undefined {
  for (const line of directiveLines(body)) {
    const match = /^(?:[-*]\s+)?[*_]*start[*_]*:[*_]*\s*(\d{4}-\S*)/i.exec(line);
    if (match === null) continue;
    const value = match[1]!.replace(/[.,;]+$/, '');
    const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
    const [y, m, d] = [Number(parts?.[1]), Number(parts?.[2]), Number(parts?.[3])];
    const date = new Date(Date.UTC(y, m - 1, d));
    if (parts === null || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
      return { invalid: `"Start: ${value}" is not a valid YYYY-MM-DD date` };
    }
    return { date };
  }
  return undefined;
}

interface DepIssue {
  state?: string;
  state_reason?: string | null;
  pull_request?: { merged_at?: string | null } | null;
}

/** The HTTP status gh reports in its error (`... (HTTP 404)`), if any. */
const httpStatus = (error: unknown): number | undefined => {
  const match = /\bHTTP (\d{3})\b/.exec(failureReason(error));
  return match === null ? undefined : Number(match[1]);
};

/** Retries a gh read with backoff: one transient 5xx must not park an issue. A 4xx is final. */
async function read(gh: GhRunner, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await gh(args);
    } catch (error) {
      const status = httpStatus(error);
      if (attempt >= LOOKUP_ATTEMPTS || (status !== undefined && status >= 400 && status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

/** 'missing': 404, and only the caller knows whether that means "does not exist" or "not readable". 'deleted': 410. */
async function getIssue(ref: TaskRef, gh: GhRunner): Promise<DepIssue | 'missing' | 'deleted'> {
  try {
    return JSON.parse(await read(gh, ['api', `repos/${ref.repo}/issues/${ref.number}`])) as DepIssue;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404) return 'missing';
    if (status === 410) return 'deleted';
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
    if (httpStatus(error) === 404) return [];
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
  /** Cycle, missing or deleted reference, blocker closed without completing, bad Start date: a human must fix the issue. */
  | { status: 'invalid'; reason: string }
  /** Lookup failed (403/SAML, unreadable cross-repo ref, network): not knowable, never silently skipped. */
  | { status: 'error'; reason: string };

type Walk = { problem: string } | { problem?: undefined; direct: Map<string, DepIssue> };

/**
 * Depth-first walk from `self`; returns the direct dependencies' issues, or a missing/cyclic problem.
 * Beyond the root only native relations are followed: setting one takes triage access, whereas a
 * dependency's body may be written by anyone (an outsider's PR), and that text must not be able to
 * fake a cycle, exhaust the node budget or point lookups at other repos.
 */
async function walk(self: TaskRef, direct: TaskRef[], gh: GhRunner): Promise<Walk> {
  const fetched = new Map<string, DepIssue>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<string | undefined> => {
    for (const dep of refs) {
      if (path.some((p) => same(p, dep))) return `dependency cycle: ${[...path, dep].map(refText).join(' → ')}`;
      if (++visited > MAX_NODES) return `dependency chain too large (more than ${MAX_NODES} issues)`;
      const issue = await getIssue(dep, gh);
      if (issue === 'deleted') return `${refText(dep)} was deleted (referenced by ${refText(ref)})`;
      if (issue === 'missing') {
        // A 404 in another repo may just be a token that cannot read it: say so instead of "does not exist".
        if (dep.repo.toLowerCase() !== self.repo.toLowerCase()) {
          throw new Error(`${refText(dep)} was not found or is not readable with this token (referenced by ${refText(ref)})`);
        }
        return `${refText(dep)} does not exist (referenced by ${refText(ref)})`;
      }
      if (ref === self) fetched.set(refText(dep), issue);
      // A closed dependency's own blockers no longer matter.
      if (issue.state?.toLowerCase() === 'closed') continue;
      const problem = await visit(dep, await nativeBlockers(dep, gh), [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const problem = await visit(self, direct, [self]);
  return problem === undefined ? { direct: fetched } : { problem };
}

/**
 * Whether `task` (a GitHub issue of `repo`) may start. A dependency is met when closed as completed
 * (including legacy closes with no reason) or a merged PR; closed as not planned or duplicate / an
 * unmerged PR can never be met and is `invalid`. Uses `task.dependsOn` when already filled, else
 * native relations plus body lines.
 */
export async function checkDependencies(repo: string, task: Task, gh: GhRunner = defaultGhRunner, now: Date = new Date()): Promise<DependencyVerdict> {
  const self: TaskRef = { repo, number: Number(issueNumber(task)) };
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
      const closedAs = issue.state_reason?.toLowerCase() ?? 'completed';
      if (merged || (!isPr && closed && closedAs === 'completed')) continue;
      if (closed) return { status: 'invalid', reason: `${refText(ref)} was closed without being completed (${isPr ? 'PR not merged' : closedAs.replace('_', ' ')})` };
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

/**
 * Hidden marker on the wait comment: names the label the resume sweep restores. `kind="error"` marks a
 * park for a failed lookup, so the gate can tell when a resumed issue fails the same way again.
 */
export const waitingMarker = (trigger: string, kind?: 'error'): string => `<!-- vanguard:waiting trigger="${trigger}"${kind === 'error' ? ' kind="error"' : ''} -->`;
export const WAITING_MARKER_RE = /<!-- vanguard:waiting trigger="([^"]+)"( kind="error")? -->/;

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

const RESUME_NOTE = (trigger: string, kind?: 'error'): string =>
  `The scheduled resume sweep (\`resume-rate-limited\`, e.g. taskcell-resume.yml) re-applies \`${trigger}\` and drops \`${GITHUB_WAITING_LABEL}\` once this is resolved; if no such sweep runs for this repo, re-apply the label by hand.\n\n${waitingMarker(trigger, kind)}`;

/** Trusted comment bodies on the issue, newest first (a marker is plain text anyone can paste). */
async function trustedComments(repo: string, task: Task, gh: GhRunner): Promise<string[]> {
  const view = JSON.parse(await gh(['issue', 'view', issueNumber(task), '--repo', repo, '--json', 'comments'])) as {
    comments?: { body?: string | null; author?: { login?: string } | null; authorAssociation?: string }[];
  };
  return (view.comments ?? [])
    .filter((comment) => classifyAuthor(comment.author?.login ?? '', comment.authorAssociation ?? '') !== 'untrusted')
    .map((comment) => comment.body ?? '')
    .reverse();
}

/**
 * Keep issues whose dependencies are unmet (or whose `Start:` date is ahead) from starting. Waiting and
 * lookup-failed issues swap the trigger label for `vanguard:waiting` (one comment, not repeated while the
 * label is present or when the newest trusted comment already says the same); `resume-rate-limited`
 * swaps it back once the blockers are done. Cycles and missing references go to needs-info, as does a
 * lookup that fails again right after the sweep resumed an earlier failed lookup (the sweep may read
 * with a token this run lacks, which would otherwise loop). Ready issues leave the gate with a stale
 * waiting label removed, so a later sweep cannot start them a second time. Issues without dependencies
 * pass through untouched.
 */
export async function applyDependencyGate(tasks: Task[], opts: DependencyGateOptions): Promise<Task[]> {
  const gh = opts.gh ?? defaultGhRunner;
  const log = opts.log ?? console.log;
  const checked = await fanOut(tasks, (task) => checkDependencies(opts.repo, task, gh, opts.now), { concurrency: CHECK_CONCURRENCY });
  const ready: Task[] = [];
  for (const outcome of checked) {
    const task = outcome.item;
    let verdict: DependencyVerdict = outcome.status === 'fulfilled' ? outcome.value : { status: 'error', reason: failureReason(outcome.reason) };
    const waitingBefore = task.labels.includes(GITHUB_WAITING_LABEL);
    if (verdict.status === 'ready') {
      ready.push({ ...task, dependsOn: verdict.dependsOn, labels: task.labels.filter((l) => l !== GITHUB_WAITING_LABEL) });
      if (waitingBefore) await editGithubLabels(opts.repo, task.id, { remove: [GITHUB_WAITING_LABEL] }, gh).catch(() => undefined);
      continue;
    }
    if (verdict.status === 'error' && parseBodyDependencies(opts.repo, task.description).length === 0 && parseStartDate(task.description) === undefined) {
      // Only the native blocked-by probe failed and the body declares nothing: do not park (or comment
      // on) an issue that most likely has no dependencies; it stays triggered for the next poll.
      log(`taskcell: ${task.id} skipped this poll -> ${verdict.reason}`);
      continue;
    }
    try {
      const comments = await trustedComments(opts.repo, task, gh);
      if (verdict.status === 'error' && !waitingBefore && WAITING_MARKER_RE.exec(comments[0] ?? '')?.[2] !== undefined) {
        verdict = { status: 'invalid', reason: `${verdict.reason} (failed again after the resume sweep re-triggered it; the token \`watch\` runs with must be able to read every dependency)` };
      }
      // Comment first: if it fails nothing has moved and the next run retries with the trigger intact.
      // A body identical to the newest trusted comment is not posted again (a label edit that failed last poll).
      const park = async (add: string | undefined, body: string | undefined, remove: string[]): Promise<void> => {
        if (body !== undefined && redactForPublish(body) !== comments[0]) await commentGithubIssue(opts.repo, task.id, body, gh);
        if (add === GITHUB_WAITING_LABEL) await gh(['label', 'create', add, '--repo', opts.repo, '--force']).catch(() => undefined);
        await editGithubLabels(opts.repo, task.id, { remove: [opts.trigger, ...remove], ...(add !== undefined ? { add: [add] } : {}) }, gh);
      };
      log(`taskcell: ${task.id} skipped -> ${verdict.status === 'waiting' ? '' : verdict.status === 'invalid' ? 'needs info: ' : ''}${verdict.reason}`);
      if (verdict.status === 'invalid') {
        await park(opts.needsInfoLabel, `Vanguard cannot start this issue: ${verdict.reason}. Fix it and re-apply \`${opts.trigger}\`.`, waitingBefore ? [GITHUB_WAITING_LABEL] : []);
      } else if (verdict.status === 'error') {
        await park(GITHUB_WAITING_LABEL, waitingBefore ? undefined : `Vanguard could not check this issue's dependencies: ${verdict.reason}. It is labelled \`${GITHUB_WAITING_LABEL}\` and will not start until the check succeeds and its dependencies are met. ${RESUME_NOTE(opts.trigger, 'error')}`, []);
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
