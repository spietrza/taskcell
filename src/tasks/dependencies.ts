import type { Task } from './fetcher.js';

/** A reference to another task (issue or PR), optionally in a different repo (`owner/repo#N`). Same-repo refs omit `repo`. */
export interface TaskRef {
  repo?: string;
  number: string;
}

/** `Depends on #12` / `Depends on owner/repo#12`; one or more comma/space-separated refs per line. */
const DEPENDS_ON_LINE_RE = /^[ \t]*depends\s+on\s*:?\s*(.+?)\s*$/gim;
const REF_RE = /(?:([\w.-]+\/[\w.-]+)#|#)(\d+)/g;

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
 */
export function parseDependsOnBody(body: string): TaskRef[] {
  const refs: TaskRef[] = [];
  for (const line of body.matchAll(DEPENDS_ON_LINE_RE)) {
    for (const ref of (line[1] ?? '').matchAll(REF_RE)) {
      const repo = ref[1];
      const number = ref[2]!;
      refs.push(repo !== undefined ? { repo, number } : { number });
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
 * Walk a task's dependency graph (each node resolved via `resolveNode`, cached per ref so a
 * diamond-shaped graph resolves each node once) to decide whether it is ready to run.
 *
 * Order of checks: an unmet start date gates first (independent of `dependsOn`); then, among the
 * task's direct and transitive dependencies, a cycle (a ref that resolves back to `self` or to an
 * ancestor already on the current path) or a reference that does not exist both end in `needs_info`
 * with the reason; otherwise any direct dependency not yet met ends in `waiting` naming it.
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
  // Caches the in-flight PROMISE, not just the settled value: two branches of a diamond-shaped graph
  // (both depending on the same node) can reach `resolve` for it before either has awaited — caching
  // only the resolved value would let both call `resolveNode` and double the (network) work.
  const cache = new Map<string, Promise<DependencyNode>>();
  let cycle = false;
  const missingRefs: TaskRef[] = [];
  const missingKeys = new Set<string>();

  function resolve(ref: TaskRef): Promise<DependencyNode> {
    const key = refKey(ref, fallbackRepo);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const promise = resolveNode(ref);
    cache.set(key, promise);
    return promise;
  }

  async function walk(ref: TaskRef, path: ReadonlySet<string>): Promise<void> {
    const key = refKey(ref, fallbackRepo);
    if (key === selfKey || path.has(key)) {
      cycle = true;
      return;
    }
    const node = await resolve(ref);
    if (node.missing === true) {
      if (!missingKeys.has(key)) {
        missingKeys.add(key);
        missingRefs.push(ref);
      }
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(key);
    await Promise.all(node.dependsOn.map((child) => walk(child, nextPath)));
  }

  await Promise.all(deps.map((ref) => walk(ref, new Set([selfKey]))));

  if (cycle) {
    return { status: 'needs_info', reason: `a dependency cycle involving ${deps.map((r) => describeRef(r, fallbackRepo)).join(', ')}` };
  }
  if (missingRefs.length > 0) {
    return { status: 'needs_info', reason: `depends on ${missingRefs.map((r) => describeRef(r, fallbackRepo)).join(', ')}, which does not exist` };
  }

  const directNodes = await Promise.all(deps.map((ref) => resolve(ref)));
  const blockers = deps.filter((_, i) => directNodes[i]?.met !== true);
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
