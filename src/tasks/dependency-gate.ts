import { failureReason } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import { fanOut } from '../pipeline/fan-out.js';
import type { Task, TaskRef } from './fetcher.js';

/**
 * The dependency gate shared by GitHub, GitLab and Linear: the walk, the node and lookup limits, the
 * verdict union, `Start:` dates, the one escalation rule and comment dedupe. A source supplies a small
 * adapter: read an issue and its native blockers (`WalkAdapter`), and post / release a hold (`GateAdapter`).
 */

export const MAX_NODES = 50;
const LOOKUP_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
/** Issues checked at once by a gate. */
const CHECK_CONCURRENCY = 4;

export type DependencyVerdict =
  | { status: 'ready'; dependsOn: TaskRef[] }
  /** Unmet blockers and/or a future start date. */
  | { status: 'waiting'; blockers: TaskRef[]; startsAt?: Date; reason: string }
  /** A real defect in the issue (cycle, missing reference, blocker that can never complete, bad Start date): a human must fix it. */
  | { status: 'invalid'; reason: string }
  /** Lookup failed (403, network, a malformed answer): not knowable, never silently started, and never a reason for needs-info. */
  | { status: 'error'; reason: string };

/**
 * The escalation rule, the same on every source: only a real invalid dependency moves an issue to
 * needs-info. A failed lookup (an outage, a token that cannot read a cross-repo issue) is held and
 * re-checked, however many polls in a row it fails.
 */
export const escalatesToNeedsInfo = (verdict: DependencyVerdict): boolean => verdict.status === 'invalid';

/** An unexpected throw while checking an issue is a failed lookup. */
export const lookupFailed = (error: unknown): DependencyVerdict => ({ status: 'error', reason: `dependency lookup failed: ${failureReason(error)}` });

