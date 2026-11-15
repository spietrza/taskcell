import { failureReason } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import { fanOut } from '../pipeline/fan-out.js';
import { directiveLines, parseStartDate } from './dependencies.js';
import { commentLinearIssue, LinearGraphqlRequestError, linearGraphql, parseIdentifier } from './linear-cli.js';
import type { StartDate } from './dependencies.js';
import type { Task, TaskRef } from './fetcher.js';
import type { LinearCliRunner, LinearGraphql } from './linear-cli.js';

const MAX_NODES = 50;
/** Backstop for one issue's relations (100 per page). */
const MAX_RELATION_PAGES = 10;
const CHECK_CONCURRENCY = 4;

/** A ref as `DEV-12`, team key upper-cased: the form sent to Linear, shown in reasons and used as the per-poll cache key. */
const refText = (ref: TaskRef): string => `${ref.repo.toUpperCase()}-${ref.number}`;
const same = (a: TaskRef, b: TaskRef): boolean => refText(a) === refText(b);
const dedupe = (refs: TaskRef[]): TaskRef[] => {
  const seen = new Set<string>();
  return refs.filter((ref) => !seen.has(refText(ref)) && seen.add(refText(ref)).size > 0);
};
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** `DEV-12` or a Linear issue URL (`https://linear.app/team/issue/DEV-12/slug`). The slug excludes `.,;` so it cannot overlap the trailing punctuation (no quadratic backtracking). */
const REF_TOKEN = /^(?:([A-Za-z][A-Za-z0-9]*-\d+)|https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^\s/.,;]*)?\/?)[.,;]*$/i;

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

interface LinearRelation {
  type?: string;
  issue?: { identifier?: string } | null;
}

interface LinearDepIssue {
  identifier?: string;
  state?: { type?: string } | null;
  cycle?: { startsAt?: string | null } | null;
  /** Relations pointing at this issue; type `blocks` means `issue` blocks this one. */
  inverseRelations?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<LinearRelation | null> } | null;
}

const ISSUE_QUERY = `query($id: String!, $after: String) { issue(id: $id) { identifier state { type } cycle { startsAt } inverseRelations(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { type issue { identifier } } } } }`;

interface GraphqlError {
  message?: string;
  extensions?: { code?: string } | null;
}

interface IssueResponse {
  data?: { issue?: LinearDepIssue | null };
  errors?: GraphqlError[];
}

/** Linear does not accept the query as written (a validation error, no data): not a hiccup, and the only failure the gate opens on. */
class QueryRejected extends Error {}
// Linear documents no code for a validation failure (only RATELIMITED), so the Apollo codes are a guess;
// the messages are graphql-js's own validation and syntax errors, which any GraphQL server based on it returns.
const REJECTION_CODES = new Set(['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED']);
const REJECTION_MESSAGE = /^(?:Cannot query field "|Unknown argument "|Unknown type "|Field "[^"]+" argument "[^"]+" of type "[^"]+" is required|Variable "\$\w+" (?:of (?:required )?type "[^"]+" |got invalid value)|Syntax Error: )/;
const isRejection = (errors: GraphqlError[]): boolean =>
  errors.length > 0 && errors.every((error) => REJECTION_CODES.has(error.extensions?.code ?? '') || REJECTION_MESSAGE.test(error.message ?? ''));
const errorText = (errors: GraphqlError[]): string => `Linear API error: ${errors.map((e) => e.message ?? '').join('; ')}`;
/** A thrown non-2xx answer whose body is a validation error, as `QueryRejected`; anything else unchanged. */
const classified = (error: unknown): unknown => (error instanceof LinearGraphqlRequestError && isRejection(error.errors) ? new QueryRejected(error.message) : error);

/** Linear's GraphQL error for an `issue(id:)` that does not exist or that the token cannot read. */
const ISSUE_NOT_FOUND = /\bentity not found:\s*issue\b/i;
const isMissing = (errors: GraphqlError[]): boolean => errors.length > 0 && errors.every((error) => ISSUE_NOT_FOUND.test(error.message ?? ''));

/** One issue with every page of its inverse relations. `missing` only on Linear's own not-found error, never on free text (a proxy's 404). */
async function loadIssue(ref: TaskRef, send: LinearGraphql): Promise<LinearDepIssue | 'missing'> {
  const relations: Array<LinearRelation | null> = [];
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_RELATION_PAGES) throw new Error(`${refText(ref)} has more than ${MAX_RELATION_PAGES * 100} relations`);
    let res: IssueResponse;
    try {
      res = (await send({ query: ISSUE_QUERY, variables: { id: refText(ref), ...(after !== undefined ? { after } : {}) } })) as IssueResponse;
    } catch (error) {
      // The real sender throws on a non-2xx status; Linear may answer "Entity not found" that way.
      if (error instanceof LinearGraphqlRequestError && isMissing(error.errors)) return 'missing';
      throw classified(error);
    }
    const errors = res.errors ?? [];
    if (isMissing(errors)) return 'missing';
    const issue = res.data?.issue;
    // Errors next to usable data are a partial answer, never a rejection of the query.
    if (errors.length > 0) throw issue == null && isRejection(errors) ? new QueryRejected(errorText(errors)) : new Error(errorText(errors));
    // Neither an error nor an issue: a malformed answer, not Linear saying the issue is missing.
    if (issue === undefined || issue === null) throw new Error(`Linear API returned no issue for ${refText(ref)}`);
    const connection = issue.inverseRelations;
    // No relation data: returned as is, so `blockersOf` holds the issue instead of reading "no blockers".
    if (connection === undefined || connection === null || connection.nodes === undefined) return issue;
    relations.push(...connection.nodes);
    const next = connection.pageInfo;
    if (next?.hasNextPage !== true) return { ...issue, inverseRelations: { nodes: relations } };
    if (next.endCursor === undefined || next.endCursor === null || next.endCursor === after) throw new Error(`Linear relation pagination did not advance for ${refText(ref)}`);
    after = next.endCursor;
  }
}

