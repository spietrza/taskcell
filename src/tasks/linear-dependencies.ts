import { failureReason } from '../core/errors.js';
import { fanOut } from '../pipeline/fan-out.js';
import { directiveLines, parseStartDate } from './dependencies.js';
import { commentLinearIssue, linearGraphql, parseIdentifier } from './linear-cli.js';
import type { StartDate } from './dependencies.js';
import type { Task, TaskRef } from './fetcher.js';
import type { LinearCliRunner, LinearGraphql } from './linear-cli.js';

const MAX_NODES = 50;
const CHECK_CONCURRENCY = 4;

/** A Linear identifier `DEV-12` as a ref: the team key is the `repo`, the issue number the `number`. */
const refText = (ref: TaskRef): string => `${ref.repo}-${ref.number}`;
const keyOf = (ref: TaskRef): string => refText(ref).toUpperCase();
const same = (a: TaskRef, b: TaskRef): boolean => keyOf(a) === keyOf(b);
const dedupe = (refs: TaskRef[]): TaskRef[] => refs.filter((ref, i) => refs.findIndex((other) => same(other, ref)) === i);
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** `DEV-12` or a Linear issue URL (`https://linear.app/team/issue/DEV-12/slug`). */
const REF_TOKEN = /^(?:([A-Za-z][A-Za-z0-9]*-\d+)|https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^\s/]*)?\/?)[.,;]*$/i;

/**
 * `Depends on DEV-12` lines (lists separated by commas, spaces or "and"; also `- Depends on:` and
 * `**Depends on:**`). Reading a line stops at the first token that is no reference, so prose after the
 * list adds nothing. Fenced code and quotes are skipped.
 */
export function parseLinearBodyDependencies(body: string): TaskRef[] {
  const refs: TaskRef[] = [];
  for (const line of directiveLines(body)) {
    const match = /^(?:[-*]\s+)?[*_]*depends\s+on[*_:]*\s+(.+)$/i.exec(line);
    if (match === null) continue;
    for (const token of match[1]!.split(/[\s,]+/).filter((t) => t !== '')) {
      if (/^(and|&)$/i.test(token)) continue;
      const m = REF_TOKEN.exec(token);
      if (m === null) break;
      const ref = parseIdentifier(m[1] ?? m[2]!);
      if (ref !== undefined) refs.push(ref);
    }
  }
  return refs;
}

