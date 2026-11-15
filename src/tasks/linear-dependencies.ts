import { failureReason } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import { dedupeRefs, escalatesToNeedsInfo, evaluateDependencies, lookupFailed, parseStartDate, postUnlessRepeated, runDependencyGate, directiveLines } from './dependency-gate.js';
import { commentLinearIssue, LinearGraphqlRequestError, linearGraphql, parseIdentifier } from './linear-cli.js';
import type { DependencyVerdict, StartDate, WalkAdapter } from './dependency-gate.js';
import type { Task, TaskRef } from './fetcher.js';
import type { LinearCliRunner, LinearGraphql } from './linear-cli.js';

const MAX_RELATION_PAGES = 10;
/** A ref as `DEV-12`, team key upper-cased: the form sent to Linear, shown in reasons and used as the per-poll cache key. */
const refText = (ref: TaskRef): string => `${ref.repo.toUpperCase()}-${ref.number}`;

/** `DEV-12` (team key as `parseIdentifier` reads it, so `2FA-12` counts; an all-digit key such as `2024-11` is prose, not a reference) or a Linear issue URL (`https://linear.app/team/issue/DEV-12/slug`). The slug excludes `.,;` so it cannot overlap the trailing punctuation, and the key's leading digits stop at its first letter (no quadratic backtracking). */
const REF_TOKEN = /^(?:(\d*[A-Za-z][A-Za-z0-9]*-\d+)|https:\/\/linear\.app\/[\w.-]+\/issue\/(\d*[A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^\s/.,;]*)?\/?)[.,;]*$/i;

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

/** `fresh`: skip the cross-poll cache (an issue's own relations must be current). */
type IssueLookup = (ref: TaskRef, fresh?: boolean) => Promise<LinearDepIssue | 'missing'>;

/** How long a read issue is reused across polls, so a waiting issue with many dependencies does not spend Linear's hourly request budget every poll. */
const LOOKUP_TTL_MS = 2 * 60_000;
type LookupCache = Map<string, { at: number; issue: LinearDepIssue }>;
const lookupCache: LookupCache = new Map();

/**
 * Each issue is read at most once per poll, however many listed issues depend on it (a failed read is
 * shared too), and a successful read is reused for `LOOKUP_TTL_MS` across polls. A missing issue or a
 * failure is never kept across polls.
 */