type IssueLookup = (ref: TaskRef) => Promise<LinearDepIssue | 'missing'>;

/** Each issue is read at most once per poll, however many listed issues depend on it (a failed read is shared too). */
function createIssueLookup(send: LinearGraphql): IssueLookup {
  const cache = new Map<string, Promise<LinearDepIssue | 'missing'>>();
  return (ref) => {
    const key = refText(ref);
    const pending = cache.get(key) ?? loadIssue(ref, send);
    cache.set(key, pending);
    return pending;
  };
}

/**
 * Issues that block `issue` through native "blocked by" relations. A relation that cannot be read
 * (null, no type, no parseable identifier) is a `reason` to wait: dropping it could start a blocked issue.
 */
function blockersOf(issue: LinearDepIssue): { blockers: TaskRef[] } | { reason: string } {
  const nodes = issue.inverseRelations?.nodes;
  if (nodes === undefined) return { reason: 'Linear returned no relations' };
  const blockers: TaskRef[] = [];
  for (const relation of nodes) {
    if (relation === null || typeof relation.type !== 'string') return { reason: 'Linear returned a relation without a type' };
    if (relation.type !== 'blocks') continue;
    const ref = parseIdentifier(relation.issue?.identifier ?? '');
    if (ref === undefined) return { reason: `Linear returned a "blocked by" relation without a readable issue (${relation.issue?.identifier ?? 'none'})` };
    blockers.push(ref);
  }
  return { blockers };
}

/** Linear's state types that end an issue without completing it. */
const neverCompleted = (issue: LinearDepIssue): boolean => issue.state?.type === 'canceled' || issue.state?.type === 'duplicate';
const isDone = (issue: LinearDepIssue): boolean => issue.state?.type === 'completed' || neverCompleted(issue);

export type LinearDependencyVerdict =
  | { status: 'ready'; dependsOn: TaskRef[] }
  | { status: 'waiting'; blockers: TaskRef[]; startsAt?: Date; reason: string }
  /** Cycle, missing reference, canceled blocker, bad start date: a human must fix the issue. */
  | { status: 'invalid'; reason: string }
  /** Lookup failed: not knowable, never silently started. */
  | { status: 'error'; reason: string };

type WalkProblem = { invalid: string } | { waiting: string };