interface LinearDepIssue {
  identifier?: string;
  state?: { type?: string } | null;
  cycle?: { startsAt?: string | null } | null;
  /** Relations pointing at this issue; type `blocks` means `issue` blocks this one. */
  inverseRelations?: { nodes?: Array<{ type?: string; issue?: { identifier?: string } | null }> } | null;
}

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) { identifier state { type } cycle { startsAt } inverseRelations(first: 100) { nodes { type issue { identifier } } } } }`;

interface IssueResponse {
  data?: { issue?: LinearDepIssue | null };
  errors?: { message?: string }[];
}

const NOT_FOUND = /not found|does not exist/i;

async function getIssue(ref: TaskRef, send: LinearGraphql): Promise<LinearDepIssue | 'missing'> {
  let res: IssueResponse;
  try {
    res = (await send({ query: ISSUE_QUERY, variables: { id: refText(ref) } })) as IssueResponse;
  } catch (error) {
    // The real sender throws on a non-2xx status; Linear may answer "Entity not found" that way.
    if (NOT_FOUND.test(failureReason(error))) return 'missing';
    throw error;
  }
  const errors = res.errors ?? [];
  if (errors.length > 0) {
    if (errors.every((e) => NOT_FOUND.test(e.message ?? ''))) return 'missing';
    throw new Error(`Linear API error: ${errors.map((e) => e.message ?? '').join('; ')}`);
  }
  const issue = res.data?.issue;
  return issue === undefined || issue === null ? 'missing' : issue;
}

/** Issues that block `issue` through native "blocked by" relations. */
function blockersOf(issue: LinearDepIssue): TaskRef[] {
  return (issue.inverseRelations?.nodes ?? [])
    .filter((rel) => rel.type === 'blocks')
    .map((rel) => parseIdentifier(rel.issue?.identifier ?? ''))
    .filter((ref): ref is TaskRef => ref !== undefined);
}

const isDone = (issue: LinearDepIssue): boolean => issue.state?.type === 'completed' || issue.state?.type === 'canceled';

export type LinearDependencyVerdict =
  | { status: 'ready'; dependsOn: TaskRef[] }
  | { status: 'waiting'; blockers: TaskRef[]; startsAt?: Date; reason: string }
  /** Cycle, missing reference, canceled blocker, bad start date: a human must fix the issue. */
  | { status: 'invalid'; reason: string }
  /** Lookup failed: not knowable, never silently started. */
  | { status: 'error'; reason: string };

/** Depth-first walk; beyond the direct blockers only native relations are followed (a dependency's body may be written by anyone). */
async function walk(self: TaskRef, direct: TaskRef[], send: LinearGraphql): Promise<{ problem: string } | { problem?: undefined; direct: Map<string, LinearDepIssue> }> {
  const fetched = new Map<string, LinearDepIssue>();
  const seen = new Set<string>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<string | undefined> => {
    for (const dep of refs) {
      if (path.some((p) => same(p, dep))) return `dependency cycle: ${[...path, dep].map(refText).join(' → ')}`;
      const key = keyOf(dep);
      if (ref !== self && seen.has(key)) continue;
      if (++visited > MAX_NODES) return `dependency chain too large (more than ${MAX_NODES} issues)`;
      const issue = fetched.get(key) ?? (await getIssue(dep, send));
      if (issue === 'missing') return `${refText(dep)} does not exist or is not readable with this token (referenced by ${refText(ref)})`;
      if (ref === self) fetched.set(key, issue);
      seen.add(key);
      if (isDone(issue)) continue;
      const problem = await visit(dep, blockersOf(issue), [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const problem = await visit(self, direct, [self]);
  return problem === undefined ? { direct: fetched } : { problem };
}

/** The cycle's start (kept to the instant, not the UTC day), else the `Start:` line; both validated. */
function startDate(cycleStart: string | null | undefined, description: string): StartDate | undefined {
  if (cycleStart != null) {
    const date = new Date(cycleStart);
    return Number.isNaN(date.getTime()) ? { invalid: `cycle start "${cycleStart}" is not a valid date` } : { date };
  }
  return parseStartDate(description);
}

/**
 * Whether `task` (a Linear issue) may start. A dependency is met when its state is completed; a
 * canceled one can never be met and is `invalid`. `dependsOn` is the native "blocked by" relations plus
 * `Depends on DEV-12` lines.
 */
export async function checkLinearDependencies(
  task: Task,
  send: LinearGraphql,
  now: Date = new Date(),
  known?: { nativeBlockers: TaskRef[] },
): Promise<LinearDependencyVerdict> {
  try {
    const selfId = parseIdentifier(task.ref ?? task.id);
    if (selfId === undefined) return { status: 'error', reason: `${task.id} is not a Linear identifier` };
    // `known`: the probe found no blocker and no cycle, so the issue itself needs no lookup.
    let native = known?.nativeBlockers;
    let cycleStart: string | undefined;
    if (native === undefined) {
      const own = await getIssue(selfId, send);
      if (own === 'missing') return { status: 'error', reason: `${refText(selfId)} could not be read` };
      native = blockersOf(own);
      cycleStart = own.cycle?.startsAt ?? undefined;
    }
    const start = startDate(cycleStart, task.description);
    if (start !== undefined && 'invalid' in start) return { status: 'invalid', reason: start.invalid };
    const direct = dedupe([...native, ...parseLinearBodyDependencies(task.description)]);
    const walked = await walk(selfId, direct, send);
    if (walked.problem !== undefined) return { status: 'invalid', reason: walked.problem };
    const blockers: TaskRef[] = [];
    for (const ref of direct) {
      const issue = walked.direct.get(keyOf(ref))!;
      if (issue.state?.type === 'canceled') return { status: 'invalid', reason: `${refText(ref)} was canceled, so it can never be completed` };
      if (!isDone(issue)) blockers.push(ref);
    }
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

/** Which listed issues have a native blocker or a cycle; only those need their own lookup. */
const PROBE_QUERY = `query($f: IssueFilter, $first: Int!) { issues(first: $first, filter: $f) { nodes { identifier } } }`;
/** Identifiers only, so a probe page stays far under Linear's per-query complexity cap. */
const PROBE_BATCH = 50;

interface ProbeResponse {
  data?: { issues?: { nodes?: { identifier?: string }[] } | null };
  errors?: { message?: string }[];
}

/**
 * Keys of the `refs` that have a native "blocked by" relation or a cycle, in batches of
 * `PROBE_BATCH` (one query each, identifiers only). A failed batch counts all of its issues, so they
 * fall back to their own lookup rather than starting unchecked.
 */
async function probeNeedsLookup(refs: TaskRef[], send: LinearGraphql): Promise<Set<string>> {
  const needs = new Set<string>();
  for (let i = 0; i < refs.length; i += PROBE_BATCH) {
    const batch = refs.slice(i, i + PROBE_BATCH);
    const byTeam = new Map<string, number[]>();
    for (const ref of batch) {
      const team = ref.repo.toUpperCase();
      byTeam.set(team, [...(byTeam.get(team) ?? []), ref.number]);
    }
    const f = {
      and: [
        { or: [...byTeam].map(([team, numbers]) => ({ team: { key: { eq: team } }, number: { in: numbers } })) },
        { or: [{ hasBlockedByRelations: { eq: true } }, { cycle: { null: false } }] },
      ],
    };
    try {
      const res = (await send({ query: PROBE_QUERY, variables: { f, first: batch.length } })) as ProbeResponse;
      const nodes = res.data?.issues?.nodes;
      if ((res.errors ?? []).length > 0 || nodes === undefined) throw new Error('probe failed');
      for (const node of nodes) {
        const ref = parseIdentifier(node.identifier ?? '');
        if (ref !== undefined) needs.add(keyOf(ref));
      }
    } catch {
      for (const ref of batch) needs.add(keyOf(ref));
    }
  }
  return needs;
}

export interface LinearDependencyGateOptions {
  /** Moves an invalid issue here (e.g. 'Needs Info'), out of the trigger state; absent: only logged. */
  moveToNeedsInfo?: (id: string) => Promise<void>;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
  now?: Date;
  /** Last reason reported per issue id; defaults to a process-wide map so a hold is commented once, not every poll. */
  reported?: Map<string, string>;
  log?: (line: string) => void;
}

const reportedReasons = new Map<string, string>();

/** Text the issue author controls, as inline code: it can neither mention anyone nor render markup. */
const quoted = (text: string): string => `\`${text.replace(/[`@]/g, '').replace(/\s+/g, ' ').trim()}\``;

