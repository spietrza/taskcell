import { hasLabel, withoutLabel } from '../core/labels.js';
import { failureReason, NoRetryError } from '../core/errors.js';
import { classifyAuthor } from './comment-trust.js';
import { commentGithubIssue, defaultGhRunner, editGithubLabels } from './github.js';
import { GITHUB_WAITING_LABEL } from '../github-labels.js';
import { dedupeRefs, directiveLines, escalatesToNeedsInfo, evaluateDependencies, isSilentError, lookupFailed, parseStartDate, postUnlessRepeated, readWithRetry, runDependencyGate, waitingClause } from './dependency-gate.js';
import { describeHold, findOverlapMarker, overlapMarker } from './overlap.js';
import type { DependencyVerdict, WalkAdapter } from './dependency-gate.js';
import type { OverlapHold } from './overlap.js';
import type { GhRunner } from './github.js';
import type { Task, TaskRef } from './fetcher.js';

export { directiveLines, parseStartDate } from './dependency-gate.js';
export type { StartDate } from './dependency-gate.js';

export const refText = (ref: TaskRef): string => `${ref.repo}#${ref.number}`;

/** A GitHub task's issue number: `ref`, else the part of the id after `#`. */
const issueNumber = (task: Task): string => task.ref ?? task.id.slice(task.id.indexOf('#') + 1);

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
const read = (gh: GhRunner, args: string[]): Promise<string> =>
  readWithRetry(() => gh(args), (error) => {
    const status = httpStatus(error);
    return error instanceof NoRetryError || (status !== undefined && status >= 400 && status < 500);
  });

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

export type { DependencyVerdict };

/** The GitHub side of the shared walk: reads issues and native blocked-by relations through `gh`. */
const githubAdapter = (self: TaskRef, gh: GhRunner): WalkAdapter<DepIssue> => ({
  text: refText,
  async fetch(dep, referencedBy) {
    const issue = await getIssue(dep, gh);
    if (issue === 'deleted') return { problem: `${refText(dep)} was deleted (referenced by ${refText(referencedBy)})` };
    if (issue === 'missing') {
      // A 404 in another repo may just be a token that cannot read it: a failed lookup, not "does not exist".
      if (dep.repo.toLowerCase() !== self.repo.toLowerCase()) {
        throw new Error(`${refText(dep)} was not found or is not readable with this token (referenced by ${refText(referencedBy)})`);
      }
      return { problem: `${refText(dep)} does not exist (referenced by ${refText(referencedBy)})` };
    }
    return { issue };
  },
  finished: (issue) => issue.state?.toLowerCase() === 'closed',
  blockers: (ref) => nativeBlockers(ref, gh),
  judge(issue, ref) {
    const isPr = issue.pull_request != null;
    const closed = issue.state?.toLowerCase() === 'closed';
    const closedAs = issue.state_reason?.toLowerCase() ?? 'completed';
    if ((isPr && issue.pull_request?.merged_at != null) || (!isPr && closed && closedAs === 'completed')) return 'met';
    if (closed) return { invalid: `${refText(ref)} was closed without being completed (${isPr ? 'PR not merged' : closedAs.replace('_', ' ')})` };
    return 'open';
  },
});

/** An issue's declared dependencies: native blocked-by relations plus `Depends on` body lines. */
export async function directDependencies(repo: string, number: number, body: string, gh: GhRunner = defaultGhRunner): Promise<TaskRef[]> {
  const self = { repo, number };
  return dedupeRefs(githubAdapter(self, gh), [...(await nativeBlockers(self, gh)), ...parseBodyDependencies(repo, body)]);
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
    const adapter = githubAdapter(self, gh);
    const direct = task.dependsOn ?? dedupeRefs(adapter, [...(await nativeBlockers(self, gh)), ...parseBodyDependencies(repo, task.description)]);
    return await evaluateDependencies(adapter, { self, direct, start: parseStartDate(task.description), now });
  } catch (error) {
    return lookupFailed(error);
  }
}