function createIssueLookup(send: LinearGraphql, cache: LookupCache = new Map(), now: number = Date.now()): IssueLookup {
  const pollCache = new Map<string, Promise<LinearDepIssue | 'missing'>>();
  return (ref, fresh = false) => {
    const key = refText(ref);
    const hit = fresh ? undefined : cache.get(key);
    // An entry from the future (the wall clock stepped back) is stale, not extra fresh.
    if (hit !== undefined && now >= hit.at && now - hit.at < LOOKUP_TTL_MS) return Promise.resolve(hit.issue);
    const pending =
      pollCache.get(key) ??
      loadIssue(ref, send).then((issue) => {
        if (issue !== 'missing') cache.set(key, { at: now, issue });
        return issue;
      });
    pollCache.set(key, pending);
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

export type LinearDependencyVerdict = DependencyVerdict;

/** The Linear side of the shared walk: issues come from `lookup`, blockers from the inverse "blocks" relations already read. */
const linearAdapter = (lookup: IssueLookup): WalkAdapter<LinearDepIssue> => ({
  text: refText,
  async fetch(dep, referencedBy) {
    const issue = await lookup(dep);
    return issue === 'missing' ? { problem: `${refText(dep)} does not exist or is not readable with this token (referenced by ${refText(referencedBy)})` } : { issue };
  },
  finished: isDone,
  async blockers(dep, issue) {
    const nested = blockersOf(issue);
    return 'reason' in nested ? { waiting: `the dependencies of ${refText(dep)} could not be read: ${nested.reason}` } : nested.blockers;
  },
  judge(issue, ref) {
    if (neverCompleted(issue)) return { invalid: `${refText(ref)} was ${issue.state?.type === 'duplicate' ? 'closed as a duplicate' : 'canceled'}, so it can never be completed` };
    return isDone(issue) ? 'met' : 'open';
  },
});

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
  /** The reason this issue was already confirmed invalid by fresh reads less than a TTL ago: not read again for the same reason. */
  confirmedInvalid?: string,
): Promise<LinearDependencyVerdict> {
  const verdict = await checkOnce(task, send, now, known, lookup);
  if (verdict.status !== 'ready' && verdict.status !== 'invalid') return verdict;
  if (verdict.status === 'invalid' && verdict.reason === confirmedInvalid) return verdict;
  // A verdict that lets an issue start, or parks it for a human, is never taken from cached blockers: read them again.
  // Reads already made this poll are shared, so only cached ones cost a lookup.
  return checkOnce(task, send, now, known, (ref) => lookup(ref, true));
}

/** One pass over the issue's blockers with `lookup` (cached or fresh); the verdict is not yet confirmed. */
async function checkOnce(task: Task, send: LinearGraphql, now: Date, known: KnownIssue | undefined, lookup: IssueLookup): Promise<LinearDependencyVerdict> {
  try {
    const selfId = parseIdentifier(task.ref ?? task.id);
    if (selfId === undefined) return { status: 'invalid', reason: `${task.id} is not a Linear identifier such as DEV-12, so its dependencies cannot be checked` };
    let native = known?.nativeBlockers;
    let cycleStart = known?.cycleStart;
    if (native === undefined) {
      const own = await lookup(selfId, true);
      if (own === 'missing') return { status: 'error', reason: `${refText(selfId)} could not be read` };
      const read = blockersOf(own);
      if ('reason' in read) return { status: 'waiting', blockers: [], reason: `its dependencies could not be read: ${read.reason}` };
      native = read.blockers;
      cycleStart = own.cycle?.startsAt ?? undefined;
    }
    const start = startDate(cycleStart, task.description);
    const adapter = linearAdapter(lookup);
    const direct = dedupeRefs(adapter, [...native, ...parseLinearBodyDependencies(task.description)]);
    return await evaluateDependencies(adapter, { self: selfId, direct, start, now });
  } catch (error) {
    return lookupFailed(error);
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
  /** Last skip reason logged per issue id, with its consecutive lookup failures; defaults to a process-wide map, so a held issue logs once per reason, not once per poll. */
  logged?: Map<string, LoggedReason>;
  /** Issues read by earlier polls; defaults to a process-wide cache with a short TTL. */
  lookups?: LookupCache;
  log?: (line: string) => void;
}

const reportedComments = new Map<string, string>();
const loggedReasons = new Map<string, LoggedReason>();

interface LoggedReason {
  reason: string;
  /** Consecutive polls the lookup failed (0 for a verdict that is no error). */
  failures: number;
  /** The raw reason of an invalid verdict and when fresh reads confirmed it (ms). */
  invalid?: { reason: string; at: number };
  /** An error comment was posted for the current failure streak. */
  commented?: boolean;
  /** Last poll that listed the issue (ms); entries unlisted for `FORGET_AFTER_MS` are dropped. */
  seenAt: number;
}
/** The gate runs once per pass with different lists (triage, agent), so an issue absent from one call is not gone; only a long absence is. */
const FORGET_AFTER_MS = 10 * 60_000;
/** A lookup that keeps failing is logged again every this many polls, and reported on the issue after this many in a row. */
const LOG_EVERY = 10;
const REPORT_AFTER = 3;
const WAIT_PREFIX = 'Taskcell will not start this issue yet:';
const INVALID_PREFIX = 'Taskcell cannot start this issue:';
const ERROR_PREFIX = 'Taskcell could not check the dependencies of this issue';
/** Longest reason put into a comment: room for about 100 blockers or a long cycle path of Taskcell's own text, still bounded for author text. */
const MAX_REASON = 1000;

const RECENT_COMMENTS = 5;
/** Both ends of the connection, so the recent comments are among them whichever way Linear orders it. */
const RECENT_COMMENTS_QUERY = `query($id: String!) { issue(id: $id) { first: comments(first: ${RECENT_COMMENTS}) { nodes { body createdAt } } last: comments(last: ${RECENT_COMMENTS}) { nodes { body createdAt } } } }`;

interface CommentNodes {
  nodes?: { body?: string | null; createdAt?: string | null }[];
}

interface RecentCommentsResponse {
  data?: { issue?: { first?: CommentNodes | null; last?: CommentNodes | null } | null };
  errors?: GraphqlError[];
}

/** Letters and digits only: equal however Linear re-renders the markdown or the whitespace. */
const comparable = (text: string): string => text.replace(/[^\p{L}\p{N}]+/gu, '');

/** The comments Taskcell posts to hold an issue; only the newest of them says what the issue is held for. */
const HOLD_PREFIXES = [WAIT_PREFIX, INVALID_PREFIX, ERROR_PREFIX].map(comparable);
const isHoldComment = (body: string): boolean => {
  // Leading whitespace and emphasis are re-rendering; a quote ("> ...") or any other lead-in is a reply, not our comment.
  const text = body.replace(/^[\s*_\\]+/, '');
  if (!/^\p{L}/u.test(text)) return false;
  const flat = comparable(text);
  return HOLD_PREFIXES.some((prefix) => flat.startsWith(prefix));
};

/** Posts `body` unless the newest Taskcell hold comment on the issue already says the same, so a restart or `watch --once` does not repeat it. */
async function commentOnce(id: string, body: string, send: LinearGraphql, opts: LinearDependencyGateOptions): Promise<void> {
  const reported = opts.reported ?? reportedComments;
  const published = comparable(redactForPublish(body));
  if (reported.get(id) === published) return;
  const res = (await send({ query: RECENT_COMMENTS_QUERY, variables: { id } })) as RecentCommentsResponse;
  const issue = res.data?.issue;
  if ((res.errors ?? []).length > 0 || issue?.first?.nodes === undefined || issue.last?.nodes === undefined) throw new Error('the recent comments could not be read');
  // Oldest first by timestamp; nodes without one keep Linear's order.
  const newest = [...issue.first.nodes, ...issue.last.nodes]
    .filter((node) => isHoldComment(node.body ?? ''))
    .sort((a, b) => (a.createdAt != null && b.createdAt != null ? Number(a.createdAt > b.createdAt) - Number(a.createdAt < b.createdAt) : 0))
    .at(-1);
  await postUnlessRepeated(body, newest === undefined ? undefined : comparable(newest.body ?? ''), comparable, (text) => commentLinearIssue(id, text, opts.linear));
  reported.set(id, published);
}

/** Text the issue author controls, as inline code: it can neither mention anyone nor render markup. */
const quoted = (text: string): string => {
  const clean = text.replace(/\p{Cc}+/gu, ' ').replace(/(?![\u200c\u200d])\p{Cf}|[`@]/gu, '').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return `\`${chars.length > MAX_REASON ? `${chars.slice(0, MAX_REASON).join('').trimEnd()}…` : clean}\``;
};

/**
 * Keeps Linear issues with unmet dependencies (or a future start date) from starting. A waiting issue
 * gets one comment, is skipped this poll and stays in its trigger state, so a later poll starts it by
 * itself once the blockers are done and the date reached. A cycle, a missing reference, a canceled
 * blocker, an impossible date or an unreadable identifier gets one comment with the reason and moves
 * to the needs-info state. A failed probe or lookup is logged and the issue skipped for this poll; one
 * that fails on 3 polls in a row is also commented on (not while two or more issues fail in the same poll: a shared
 * outage), and logged again every 10. Blockers read in the last 2 minutes are reused, except that
 * an `invalid` or `ready` verdict built on them is re-checked with fresh reads.
 * Only when Linear rejects both the probe and the lookup as queries (a validation error: the gate's
 * queries do not fit the schema, which no retry fixes) are native relations not honoured, so that a
 * wrong query cannot stop every Linear watch; `Depends on` and `Start:` lines still hold.
 */
export async function applyLinearDependencyGate(tasks: Task[], opts: LinearDependencyGateOptions = {}): Promise<Task[]> {
  const log = opts.log ?? console.log;
  const logged = opts.logged ?? loggedReasons;
  const reported = opts.reported ?? reportedComments;
  const lookups = opts.lookups ?? lookupCache;
  const now = opts.now ?? new Date();
  const at = now.getTime();
  const listed = new Set(tasks.map((task) => task.id));
  for (const [id, entry] of logged) {
    // An issue in this list is never forgotten: a long tick or --interval must not reset its dedupe or failure count.
    if (listed.has(id) || at - entry.seenAt <= FORGET_AFTER_MS) continue;
    logged.delete(id);
    reported.delete(id);
  }
  for (const [key, entry] of lookups) if (at < entry.at || at - entry.at >= LOOKUP_TTL_MS) lookups.delete(key);
  if (tasks.length === 0) return tasks;
  const send = opts.graphql ?? (await linearGraphql(opts.linear));
  const refs = new Map(tasks.map((task) => [task, parseIdentifier(task.ref ?? task.id)]));
  const probed = await probe([...refs.values()].filter((ref): ref is TaskRef => ref !== undefined), send, log);
  const lookup = createIssueLookup(send, lookups, at);
  const first = probed.rejected[0];
  if (first !== undefined) {
    // The lookup is one query for every issue: rejected for one, it is rejected for all.
    const lookupRejection = await lookup(first).then(() => undefined, (error: unknown) => (error instanceof QueryRejected ? failureReason(error) : undefined));
    if (lookupRejection !== undefined) {
      log(`taskcell: Linear rejected the dependency queries, native "blocked by" relations and cycles of ${probed.rejected.length} issue(s) not honoured this poll (Depends on and Start lines still are) -> ${probed.rejection ?? ''}; ${lookupRejection}`);
      for (const ref of probed.rejected) probed.known.set(refText(ref), { nativeBlockers: [] });
    }
  }
  const confirmedFor = (task: Task): string | undefined => {
    const invalid = logged.get(task.id)?.invalid;
    return invalid !== undefined && at >= invalid.at && at - invalid.at < LOOKUP_TTL_MS ? invalid.reason : undefined;
  };
  const checkTask = (task: Task): Promise<LinearDependencyVerdict> => {
    const ref = refs.get(task);
    return checkLinearDependencies(task, send, now, ref !== undefined ? probed.known.get(refText(ref)) : undefined, lookup, confirmedFor(task));
  };
  return runDependencyGate(tasks, {
    check: checkTask,
    async release(task, verdict) {
      reported.delete(task.id);
      logged.delete(task.id);
      return { ...task, dependsOn: verdict.dependsOn };
    },
    async hold(task, verdict, all) {
      if (verdict.status === 'ready') return;
      // Two or more issues whose lookup threw in the same poll is a shared outage (Linear or the network), not something about each issue: no comment yet.
      const sharedOutage = all.filter((v) => v.status === 'error' && v.reason.startsWith('dependency lookup failed')).length > 1;
      // Once per reason, not once per poll; the reason holds author text, so control characters are dropped.
      const reason = `${escalatesToNeedsInfo(verdict) ? 'needs info: ' : ''}${verdict.reason}`.replace(/\p{Cc}+/gu, ' ');
      const previous = logged.get(task.id);
      const failed = verdict.status === 'error' ? (previous?.failures ?? 0) + 1 : 0;
      if (previous?.reason !== reason || (failed > 0 && failed % LOG_EVERY === 0)) log(`taskcell: ${task.id} skipped -> ${reason}`);
      const invalid = verdict.status === 'invalid' ? { reason: verdict.reason, at: previous?.invalid?.reason === verdict.reason && confirmedFor(task) !== undefined ? previous.invalid.at : at } : undefined;
      const entry: LoggedReason = { reason, failures: failed, seenAt: at, ...(invalid !== undefined ? { invalid } : {}), ...(failed > 0 && previous?.commented === true ? { commented: true } : {}) };
      logged.set(task.id, entry);
      try {
        if (verdict.status === 'error') {
          // The comment names no reason (it may change every poll), so one comment covers the whole outage; retried only every LOG_EVERY polls.
          if (sharedOutage || failed < REPORT_AFTER || (entry.commented === true && failed % LOG_EVERY !== 0)) return;
          entry.commented = true;
          await commentOnce(task.id, `${ERROR_PREFIX} on repeated polls: Linear could not be read. It stays in its trigger state and is checked again on every poll.`, send, opts);
        } else if (verdict.status === 'waiting') {
          await commentOnce(task.id, `${WAIT_PREFIX} ${quoted(verdict.reason)}. It stays in its trigger state and starts by itself once that is resolved.`, send, opts);
        } else {
          const next = opts.moveToNeedsInfo !== undefined ? 'Fix it and move it back to its trigger state.' : 'It stays in its trigger state and is checked again once it is fixed.';
          await commentOnce(task.id, `${INVALID_PREFIX} ${quoted(verdict.reason)}. ${next}`, send, opts);
          if (opts.moveToNeedsInfo !== undefined) {
            await opts.moveToNeedsInfo(task.id);
            // It left the trigger state: if it comes back unfixed it is logged and moved again; the comment is not repeated while it is still the newest hold comment.
            logged.delete(task.id);
            reported.delete(task.id);
          }
        }
      } catch (error) {
        log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
      }
    },
  });
}
