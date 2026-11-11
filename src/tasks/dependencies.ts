import type { Task } from './fetcher.js';

/** A reference to another task (issue or PR), optionally in a different repo (`owner/repo#N`). Same-repo refs omit `repo`. */
export interface TaskRef {
  repo?: string;
  number: string;
}

/** `Depends on #12` / `Depends on owner/repo#12`; one or more comma/space-separated refs per line. */
const DEPENDS_ON_LINE_RE = /^[ \t]*depends\s+on\s*:?\s*(.+?)\s*$/gim;
const REF_RE = /(?:([\w.-]+\/[\w.-]+)#|#)(\d+)/g;

/**
 * A valid `owner/repo` slug: every segment starts alphanumeric and then holds only `[A-Za-z0-9._-]`,
 * so neither segment can be `.` or `..`. Refs parsed out of an issue BODY are untrusted text that
 * ends up interpolated into a `repos/<repo>/issues/<n>` API path: an unvalidated one could walk out
 * of the repo namespace (`../`) and make the gate read some unrelated resource. Validation happens at
 * this parse boundary, before any API call, and anything that fails it is dropped.
 */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Dedupe a list of refs, same-repo-vs-qualified keyed case-insensitively. First occurrence wins. */
function dedupeRefs(refs: TaskRef[]): TaskRef[] {
  const seen = new Set<string>();
  const out: TaskRef[] = [];
  for (const ref of refs) {
    const key = `${ref.repo?.toLowerCase() ?? ''}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Merge two dependency lists (e.g. native + body-parsed), deduping repeats across both. */
export function mergeDependsOn(a: readonly TaskRef[], b: readonly TaskRef[]): TaskRef[] {
  return dedupeRefs([...a, ...b]);
}

/**
 * Parse `Depends on #N` / `Depends on owner/repo#N` lines from a task body — the fallback a provider
 * uses when it has no native dependency relation (#760). Each matching line may list multiple refs.
 * A qualified ref whose repo is not a valid `owner/repo` slug is dropped rather than returned
 * unqualified: it is a typo (or an attempt at a traversal) and must never reach the API.
 */
export function parseDependsOnBody(body: string): TaskRef[] {
  const refs: TaskRef[] = [];
  for (const line of body.matchAll(DEPENDS_ON_LINE_RE)) {
    for (const ref of (line[1] ?? '').matchAll(REF_RE)) {
      const repo = ref[1];
      const number = ref[2]!;
      if (repo === undefined) refs.push({ number });
      else if (REPO_SLUG_RE.test(repo)) refs.push({ repo, number });
    }
  }
  return dedupeRefs(refs);
}

const START_DATE_RE = /^[ \t]*start\s*:?\s*(\d{4}-\d{2}-\d{2})\s*$/im;

/** Parse an optional `Start: YYYY-MM-DD` line from a task body — the issue waits until that date (#760). */
export function parseStartDate(body: string): string | undefined {
  return START_DATE_RE.exec(body)?.[1];
}

/** `owner/repo#N`, qualified against `fallbackRepo` when `ref.repo` is absent. */
export function describeRef(ref: TaskRef, fallbackRepo: string): string {
  return `${ref.repo ?? fallbackRepo}#${ref.number}`;
}

function refKey(ref: TaskRef, fallbackRepo: string): string {
  return describeRef(ref, fallbackRepo).toLowerCase();
}

/** One dependency node resolved from its source: whether it's met, plus its own dependencies (walked for cycle detection). Missing ⇒ the reference does not exist (`met` is irrelevant). */
export interface DependencyNode {
  met: boolean;
  missing?: boolean;
  dependsOn: readonly TaskRef[];
}

/** Outcome of checking a task's dependencies and start date (#760). */
export type DependencyCheck =
  | { status: 'ready' }
  | { status: 'waiting'; kind: 'unmet'; blockers: TaskRef[] }
  | { status: 'waiting'; kind: 'start-date'; startDate: string }
  | { status: 'needs_info'; reason: string };

/**
 * Bounds on the dependency walk. Each node costs API round trips, and the graph is author-controlled
 * (anyone who can write an issue body can link more), so a deep or wide one must not turn a single
 * readiness check into an unbounded fan-out. Exceeding a bound fails closed (`needs_info`): the check
 * is incomplete, and guessing "ready" would spend an implement budget on a blocked task.
 */
const MAX_WALK_DEPTH = 10;
const MAX_WALK_NODES = 100;

/**
 * Walk a task's dependency graph (each node resolved via `resolveNode`) to decide whether it is
 * ready to run. A depth-first walk with classic colouring: a node on the current path is "visiting",
 * one whose subtree is fully walked is "done", so every node is resolved and expanded at most once
 * however many paths reach it, and meeting a "visiting" node again is a cycle. The walk stops as soon
 * as a cycle or a bound is hit.
 *
 * Order of checks: an unmet start date gates first (independent of `dependsOn`); then, among the
 * task's direct and transitive dependencies, a graph past the walk bounds, a cycle (a ref that
 * resolves back to `self` or to an ancestor already on the current path) or a reference that does not
 * exist all end in `needs_info` with the reason; otherwise any direct dependency not yet met ends in
 * `waiting` naming it. The walk stops below a dependency that is already met: nothing under a closed
 * issue can block this one, so neither its blockers nor its cycles are worth the round trips.
 */
export async function checkDependencies(
  task: Pick<Task, 'dependsOn' | 'startDate'>,
  self: TaskRef,
  fallbackRepo: string,
  resolveNode: (ref: TaskRef) => Promise<DependencyNode>,
  now: Date = new Date(),
): Promise<DependencyCheck> {
  if (task.startDate !== undefined) {
    const start = new Date(`${task.startDate}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && now.getTime() < start.getTime()) {
      return { status: 'waiting', kind: 'start-date', startDate: task.startDate };
    }
  }

  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return { status: 'ready' };

  const selfKey = refKey(self, fallbackRepo);
  const nodes = new Map<string, DependencyNode>();
  const visiting = new Set<string>([selfKey]);
  const done = new Set<string>();
  const missingRefs: TaskRef[] = [];
  /** Set on the first cycle or bound hit; the walk stops and the check fails closed with this reason. */
  let stopped: string | undefined;

  async function walk(ref: TaskRef): Promise<void> {
    const key = refKey(ref, fallbackRepo);
    if (visiting.has(key)) {
      stopped = `a dependency cycle involving ${deps.map((r) => describeRef(r, fallbackRepo)).join(', ')}`;
      return;
    }
    if (done.has(key)) return;
    if (visiting.size > MAX_WALK_DEPTH) {
      stopped = `a dependency graph too large to check (more than ${MAX_WALK_DEPTH} levels of nesting)`;
      return;
    }
    if (nodes.size >= MAX_WALK_NODES) {
      stopped = `a dependency graph too large to check (more than ${MAX_WALK_NODES} linked tasks)`;
      return;
    }
    const node = await resolveNode(ref);
    nodes.set(key, node);
    visiting.add(key);
    if (node.missing === true) missingRefs.push(ref);
    else if (!node.met) {
      // only an unmet node is expanded: nothing below a met dependency can block this task
      for (const child of node.dependsOn) {
        await walk(child);
        if (stopped !== undefined) return;
      }
    }
    visiting.delete(key);
    done.add(key);
  }

  for (const ref of deps) {
    await walk(ref);
    if (stopped !== undefined) return { status: 'needs_info', reason: stopped };
  }
  if (missingRefs.length > 0) {
    return { status: 'needs_info', reason: `depends on ${missingRefs.map((r) => describeRef(r, fallbackRepo)).join(', ')}, which does not exist` };
  }

  // The walk resolved every direct dep (it only skips nodes on a stop, which returned above).
  const blockers = deps.filter((ref) => nodes.get(refKey(ref, fallbackRepo))?.met !== true);
  if (blockers.length > 0) return { status: 'waiting', kind: 'unmet', blockers };
  return { status: 'ready' };
}

/** HTML-comment marker embedded in the one wait/needs-info comment posted per issue, so a later sweep does not repeat it. */
export const DEPENDENCY_MARKER = '<!-- vanguard:dependency-wait -->';

/** True when a task already carries the dependency wait/needs-info comment (dedup guard). */
export function hasDependencyComment(task: Pick<Task, 'comments'>): boolean {
  return task.comments.some((c) => c.body.includes(DEPENDENCY_MARKER));
}

/** One-line reason suitable for an operator/sweep log line. */
export function dependencyLogReason(check: Exclude<DependencyCheck, { status: 'ready' }>, fallbackRepo: string): string {
  if (check.status === 'needs_info') return `needs info -> ${check.reason}`;
  if (check.kind === 'start-date') return `waiting -> start date ${check.startDate} not reached`;
  return `waiting -> unmet dependency ${check.blockers.map((r) => describeRef(r, fallbackRepo)).join(', ')}`;
}

/** The comment posted (once) telling a human why Vanguard has not started the issue yet. */
export function dependencyWaitComment(check: Exclude<DependencyCheck, { status: 'ready' }>, fallbackRepo: string): string {
  if (check.status === 'needs_info') {
    return `Vanguard could not start: this issue has ${check.reason}. Fix the reference and re-trigger. ${DEPENDENCY_MARKER}`;
  }
  if (check.kind === 'start-date') {
    return `Vanguard is waiting: this issue has a start date of ${check.startDate} and will run automatically on or after that date. ${DEPENDENCY_MARKER}`;
  }
  const list = check.blockers.map((r) => describeRef(r, fallbackRepo)).join(', ');
  const plural = check.blockers.length > 1;
  return `Vanguard is waiting: this issue depends on ${list}, which ${plural ? 'are' : 'is'} not done yet. It will run automatically once ${plural ? 'those are closed' : 'that is closed'} (or merged, for a pull request). ${DEPENDENCY_MARKER}`;
}