/** Depth-first walk; beyond the direct blockers only native relations are followed (a dependency's body may be written by anyone). */
async function walk(self: TaskRef, direct: TaskRef[], lookup: IssueLookup): Promise<WalkProblem | { direct: Map<string, LinearDepIssue> }> {
  const fetched = new Map<string, LinearDepIssue>();
  const seen = new Set<string>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<WalkProblem | undefined> => {
    for (const dep of refs) {
      if (path.some((p) => same(p, dep))) return { invalid: `dependency cycle: ${[...path, dep].map(refText).join(' → ')}` };
      const key = refText(dep);
      if (ref !== self && seen.has(key)) continue;
      if (++visited > MAX_NODES) return { invalid: `dependency chain too large (more than ${MAX_NODES} issues)` };
      const issue = fetched.get(key) ?? (await lookup(dep));
      if (issue === 'missing') return { invalid: `${refText(dep)} does not exist or is not readable with this token (referenced by ${refText(ref)})` };
      if (ref === self) fetched.set(key, issue);
      seen.add(key);
      if (isDone(issue)) continue;
      const nested = blockersOf(issue);
      if ('reason' in nested) return { waiting: `the dependencies of ${refText(dep)} could not be read: ${nested.reason}` };
      const problem = await visit(dep, nested.blockers, [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return (await visit(self, direct, [self])) ?? { direct: fetched };
}

/** The cycle's start (kept to the instant, not the UTC day), else the `Start:` line; both validated. */
function startDate(cycleStart: string | null | undefined, description: string): StartDate | undefined {
  if (cycleStart != null) {
    const date = new Date(cycleStart);
    return Number.isNaN(date.getTime()) ? { invalid: `cycle start "${cycleStart}" is not a valid date` } : { date };
  }
  return parseStartDate(description);
}

/** What the probe already read for a listed issue, so the issue itself needs no lookup. */
interface KnownIssue {
  nativeBlockers: TaskRef[];
  cycleStart?: string;
}

/**
 * Whether `task` (a Linear issue) may start. A dependency is met when its state is completed; a
 * canceled or duplicate one can never be met and is `invalid`. `dependsOn` is the native "blocked by" relations plus
 * `Depends on DEV-12` lines.
 */
export async function checkLinearDependencies(
  task: Task,
  send: LinearGraphql,
  now: Date = new Date(),
  known?: KnownIssue,
  lookup: IssueLookup = createIssueLookup(send),
): Promise<LinearDependencyVerdict> {
  try {
    const selfId = parseIdentifier(task.ref ?? task.id);
    if (selfId === undefined) return { status: 'invalid', reason: `${task.id} is not a Linear identifier such as DEV-12, so its dependencies cannot be checked` };
    let native = known?.nativeBlockers;
    let cycleStart = known?.cycleStart;
    if (native === undefined) {
      const own = await lookup(selfId);
      if (own === 'missing') return { status: 'error', reason: `${refText(selfId)} could not be read` };
      const read = blockersOf(own);
      if ('reason' in read) return { status: 'waiting', blockers: [], reason: `its dependencies could not be read: ${read.reason}` };
      native = read.blockers;
      cycleStart = own.cycle?.startsAt ?? undefined;
    }
    const start = startDate(cycleStart, task.description);
    if (start !== undefined && 'invalid' in start) return { status: 'invalid', reason: start.invalid };
    const direct = dedupe([...native, ...parseLinearBodyDependencies(task.description)]);
    const walked = await walk(selfId, direct, lookup);
    if ('invalid' in walked) return { status: 'invalid', reason: walked.invalid };
    if ('waiting' in walked) return { status: 'waiting', blockers: [], reason: walked.waiting };
    const blockers: TaskRef[] = [];
    for (const ref of direct) {
      const issue = walked.direct.get(refText(ref))!;
      if (neverCompleted(issue)) return { status: 'invalid', reason: `${refText(ref)} was ${issue.state?.type === 'duplicate' ? 'closed as a duplicate' : 'canceled'}, so it can never be completed` };
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

const PROBE_RELATIONS = 10;
/**
 * The relations and cycle of the listed issues, read from the data itself. Not Linear's
 * `hasBlockedByRelations` filter: its schema documents it as true only while both issues are open, so
 * an issue with a canceled blocker would pass as unblocked.
 */
const PROBE_QUERY = `query($f: IssueFilter, $first: Int!) { issues(first: $first, filter: $f) { nodes { identifier cycle { startsAt } inverseRelations(first: ${PROBE_RELATIONS}) { pageInfo { hasNextPage } nodes { type issue { identifier } } } } } }`;
/** About 1,300 complexity points per probe (Linear rejects a query above 10,000). */
const PROBE_BATCH = 50;

interface ProbeResponse {
  data?: { issues?: { nodes?: LinearDepIssue[] } | null };
  errors?: GraphqlError[];
}

interface ProbeResult {
  known: Map<string, KnownIssue>;
  /** Issues of batches Linear rejected as a query (validation error), with the reason of the first. */
  rejected: TaskRef[];
  rejection?: string;
}

/**
 * One query per `PROBE_BATCH` listed issues. `known`: issues whose relations the probe read in full
 * (their blockers and cycle start). Every other issue gets its own lookup: one the probe could not
 * answer for (not returned, more than `PROBE_RELATIONS` relations, an unreadable relation) and every
 * issue of a batch that failed, which is logged. A failed probe never makes an issue ready.
 */
async function probe(refs: TaskRef[], send: LinearGraphql, log: (line: string) => void): Promise<ProbeResult> {
  const result: ProbeResult = { known: new Map(), rejected: [] };
  for (let i = 0; i < refs.length; i += PROBE_BATCH) {
    const batch = refs.slice(i, i + PROBE_BATCH);
    const byTeam = new Map<string, number[]>();
    for (const ref of batch) {
      const team = ref.repo.toUpperCase();
      byTeam.set(team, [...(byTeam.get(team) ?? []), ref.number]);
    }
    const f = { or: [...byTeam].map(([team, numbers]) => ({ team: { key: { eqIgnoreCase: team } }, number: { in: numbers } })) };
    try {
      const res = (await send({ query: PROBE_QUERY, variables: { f, first: batch.length } }).catch((error: unknown) => { throw classified(error); })) as ProbeResponse;
      const nodes = res.data?.issues?.nodes;
      const errors = res.errors ?? [];
      // Errors next to usable data are a partial answer: transient, the whole batch is looked up.
      if (errors.length > 0) throw nodes === undefined && isRejection(errors) ? new QueryRejected(errorText(errors)) : new Error(errorText(errors));
      if (nodes === undefined) throw new Error('Linear API returned no issue connection');
      for (const node of nodes) {
        const ref = parseIdentifier(node.identifier ?? '');
        const read = node.inverseRelations?.pageInfo?.hasNextPage === false ? blockersOf(node) : undefined;
        if (ref === undefined || read === undefined || 'reason' in read) continue;
        const cycleStart = node.cycle?.startsAt ?? undefined;
        result.known.set(refText(ref), { nativeBlockers: read.blockers, ...(cycleStart !== undefined ? { cycleStart } : {}) });
      }
    } catch (error) {
      log(`taskcell: Linear dependency probe failed, looking up ${batch.length} issue(s) one by one -> ${failureReason(error)}`);
      if (!(error instanceof QueryRejected)) continue;
      result.rejected.push(...batch);
      result.rejection ??= failureReason(error);
    }
  }
  return result;
}

export interface LinearDependencyGateOptions {
  /** Moves an invalid issue here (e.g. 'Needs Info'), out of the trigger state; absent: it is commented on and stays. */
  moveToNeedsInfo?: (id: string) => Promise<void>;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
  now?: Date;
  /** Last comment posted per issue id by this process; defaults to a process-wide map, so a held issue costs no comment read on every poll. */
  reported?: Map<string, string>;
  /** Last skip reason logged per issue id; defaults to a process-wide map, so a held issue logs once per reason, not once per poll. */
  logged?: Map<string, string>;
  log?: (line: string) => void;
}

const reportedComments = new Map<string, string>();
const loggedReasons = new Map<string, string>();

const RECENT_COMMENTS = 5;
/** Both ends of the connection, so the recent comments are among them whichever way Linear orders it. */
const RECENT_COMMENTS_QUERY = `query($id: String!) { issue(id: $id) { first: comments(first: ${RECENT_COMMENTS}) { nodes { body } } last: comments(last: ${RECENT_COMMENTS}) { nodes { body } } } }`;

interface CommentNodes {
  nodes?: { body?: string | null }[];
}

interface RecentCommentsResponse {
  data?: { issue?: { first?: CommentNodes | null; last?: CommentNodes | null } | null };
  errors?: GraphqlError[];
}

/** Letters and digits only: equal however Linear re-renders the markdown or the whitespace. */
const comparable = (text: string): string => text.replace(/[^\p{L}\p{N}]+/gu, '');

/** Posts `body` unless one of the issue's recent comments already says the same, so a restart or `watch --once` does not repeat it. */
async function commentOnce(id: string, body: string, send: LinearGraphql, opts: LinearDependencyGateOptions): Promise<void> {
  const reported = opts.reported ?? reportedComments;
  const published = comparable(redactForPublish(body));
  if (reported.get(id) === published) return;
  const res = (await send({ query: RECENT_COMMENTS_QUERY, variables: { id } })) as RecentCommentsResponse;
  const issue = res.data?.issue;
  if ((res.errors ?? []).length > 0 || issue?.first?.nodes === undefined || issue.last?.nodes === undefined) throw new Error('the recent comments could not be read');
  const recent = [...issue.first.nodes, ...issue.last.nodes];
  if (!recent.some((node) => comparable(node.body ?? '') === published)) await commentLinearIssue(id, body, opts.linear);
  reported.set(id, published);
}

/** Text the issue author controls, as inline code: it can neither mention anyone nor render markup. */
const quoted = (text: string): string => `\`${text.replace(/[`@]/g, '').replace(/\s+/g, ' ').trim()}\``;

/**
 * Keeps Linear issues with unmet dependencies (or a future start date) from starting. A waiting issue
 * gets one comment, is skipped this poll and stays in its trigger state, so a later poll starts it by
 * itself once the blockers are done and the date reached. A cycle, a missing reference, a canceled
 * blocker, an impossible date or an unreadable identifier gets one comment with the reason and moves
 * to the needs-info state. A failed probe or lookup is logged and the issue skipped for this poll.
 * Only when Linear rejects both the probe and the lookup as queries (a validation error: the gate's
 * queries do not fit the schema, which no retry fixes) are native relations not honoured, so that a
 * wrong query cannot stop every Linear watch; `Depends on` and `Start:` lines still hold.
 */
export async function applyLinearDependencyGate(tasks: Task[], opts: LinearDependencyGateOptions = {}): Promise<Task[]> {
  if (tasks.length === 0) return tasks;
  const log = opts.log ?? console.log;
  const logged = opts.logged ?? loggedReasons;
  const send = opts.graphql ?? (await linearGraphql(opts.linear));
  const refs = new Map(tasks.map((task) => [task, parseIdentifier(task.ref ?? task.id)]));
  const probed = await probe([...refs.values()].filter((ref): ref is TaskRef => ref !== undefined), send, log);
  const lookup = createIssueLookup(send);
  const first = probed.rejected[0];
  if (first !== undefined) {
    // The lookup is one query for every issue: rejected for one, it is rejected for all.
    const lookupRejection = await lookup(first).then(() => undefined, (error: unknown) => (error instanceof QueryRejected ? error.message : undefined));
    if (lookupRejection !== undefined) {
      log(`taskcell: Linear rejected the dependency queries, native "blocked by" relations and cycles of ${probed.rejected.length} issue(s) not honoured this poll (Depends on and Start lines still are) -> ${probed.rejection ?? ''}; ${lookupRejection}`);
      for (const ref of probed.rejected) probed.known.set(refText(ref), { nativeBlockers: [] });
    }
  }
  const check = (task: Task): Promise<LinearDependencyVerdict> => {
    const ref = refs.get(task);
    return checkLinearDependencies(task, send, opts.now, ref !== undefined ? probed.known.get(refText(ref)) : undefined, lookup);
  };
  const checked = await fanOut(tasks, check, { concurrency: CHECK_CONCURRENCY });
  const ready: Task[] = [];
  for (const outcome of checked) {
    const task = outcome.item;
    const verdict: LinearDependencyVerdict = outcome.status === 'fulfilled' ? outcome.value : { status: 'error', reason: failureReason(outcome.reason) };
    if (verdict.status === 'ready') {
      (opts.reported ?? reportedComments).delete(task.id);
      logged.delete(task.id);
      ready.push({ ...task, dependsOn: verdict.dependsOn });
      continue;
    }
    // Once per reason, not once per poll; the reason holds author text, so control characters are dropped.
    const reason = `${verdict.status === 'invalid' ? 'needs info: ' : ''}${verdict.reason}`.replace(/\p{Cc}+/gu, ' ');
    if (logged.get(task.id) !== reason) log(`taskcell: ${task.id} skipped -> ${reason}`);
    logged.set(task.id, reason);
    if (verdict.status === 'error') continue;
    try {
      if (verdict.status === 'waiting') {
        await commentOnce(task.id, `Taskcell will not start this issue yet: ${quoted(verdict.reason)}. It stays in its trigger state and starts by itself once that is resolved.`, send, opts);
        continue;
      }
      const next = opts.moveToNeedsInfo !== undefined ? 'Fix it and move it back to its trigger state.' : 'It stays in its trigger state and is checked again once it is fixed.';
      await commentOnce(task.id, `Taskcell cannot start this issue: ${quoted(verdict.reason)}. ${next}`, send, opts);
      await opts.moveToNeedsInfo?.(task.id);
    } catch (error) {
      log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
    }
  }
  return ready;
}
