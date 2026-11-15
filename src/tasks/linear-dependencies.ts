import { failureReason } from '../core/errors.js';
import { fanOut } from '../pipeline/fan-out.js';
import { directiveLines, parseStartDate } from './dependencies.js';
import { commentLinearIssueOnce, LinearGraphqlRequestError, linearGraphql, parseIdentifier } from './linear-cli.js';
import type { StartDate } from './dependencies.js';
import type { Task, TaskRef } from './fetcher.js';
import type { LinearCliRunner, LinearGraphql } from './linear-cli.js';

const MAX_NODES = 50;
const MAX_RELATION_PAGES = 100;
const CHECK_CONCURRENCY = 4;

/** A Linear identifier `DEV-12` as a ref: the team key is the `repo`, the issue number the `number`. */
const refText = (ref: TaskRef): string => `${ref.repo.toUpperCase()}-${ref.number}`;
const keyOf = (ref: TaskRef): string => refText(ref);
const same = (a: TaskRef, b: TaskRef): boolean => keyOf(a) === keyOf(b);
const dedupe = (refs: TaskRef[]): TaskRef[] => refs.filter((ref, i) => refs.findIndex((other) => same(other, ref)) === i);
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** `DEV-12` or a Linear issue URL (`https://linear.app/team/issue/DEV-12/slug`). */
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

interface LinearDepIssue {
  identifier?: string;
  state?: { type?: string } | null;
  cycle?: { startsAt?: string | null } | null;
  /** Relations pointing at this issue; type `blocks` means `issue` blocks this one. */
  inverseRelations?: { nodes?: Array<LinearRelation | null> } | null;
}

interface LinearRelation {
  type?: string;
  issue?: { identifier?: string } | null;
}

const ISSUE_QUERY = `query($id: String!, $after: String) { issue(id: $id) { identifier state { type } cycle { startsAt } inverseRelations(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { type issue { identifier } } } } }`;

interface IssueResponse {
  data?: { issue?: (LinearDepIssue & { inverseRelations?: { pageInfo?: PageInfo; nodes?: Array<LinearRelation | null> } | null }) | null };
  errors?: { message?: string }[];
}

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

const ISSUE_NOT_FOUND = /(?:\bentity not found:\s*issue\b|\bissue\b[^\n]*\bdoes not exist\b)/i;
type IssueLookup = (ref: TaskRef) => Promise<LinearDepIssue | 'missing'>;

const issueErrors = (response: IssueResponse): Array<{ message?: string }> => response.errors ?? [];

function missingFrom(errors: Array<{ message?: string }>): boolean {
  return errors.length > 0 && errors.every((error) => ISSUE_NOT_FOUND.test(error.message ?? ''));
}

async function loadIssue(ref: TaskRef, send: LinearGraphql): Promise<LinearDepIssue | 'missing'> {
  const relations: Array<LinearRelation | null> = [];
  let after: string | undefined;
  let issue: LinearDepIssue | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_RELATION_PAGES) throw new Error(`Linear issue ${refText(ref)} exceeded ${MAX_RELATION_PAGES} relation pages`);
    let response: IssueResponse;
    try {
      response = (await send({ query: ISSUE_QUERY, variables: { id: refText(ref), ...(after !== undefined ? { after } : {}) } })) as IssueResponse;
    } catch (error) {
      if (error instanceof LinearGraphqlRequestError && missingFrom(error.errors)) return 'missing';
      throw error;
    }
    const errors = issueErrors(response);
    if (missingFrom(errors)) return 'missing';
    if (errors.length > 0) throw new Error(`Linear API error: ${errors.map((error) => error.message ?? '').join('; ')}`);
    const pageIssue = response.data?.issue;
    if (pageIssue === undefined || pageIssue === null) return 'missing';
    issue ??= pageIssue;
    const connection = pageIssue.inverseRelations;
    if (connection === undefined || connection === null) return issue;
    relations.push(...(connection.nodes ?? []));
    const pageInfo = connection.pageInfo;
    if (pageInfo?.hasNextPage !== true) return { ...issue, inverseRelations: { nodes: relations } };
    const next = pageInfo.endCursor;
    if (next === undefined || next === null || next === after) throw new Error(`Linear relation pagination did not advance for ${refText(ref)}`);
    after = next;
  }
}

function createIssueLookup(send: LinearGraphql): IssueLookup {
  const cache = new Map<string, Promise<LinearDepIssue | 'missing'>>();
  return (ref) => {
    const key = keyOf(ref);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const pending = loadIssue(ref, send);
    cache.set(key, pending);
    return pending;
  };
}