/**
 * Keeps Linear issues with unmet dependencies (or a future start date) from starting. A waiting issue
 * is skipped this poll and stays in its trigger state, so a later poll starts it by itself once the
 * blockers are done and the date reached. A cycle, a missing reference, a canceled blocker or an
 * impossible date gets one comment with the reason and moves to the needs-info state. A failed lookup
 * is skipped for this poll.
 */
export async function applyLinearDependencyGate(tasks: Task[], opts: LinearDependencyGateOptions = {}): Promise<Task[]> {
  if (tasks.length === 0) return tasks;
  const log = opts.log ?? console.log;
  const send = opts.graphql ?? (await linearGraphql(opts.linear));
  const refs = new Map(tasks.map((task) => [task, parseIdentifier(task.ref ?? task.id)]));
  const needs = await probeNeedsLookup([...refs.values()].filter((ref): ref is TaskRef => ref !== undefined), send);
  const known = (task: Task): { nativeBlockers: TaskRef[] } | undefined => {
    const ref = refs.get(task);
    return ref !== undefined && !needs.has(keyOf(ref)) ? { nativeBlockers: [] } : undefined;
  };
  const checked = await fanOut(tasks, (task) => checkLinearDependencies(task, send, opts.now, known(task)), { concurrency: CHECK_CONCURRENCY });
  const ready: Task[] = [];
  for (const outcome of checked) {
    const task = outcome.item;
    const verdict: LinearDependencyVerdict = outcome.status === 'fulfilled' ? outcome.value : { status: 'error', reason: failureReason(outcome.reason) };
    if (verdict.status === 'ready') {
      ready.push({ ...task, dependsOn: verdict.dependsOn });
      continue;
    }
    if (verdict.status !== 'invalid') {
      log(`taskcell: ${task.id} skipped -> ${verdict.reason}`);
      continue;
    }
    log(`taskcell: ${task.id} skipped -> needs info: ${verdict.reason}`);
    if (opts.moveToNeedsInfo === undefined) continue;
    const reported = opts.reported ?? reportedReasons;
    try {
      if (reported.get(task.id) !== verdict.reason) {
        await commentLinearIssue(task.id, `Taskcell cannot start this issue: ${quoted(verdict.reason)}. Fix it and move it back to its trigger state.`, opts.linear);
        reported.set(task.id, verdict.reason);
      }
      await opts.moveToNeedsInfo(task.id);
    } catch (error) {
      log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
    }
  }
  return ready;
}