/**
 * Hidden marker on the wait comment: names the label the resume sweep restores. `kind="error"` marks a
 * park for a failed lookup, which the sweep leaves alone until a human acts (it may read with a token
 * `watch` lacks, so re-triggering would only park the issue again, forever).
 */
export const waitingMarker = (trigger: string, kind?: 'error'): string => `<!-- taskcell:waiting trigger="${trigger}"${kind === 'error' ? ' kind="error"' : ''} -->`;
export const WAITING_MARKER_RE = /<!-- (?:taskcell|vanguard):waiting trigger="([^"]+)"( kind="error")? -->/;

export interface DependencyGateOptions {
  repo: string;
  /** The trigger label that started this run; removed while the issue waits and restored by the resume sweep. */
  trigger: string;
  /** Label for a cycle or missing reference (omitted ⇒ the issue is only commented and un-triggered). */
  needsInfoLabel?: string;
  gh?: GhRunner;
  now?: Date;
  log?: (line: string) => void;
  /**
   * Overlap hold: an otherwise-ready issue whose planned files overlap open factory work waits under
   * `taskcell:waiting` for at most `holdMs`, then starts anyway. A check that throws lets the issue pass.
   */
  overlap?: { check: (task: Task) => Promise<OverlapHold[]>; holdMs: number };
}

const ERROR_NOTE = (trigger: string): string =>
  `The resume sweep does not re-apply \`${trigger}\` after a failed lookup: once the token \`watch\` runs with can read every dependency, re-apply it by hand.\n\n${waitingMarker(trigger, 'error')}`;

const RESUME_NOTE = (trigger: string): string =>
  `The scheduled resume sweep (\`resume-rate-limited\`, e.g. taskcell-resume.yml) re-applies \`${trigger}\` and drops \`${GITHUB_WAITING_LABEL}\` once this is resolved; if no such sweep runs for this repo, re-apply the label by hand.\n\n${waitingMarker(trigger)}`;

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
 * lookup-failed issues swap the trigger label for `taskcell:waiting` (one comment, not repeated while the
 * label is present or when the newest trusted comment already says the same); `resume-rate-limited`
 * swaps it back once the blockers are done. Only a real invalid dependency (a cycle, a missing
 * reference, a blocker closed without completing, a bad date) goes to needs-info; a failed lookup is
 * held however often it recurs. Ready issues leave the gate with a stale waiting label removed, so a
 * later sweep cannot start them a second time. Issues without dependencies pass through untouched.
 */