export const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Retries a read with backoff: one transient failure must not hold an issue. `final` marks an error that is not retried (a 4xx). */
export async function readWithRetry<T>(run: () => Promise<T>, final: (error: unknown) => boolean): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= LOOKUP_ATTEMPTS || final(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

/**
 * Trimmed body lines that can carry a directive: fenced code blocks and `>` quotes are skipped, so an
 * example or a quoted reply never declares a dependency or a start date.
 */
export function directiveLines(body: string): string[] {
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

/** An `invalid` verdict for a bad start date, else undefined. */
export const invalidStart = (start: StartDate | undefined): DependencyVerdict | undefined =>
  start !== undefined && 'invalid' in start ? { status: 'invalid', reason: start.invalid } : undefined;

/** How a finished dependency counts: met, still open (a blocker), or one that can never be met. */
export type Judgement = 'met' | 'open' | { invalid: string };

export interface WalkAdapter<I> {
  /** A reference as shown in reasons; compared case-insensitively to tell two references apart. */
  text(ref: TaskRef): string;
  /** The issue, or `{ problem }` when it is certainly gone or unreadable-by-design (an invalid dependency). A transient failure throws. */
  fetch(ref: TaskRef, referencedBy: TaskRef): Promise<{ issue: I } | { problem: string }>;
  /** No longer blocks anything of its own: its blockers are not followed. */
  finished(issue: I): boolean;
  /** Native blockers of an open dependency; `{ waiting }` when they cannot be read (held, never started on a guess). */
  blockers(ref: TaskRef, issue: I): Promise<TaskRef[] | { waiting: string }>;
  /** Whether a direct dependency is met. */
  judge(issue: I, ref: TaskRef): Judgement;
}

const keyOf = <I>(adapter: WalkAdapter<I>, ref: TaskRef): string => adapter.text(ref).toLowerCase();

export const dedupeRefs = <I>(adapter: WalkAdapter<I>, refs: TaskRef[]): TaskRef[] => {
  const keys = refs.map((ref) => keyOf(adapter, ref));
  return refs.filter((_, i) => keys.indexOf(keys[i]!) === i);
};

type Walk<I> = { invalid: string } | { waiting: string } | { direct: Map<string, I> };

/**
 * Depth-first walk from `self`; returns the direct dependencies' issues, or a cycle / too-large /
 * missing problem. Beyond the root only native relations are followed: a dependency's body may be
 * written by anyone, and that text must not be able to fake a cycle, exhaust the node budget or point
 * lookups at other repos.
 */
async function walk<I>(adapter: WalkAdapter<I>, self: TaskRef, direct: TaskRef[]): Promise<Walk<I>> {
  const fetched = new Map<string, I>();
  const seen = new Set<string>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<{ invalid: string } | { waiting: string } | undefined> => {
    for (const dep of refs) {
      const key = keyOf(adapter, dep);
      if (path.some((p) => keyOf(adapter, p) === key)) return { invalid: `dependency cycle: ${[...path, dep].map((p) => adapter.text(p)).join(' → ')}` };
      if (ref !== self && seen.has(key)) continue;
      if (++visited > MAX_NODES) return { invalid: `dependency chain too large (more than ${MAX_NODES} issues)` };
      const cached = fetched.get(key);
      const found = cached !== undefined ? { issue: cached } : await adapter.fetch(dep, ref);
      if ('problem' in found) return { invalid: found.problem };
      const issue = found.issue;
      if (ref === self) fetched.set(key, issue);
      seen.add(key);
      // A finished dependency's own blockers no longer matter.
      if (adapter.finished(issue)) continue;
      const nested = await adapter.blockers(dep, issue);
      if ('waiting' in nested) return nested;
      const problem = await visit(dep, nested, [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return (await visit(self, direct, [self])) ?? { direct: fetched };
}

/**
 * The verdict for `direct` dependencies of `self` and an optional start date. Callers wrap this in a
 * try/catch that turns a throw into `lookupFailed`.
 */
export async function evaluateDependencies<I>(adapter: WalkAdapter<I>, input: { self: TaskRef; direct: TaskRef[]; start: StartDate | undefined; now: Date }): Promise<DependencyVerdict> {
  const { self, direct, start, now } = input;
  const bad = invalidStart(start);
  if (bad !== undefined) return bad;
  const walked = await walk(adapter, self, direct);
  if ('invalid' in walked) return { status: 'invalid', reason: walked.invalid };
  if ('waiting' in walked) return { status: 'waiting', blockers: [], reason: walked.waiting };
  const blockers: TaskRef[] = [];
  for (const ref of direct) {
    const judged = adapter.judge(walked.direct.get(keyOf(adapter, ref))!, ref);
    if (judged === 'open') blockers.push(ref);
    else if (judged !== 'met') return { status: 'invalid', reason: judged.invalid };
  }
  const startsAt = start !== undefined && 'date' in start && start.date.getTime() > now.getTime() ? start.date : undefined;
  if (blockers.length === 0 && startsAt === undefined) return { status: 'ready', dependsOn: direct };
  const parts = [
    ...(blockers.length > 0 ? [`waiting for ${blockers.map((b) => adapter.text(b)).join(', ')}`] : []),
    ...(startsAt !== undefined ? [`start date ${isoDay(startsAt)}`] : []),
  ];
  return { status: 'waiting', blockers, ...(startsAt !== undefined ? { startsAt } : {}), reason: parts.join('; ') };
}

/** "is blocked by X and has a start date of D": the hold comment's reason for a waiting verdict. */
export function waitingClause(verdict: Extract<DependencyVerdict, { status: 'waiting' }>, text: (ref: TaskRef) => string): string {
  return [
    ...(verdict.blockers.length > 0 ? [`is blocked by ${verdict.blockers.map(text).join(', ')}`] : []),
    ...(verdict.startsAt !== undefined ? [`has a start date of ${isoDay(verdict.startsAt)}`] : []),
  ].join(' and ');
}

/**
 * An `error` verdict on an issue that declares nothing is only the native-relations probe failing:
 * do not hold (or comment on) an issue that most likely has no dependencies; it stays triggered.
 */
export const isSilentError = (verdict: DependencyVerdict, declaresAnything: boolean): boolean => verdict.status === 'error' && !declaresAnything;

/**
 * Posts `body` unless it, as published (secrets redacted, then `normalize`d), equals `newest` (the
 * newest comment already on the issue, normalized the same way): a hold whose label edit failed last
 * poll, or a restart, does not repeat its comment.
 */
export async function postUnlessRepeated(body: string, newest: string | undefined, normalize: (published: string) => string, post: (body: string) => Promise<void>): Promise<boolean> {
  if (normalize(redactForPublish(body)) === newest) return false;
  await post(body);
  return true;
}

export interface GateAdapter {
  check(task: Task): Promise<DependencyVerdict>;
  /** The task to start (a stale hold removed, `dependsOn` filled), or undefined when the source holds it anyway (e.g. an overlap hold). */
  release(task: Task, verdict: Extract<DependencyVerdict, { status: 'ready' }>): Promise<Task | undefined>;
  /** Records a waiting / error / invalid verdict (comment, labels, state). `all` is every verdict of this poll. Must not throw. */
  hold(task: Task, verdict: DependencyVerdict, all: DependencyVerdict[]): Promise<void>;
}

/** Checks every task and starts the ready ones; everything else goes to `hold`. A check that throws is an `error` verdict. */
export async function runDependencyGate(tasks: Task[], adapter: GateAdapter): Promise<Task[]> {
  const checked = await fanOut(tasks, (task) => adapter.check(task), { concurrency: CHECK_CONCURRENCY });
  const verdicts = checked.map((outcome) => ({ task: outcome.item, verdict: outcome.status === 'fulfilled' ? outcome.value : lookupFailed(outcome.reason) }));
  const all = verdicts.map((v) => v.verdict);
  const ready: Task[] = [];
  for (const { task, verdict } of verdicts) {
    if (verdict.status === 'ready') {
      const started = await adapter.release(task, verdict);
      if (started !== undefined) ready.push(started);
    } else {
      await adapter.hold(task, verdict, all);
    }
  }
  return ready;
}