type BlockerResult = { blockers: TaskRef[] } | { reason: string };

/** Issues that block `issue` through native "blocked by" relations. */
function blockersOf(issue: LinearDepIssue): BlockerResult {
  const connection = issue.inverseRelations;
  if (connection === undefined || connection === null) return { reason: 'Linear returned no inverse-relation data' };
  const blockers: TaskRef[] = [];
  for (const relation of connection.nodes ?? []) {
    if (relation === null) return { reason: 'Linear returned a null inverse relation' };
    if (relation.type !== 'blocks') continue;
    const identifier = relation.issue?.identifier;
    const ref = identifier === undefined ? undefined : parseIdentifier(identifier);
    if (ref === undefined) return { reason: `Linear returned an unreadable blocked-by relation${identifier === undefined ? '' : ` (${identifier})`}` };
    blockers.push(ref);
  }
  return { blockers };
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
type WalkResult = { invalid: string } | { waiting: string } | { direct: Map<string, LinearDepIssue> };

async function walk(self: TaskRef, direct: TaskRef[], lookup: IssueLookup): Promise<WalkResult> {
  const fetched = new Map<string, LinearDepIssue>();
  const seen = new Set<string>();
  let visited = 0;
  const visit = async (ref: TaskRef, refs: TaskRef[], path: TaskRef[]): Promise<{ invalid: string } | { waiting: string } | undefined> => {
    for (const dep of refs) {
      if (path.some((p) => same(p, dep))) return { invalid: `dependency cycle: ${[...path, dep].map(refText).join(' → ')}` };
      const key = keyOf(dep);
      if (ref !== self && seen.has(key)) continue;
      if (++visited > MAX_NODES) return { invalid: `dependency chain too large (more than ${MAX_NODES} issues)` };
      const issue = fetched.get(key) ?? (await lookup(dep));
      if (issue === 'missing') return { invalid: `${refText(dep)} does not exist or is not readable with this token (referenced by ${refText(ref)})` };
      if (ref === self) fetched.set(key, issue);
      seen.add(key);
      if (isDone(issue)) continue;
      const nested = blockersOf(issue);
      if ('reason' in nested) return { waiting: `${refText(dep)} dependency relations could not be read: ${nested.reason}` };
      const problem = await visit(dep, nested.blockers, [...path, dep]);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const problem = await visit(self, direct, [self]);
  return problem ?? { direct: fetched };
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
  lookup: IssueLookup = createIssueLookup(send),
): Promise<LinearDependencyVerdict> {
  try {
    const selfId = parseIdentifier(task.ref ?? task.id);
    if (selfId === undefined) return { status: 'invalid', reason: `${task.id} is not a Linear identifier` };
    // `known`: the probe found no blocker and no cycle, so the issue itself needs no lookup.
    let native = known?.nativeBlockers;
    let cycleStart: string | undefined;
    if (native === undefined) {
      const own = await lookup(selfId);
      if (own === 'missing') return { status: 'error', reason: `${refText(selfId)} could not be read` };
      const nativeResult = blockersOf(own);
      if ('reason' in nativeResult) return { status: 'waiting', blockers: [], reason: nativeResult.reason };
      native = nativeResult.blockers;
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

/** Inspect enough relation and cycle metadata to avoid an issue lookup when both are definitely clear. */
const PROBE_QUERY = `query($f: IssueFilter, $first: Int!) { issues(first: $first, filter: $f) { nodes { identifier cycle { startsAt } inverseRelations(first: 1) { pageInfo { hasNextPage endCursor } nodes { type issue { identifier } } } } } }`;
/** Identifiers only, so a probe page stays far under Linear's per-query complexity cap. */
const PROBE_BATCH = 50;

interface ProbeResponse {
  data?: { issues?: { nodes?: Array<LinearDepIssue & { inverseRelations?: { pageInfo?: PageInfo; nodes?: Array<LinearRelation | null> } | null }> } | null };
  errors?: { message?: string }[];
}

interface ProbeResult {
  needsLookup: Set<string>;
  failed: Set<string>;
}

/**
 * Keys of the `refs` that have a native "blocked by" relation, a future cycle, or incomplete probe
 * data. A failed batch is held for this poll instead of expanding into one lookup per listed issue.
 */
async function probeNeedsLookup(refs: TaskRef[], send: LinearGraphql, now: Date, log: (line: string) => void): Promise<ProbeResult> {
  const needsLookup = new Set<string>();
  const failed = new Set<string>();
  for (let i = 0; i < refs.length; i += PROBE_BATCH) {
    const batch = refs.slice(i, i + PROBE_BATCH);
    const byTeam = new Map<string, number[]>();
    for (const ref of batch) {
      const team = ref.repo.toUpperCase();
      byTeam.set(team, [...(byTeam.get(team) ?? []), ref.number]);
    }
    const f = { or: [...byTeam].map(([team, numbers]) => ({ team: { key: { eq: team } }, number: { in: numbers } })) };
    try {
      const res = (await send({ query: PROBE_QUERY, variables: { f, first: batch.length } })) as ProbeResponse;
      const nodes = res.data?.issues?.nodes;
      const errors = res.errors ?? [];
      if (errors.length > 0) throw new Error(errors.map((error) => error.message ?? '').join('; '));
      if (nodes === undefined) throw new Error('Linear API returned no probe connection');
      const answered = new Set<string>();
      for (const node of nodes) {
        const ref = parseIdentifier(node.identifier ?? '');
        if (ref === undefined) continue;
        const key = keyOf(ref);
        answered.add(key);
        const cycleStart = node.cycle?.startsAt;
        const cycleDate = cycleStart == null ? undefined : new Date(cycleStart);
        const relations = node.inverseRelations;
        const uncertainRelations = relations == null || relations.nodes === undefined || relations.pageInfo === undefined
          || relations.nodes.some((relation) => relation === null || relation.type === 'blocks')
          || relations.pageInfo.hasNextPage === true;
        const uncertainCycle = cycleDate !== undefined && Number.isNaN(cycleDate.getTime());
        if (uncertainRelations || uncertainCycle || (cycleDate !== undefined && cycleDate.getTime() > now.getTime())) needsLookup.add(key);
      }
      for (const ref of batch) if (!answered.has(keyOf(ref))) needsLookup.add(keyOf(ref));
    } catch (error) {
      log(`taskcell: Linear dependency probe failed; ${batch.length} issue(s) held this poll -> ${failureReason(error)}`);
      for (const ref of batch) failed.add(keyOf(ref));
    }
  }
  return { needsLookup, failed };
}

export interface LinearDependencyGateOptions {
  /** Moves an invalid issue here (e.g. 'Needs Info'), out of the trigger state; absent: only logged. */
  moveToNeedsInfo?: (id: string) => Promise<void>;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
  now?: Date;
  log?: (line: string) => void;
}

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
  const now = opts.now ?? new Date();
  const refs = new Map(tasks.map((task) => [task, parseIdentifier(task.ref ?? task.id)]));
  const probe = await probeNeedsLookup([...refs.values()].filter((ref): ref is TaskRef => ref !== undefined), send, now, log);
  const lookup = createIssueLookup(send);
  const known = (task: Task): { nativeBlockers: TaskRef[] } | undefined => {
    const ref = refs.get(task);
    return ref !== undefined && !probe.needsLookup.has(keyOf(ref)) ? { nativeBlockers: [] } : undefined;
  };
  const checked = await fanOut(tasks, (task) => {
    const ref = refs.get(task);
    return ref !== undefined && probe.failed.has(keyOf(ref))
      ? Promise.resolve<LinearDependencyVerdict>({ status: 'error', reason: 'dependency probe failed for this issue' })
      : checkLinearDependencies(task, send, now, known(task), lookup);
  }, { concurrency: CHECK_CONCURRENCY });
  const ready: Task[] = [];
  for (const outcome of checked) {
    const task = outcome.item;
    const verdict: LinearDependencyVerdict = outcome.status === 'fulfilled' ? outcome.value : { status: 'error', reason: failureReason(outcome.reason) };
    if (verdict.status === 'ready') {
      ready.push({ ...task, dependsOn: verdict.dependsOn });
      continue;
    }
    if (verdict.status === 'error') {
      log(`taskcell: ${task.id} skipped -> ${verdict.reason}`);
      continue;
    }
    log(`taskcell: ${task.id} skipped -> ${verdict.status === 'invalid' ? 'needs info: ' : ''}${verdict.reason}`);
    try {
      if (verdict.status === 'waiting') {
        await commentLinearIssueOnce(
          task.id,
          `Taskcell will not start this issue yet: ${quoted(verdict.reason)}. It stays in its trigger state and is checked again on the next poll.`,
          opts.linear,
        );
        continue;
      }
      await commentLinearIssueOnce(task.id, `Taskcell cannot start this issue: ${quoted(verdict.reason)}. Fix it and move it back to its trigger state.`, opts.linear);
      await opts.moveToNeedsInfo?.(task.id);
    } catch (error) {
      log(`taskcell: ${task.id} dependency hold could not be recorded: ${failureReason(error)}`);
    }
  }
  return ready;
}