export async function applyDependencyGate(tasks: Task[], opts: DependencyGateOptions): Promise<Task[]> {
  const gh = opts.gh ?? defaultGhRunner;
  const log = opts.log ?? console.log;
  return runDependencyGate(tasks, {
    check: (task) => checkDependencies(opts.repo, task, gh, opts.now),
    async release(task, verdict) {
      if (opts.overlap !== undefined && opts.overlap.holdMs > 0) {
        const holds = await opts.overlap.check(task).catch((error: unknown) => {
          log(`taskcell: ${task.id} overlap check failed, not holding -> ${failureReason(error)}`);
          return [] as OverlapHold[];
        });
        if (holds.length > 0 && (await holdForOverlap(task, holds, { opts, gh, log, now: opts.now ?? new Date(), holdMs: opts.overlap.holdMs }))) return undefined;
      }
      if (hasLabel(task.labels, GITHUB_WAITING_LABEL)) await editGithubLabels(opts.repo, task.id, { remove: [GITHUB_WAITING_LABEL] }, gh, log).catch(() => undefined);
      return { ...task, dependsOn: verdict.dependsOn, labels: withoutLabel(task.labels, GITHUB_WAITING_LABEL) };
    },
    async hold(task, verdict) {
      const waitingBefore = hasLabel(task.labels, GITHUB_WAITING_LABEL);
      if (isSilentError(verdict, parseBodyDependencies(opts.repo, task.description).length > 0 || parseStartDate(task.description) !== undefined)) {
        log(`taskcell: ${task.id} skipped this poll -> ${(verdict as { reason: string }).reason}`);
        return;
      }
      try {
        const comments = await trustedComments(opts.repo, task, gh);
        // Comment first: if it fails nothing has moved and the next run retries with the trigger intact.
        // A body identical to the newest trusted comment is not posted again (a label edit that failed last poll).
        const park = async (add: string | undefined, body: string | undefined, remove: string[]): Promise<void> => {
          if (body !== undefined) await postUnlessRepeated(body, comments[0], (published) => published, (text) => commentGithubIssue(opts.repo, task.id, text, gh));
          await editGithubLabels(opts.repo, task.id, { remove: [opts.trigger, ...remove], ...(add !== undefined ? { add: [add] } : {}), ensure: [GITHUB_WAITING_LABEL] }, gh, log);
        };
        log(`taskcell: ${task.id} skipped -> ${escalatesToNeedsInfo(verdict) ? 'needs info: ' : ''}${verdict.status === 'ready' ? '' : verdict.reason}`);
        if (verdict.status === 'invalid') {
          await park(opts.needsInfoLabel, `Taskcell cannot start this issue: ${verdict.reason}. Fix it and re-apply \`${opts.trigger}\`.`, waitingBefore ? [GITHUB_WAITING_LABEL] : []);
        } else if (verdict.status === 'error') {
          await park(GITHUB_WAITING_LABEL, waitingBefore ? undefined : `Taskcell could not check this issue's dependencies: ${verdict.reason}. It is labelled \`${GITHUB_WAITING_LABEL}\` and will not start until the check succeeds and its dependencies are met. ${ERROR_NOTE(opts.trigger)}`, []);
        } else if (verdict.status === 'waiting') {
          await park(GITHUB_WAITING_LABEL, waitingBefore ? undefined : `Taskcell will not start this issue yet: it ${waitingClause(verdict, refText)}. It is labelled \`${GITHUB_WAITING_LABEL}\`. ${RESUME_NOTE(opts.trigger)}`, []);
        }
      } catch (error) {
        log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
      }
    },
  });
}

/**
 * Parks an issue whose planned files overlap `holds` (one comment naming them, trigger swapped for
 * `taskcell:waiting`). True when held; false when the hold's deadline (fixed in its marker at the
 * first hold) has passed, so the issue starts. A failed label edit keeps it held: the trigger is still
 * on, the next poll retries, and the comment is not repeated.
 */
async function holdForOverlap(task: Task, holds: OverlapHold[], ctx: { opts: DependencyGateOptions; gh: GhRunner; log: (line: string) => void; now: Date; holdMs: number }): Promise<boolean> {
  const { opts, gh, log, now, holdMs } = ctx;
  try {
    const comments = await trustedComments(opts.repo, task, gh);
    const marker = findOverlapMarker(comments);
    if (marker !== undefined && now.getTime() >= marker.until.getTime()) {
      log(`taskcell: ${task.id} overlap hold over (${holdMs / 3_600_000} h cap), starting anyway`);
      return false;
    }
    log(`taskcell: ${task.id} skipped -> overlaps ${holds.map(describeHold).join('; ')}`);
    if (findOverlapMarker(comments.slice(0, 1)) === undefined) {
      const until = marker?.until ?? new Date(now.getTime() + holdMs);
      await commentGithubIssue(opts.repo, task.id, `Taskcell will not start this issue yet: its planned files overlap open factory work: ${holds.map(describeHold).join('; ')}. It is labelled \`${GITHUB_WAITING_LABEL}\` and starts when that work merges or closes, or after at most ${holdMs / 3_600_000} h. ${RESUME_NOTE(opts.trigger)}\n\n${overlapMarker(until, holds)}`, gh);
    }
    await editGithubLabels(opts.repo, task.id, { remove: [opts.trigger], add: [GITHUB_WAITING_LABEL], ensure: [GITHUB_WAITING_LABEL] }, gh, log).catch((error: unknown) => {
      log(`taskcell: ${task.id} overlap hold label edit failed, retrying next poll: ${failureReason(error)}`);
    });
    return true;
  } catch (error) {
    log(`taskcell: ${task.id} overlap hold could not be recorded: ${failureReason(error)}`);
    return false;
  }
}
