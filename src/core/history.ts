// Per-issue history: a read model over the audit streams (docs/audit.md), joined by subject (repo,
// issue, PR, run), plus the run records and the Git host's own events where no stream has a record
// (a human applying a label). It copies nothing: every call reads the sources and builds the list.
// `buildIssueHistory` is pure; `readIssueHistory` does the reading.
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { branchAdapter, localAdapter, verifyFiles, type AuditActor, type AuditFile } from './audit.js';
import { DECISIONS_FILE } from '../approver/ledger.js';
import { readRunRecords, listRuns, runsRoot } from './run-store.js';
import { fetchTimeline, parsePrUrl } from './lead-time-github.js';
import { resolveTaskRef } from '../tasks/board.js';
import { defaultGhRunner, type GhRunner } from '../tasks/github.js';
import { detectRepoSlug } from '../runners/github.js';
import { stateDir } from './state-path.js';
import { parseJsonlLines } from './stats.js';
import type { ChainStatus, HistoryChain, HistoryEntry, HistoryKind, IssueHistory } from '../wire.js';

export type { ChainStatus, HistoryChain, HistoryEntry, HistoryKind, IssueHistory };

/** One chain: a stream, or one run's event log. */
export interface ChainUnit {
  stream: string;
  name: string;
  files: AuditFile[];
}

/** An event of the Git host (GitHub timeline) with no record in any stream. */
export interface HostEvent {
  time: string;
  kind: HistoryKind;
  actor?: AuditActor;
  what: string;
  url?: string;
  id: string;
}

export interface HistoryInput {
  repo: string;
  issue: number;
  /** Other names the audit subject's `repo` may carry (the hub records a project path). */
  repoAliases?: string[];
  units: ChainUnit[];
  runs: HistoryRun[];
  host: HostEvent[];
  unavailable?: string[];
}

/** One run of this issue as the run records show it. */
export interface HistoryRun {
  taskId: string;
  timestamp: string;
  prUrl?: string;
  ciUrl?: string;
  startedBy?: string;
  anyFailed: boolean;
  stages: { name: string; verdict?: string; timestamp: string }[];
}

const RUN_END = new Set(['run-end', 'run-error', 'run-cancelled']);

/** A repo slug sanitised the way the runners build task ids (`o/r` -> `o-r`). */
const slugId = (repo: string): string => repo.replace(/[^a-zA-Z0-9]/g, '-');

/** The number after `prefix` (case-insensitive) when `taskId` is exactly `<prefix><N>`. */
function numberAfter(taskId: string, prefix: string): number | undefined {
  const rest = taskId.toLowerCase().startsWith(prefix.toLowerCase()) ? taskId.slice(prefix.length) : '';
  return /^\d+$/.test(rest) ? Number(rest) : undefined;
}

/**
 * The issue a run record belongs to: `gh-owner-repo-904` -> 904, and `repo`'s spec run
 * (`spec-<sanitised slug>-904`, lowercased by src/runners/spec.ts) -> 904.
 * PR review and revise runs belong to a PR, not an issue: see {@link prRunOf}.
 */
export function issueOfTaskId(taskId: string, repo: string): number | undefined {
  const spec = numberAfter(taskId, `spec-${slugId(repo)}-`);
  if (spec !== undefined) return spec;
  const ref = resolveTaskRef(taskId);
  return ref !== undefined && ref.source !== 'linear' ? Number(ref.reference) : undefined;
}

/**
 * `pr-review-o-r-9` (src/cli/review-pr.ts) or `revise-pr-o-r-9` (src/runners/revise-pr.ts) -> the PR number
 * when the slug is `repo`'s, sanitised the way those runners do.
 */
export function prRunOf(taskId: string, repo: string): number | undefined {
  const slug = slugId(repo);
  return numberAfter(taskId, `pr-review-${slug}-`) ?? numberAfter(taskId, `revise-pr-${slug}-`);
}

/** The PR number of a pull request URL of `repo`; undefined for any other address. */
export function prNumberOf(url: string | undefined, repo: string): number | undefined {
  const pr = url === undefined ? undefined : parsePrUrl(url);
  return pr?.repoSlug === repo ? pr.number : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function actorOf(v: unknown): AuditActor | undefined {
  const a = obj(v);
  const kind = a.kind;
  if (kind !== 'user' && kind !== 'local' && kind !== 'token' && kind !== 'bot') return undefined;
  return { kind, ...(str(a.id) !== undefined ? { id: str(a.id)! } : {}), ...(str(a.name) !== undefined ? { name: str(a.name)! } : {}) };
}

interface Line {
  rec: Record<string, unknown>;
  ref: string;
}

/** Parsed lines with their file:line ref (the line number counts blank and torn lines, as `audit verify` reports it). */
function linesOf(unit: ChainUnit): Line[] {
  const out: Line[] = [];
  for (const f of unit.files) {
    f.text.split('\n').forEach((raw, i) => {
      if (raw.trim() === '') return;
      const [rec] = parseJsonlLines(raw);
      if (rec !== undefined) out.push({ rec, ref: `${basename(f.name)}:${i + 1}` });
    });
  }
  return out;
}

const timeOf = (r: Record<string, unknown>): string => str(r.ts) ?? str(r.time) ?? str(r.timestamp) ?? '';

/** The history of one issue. Entries are oldest first; ties keep source order. */
export function buildIssueHistory(input: HistoryInput): IssueHistory {
  const { repo, issue } = input;
  const repos = new Set([repo, ...(input.repoAliases ?? [])]);
  const prs = new Set<number>();
  for (const run of input.runs) {
    const n = prNumberOf(run.prUrl, repo);
    if (n !== undefined) prs.add(n);
  }
  for (const h of input.host) {
    const m = /^pr#(\d+)/.exec(h.id);
    if (m) prs.add(Number(m[1]));
  }

  // Run ids of this issue: the run-event logs are per task, so every runId in one of this issue's logs is its.
  const runIds = new Set<string>();
  const chains: ChainStatus[] = [];
  const verified = new Map<ChainUnit, boolean>();
  for (const unit of input.units) {
    const v = verifyFiles(unit.files);
    chains.push({ stream: unit.stream, name: unit.name, ok: v.ok, records: v.records, legacy: v.legacy, torn: v.torn, problems: v.problems });
    verified.set(unit, v.ok);
    if (unit.stream === 'run-events') {
      for (const { rec } of linesOf(unit)) {
        const id = str(obj(rec.subject).runId);
        if (id !== undefined) runIds.add(id);
      }
    }
  }

  const entries: HistoryEntry[] = [];
  const add = (e: HistoryEntry): void => void entries.push(e);

  for (const unit of input.units) {
    const ok = verified.get(unit)!;
    for (const { rec, ref } of linesOf(unit)) {
      const subject = obj(rec.subject);
      const actor = actorOf(rec.actor);
      // Only a hashed line of a chain that verifies is `verified`; a legacy line the chain tolerates is not.
      const chain: HistoryChain = !ok ? 'failed' : typeof rec.hash === 'string' ? 'verified' : 'none';
      const base = { ...(actor !== undefined ? { actor } : {}), chain };
      if (unit.stream === 'run-events') {
        const data = obj(obj(rec.data).event);
        const type = str(data.type);
        const time = timeOf(rec);
        const source = { stream: 'run-events', ref };
        if (type === 'run-start') add({ ...base, time, kind: 'run-start', what: `run started (${str(data.flow) ?? 'flow'}, ${str(data.provider) ?? 'provider'})`, source });
        else if (type === 'stage-start') add({ ...base, time, kind: 'stage', what: `stage ${str(data.name) ?? '?'} started`, source });
        else if (type === 'stage-end') add({ ...base, time, kind: 'stage', what: `stage ${str(data.name) ?? '?'} ended: ${str(data.outcome) ?? '?'}`, source });
        else if (type !== undefined && RUN_END.has(type)) {
          const pr = str(data.prUrl);
          const what = type === 'run-end' ? `run finished${pr !== undefined ? `, opened ${pr}` : ''}` : type === 'run-cancelled' ? 'run cancelled' : `run failed: ${str(data.message) ?? 'error'}`;
          add({ ...base, time, kind: 'run-end', what, source: { ...source, ...(pr !== undefined ? { url: pr } : {}) } });
        }
        continue;
      }
      const subjectRepo = str(subject.repo);
      const inRepo = subjectRepo === undefined || repos.has(subjectRepo);
      const sameIssue = num(subject.issue) === issue && inRepo;
      const samePr = num(subject.pr) !== undefined && prs.has(num(subject.pr)!) && inRepo;
      const sameRun = str(subject.runId) !== undefined && runIds.has(str(subject.runId)!);
      if (!sameIssue && !samePr && !sameRun) continue;
      if (unit.stream === 'decisions') {
        const rules = Array.isArray(rec.rulesFired) ? (rec.rulesFired as unknown[]).filter((r): r is string => typeof r === 'string') : [];
        add({ ...base, time: timeOf(rec), kind: 'approver', what: `approver ${str(rec.verdict) ?? '?'} (${str(rec.mode) ?? '?'})${rules.length > 0 ? `: ${rules.join(', ')}` : ''}`, source: { stream: 'decisions', ref } });
      } else {
        add({ ...base, time: timeOf(rec), kind: 'hub', what: `${str(rec.action) ?? 'action'} ${str(rec.outcome) ?? ''}`.trim(), source: { stream: unit.stream, ref } });
      }
    }
  }

  // Run records have no chain. A run that reuses an earlier run's PR is a revise round. A hub run already has
  // its start and end in the run-event log, so its record only adds the revision and the verdicts.
  const logged = new Set(input.units.filter((u) => u.stream === 'run-events').map((u) => u.name.split('/')[0]));
  const seenPrs = new Set<string>();
  const botActor: AuditActor = { kind: 'bot', name: 'taskcell[bot]' };
  const byTime = [...input.runs].sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));
  for (const run of byTime) {
    const ref = `${run.taskId}/${run.timestamp}`;
    const actor: AuditActor =
      run.startedBy === 'token' ? { kind: 'token', name: 'token' } : run.startedBy !== undefined ? { kind: 'user', name: run.startedBy } : run.ciUrl !== undefined ? botActor : { kind: 'local' };
    const source = { stream: 'run-record', ref, ...(run.prUrl !== undefined ? { url: run.prUrl } : run.ciUrl !== undefined ? { url: run.ciUrl } : {}) };
    const revision = /^revise-pr-/i.test(run.taskId) || (run.prUrl !== undefined && seenPrs.has(run.prUrl)) || run.stages.some((s) => /revis/i.test(s.name));
    if (run.prUrl !== undefined) seenPrs.add(run.prUrl);
    const spec = /^spec-/i.test(run.taskId);
    const label = revision ? 'revise round' : spec ? 'spec run' : /^pr-review-/.test(run.taskId) ? 'PR review run' : 'run';
    if (revision || !logged.has(run.taskId)) {
      add({ time: run.timestamp, kind: revision ? 'revision' : spec ? 'spec' : 'run-end', actor, chain: 'none', source, what: `${label} recorded: ${run.anyFailed ? 'failed' : 'passed'} (${run.stages.map((s) => s.name).join(', ')})` });
    }
    for (const st of run.stages) {
      if (st.verdict === undefined) continue;
      add({ time: st.timestamp, kind: 'review', actor: botActor, chain: 'none', source: { ...source, ref: `${ref}#${st.name}` }, what: `${st.name} verdict: ${st.verdict}` });
    }
  }

  for (const h of input.host) {
    add({ time: h.time, kind: h.kind, ...(h.actor !== undefined ? { actor: h.actor } : {}), what: h.what, chain: 'none', source: { stream: 'github', ref: h.id, ...(h.url !== undefined ? { url: h.url } : {}) } });
  }

  const order = entries.map((e, i) => ({ e, i }));
  order.sort((a, b) => (Date.parse(a.e.time) || 0) - (Date.parse(b.e.time) || 0) || a.i - b.i);
  return { repo, issue, prs: [...prs].sort((a, b) => a - b), entries: order.map((o) => o.e), chains, unavailable: input.unavailable ?? [] };
}

// ---- Git host events ----------------------------------------------------------------------------

const BOT_LOGIN = /\[bot\]$/;
const hostActor = (login: string | undefined): AuditActor | undefined =>
  login === undefined ? undefined : BOT_LOGIN.test(login) ? { kind: 'bot', name: login } : { kind: 'user', name: login };

const urlOf = (v: unknown): { url?: string } => (str(v) !== undefined ? { url: str(v)! } : {});

/** The factory's spec comment opens with its title; a passing mention of "tech spec" in any comment is not one. */
const SPEC_COMMENT = /^\W*(?:vanguard|taskcell)\s+tech spec/i;

/**
 * GitHub timeline items (`gh api issues/N/timeline`) -> host events. `idPrefix` is `issue#N` or `pr#N`.
 * A cross-reference counts as this issue's PR only when the pull request is in `repo`.
 */
export function githubTimelineEvents(items: readonly unknown[], idPrefix: string, repo: string): HostEvent[] {
  const out: HostEvent[] = [];
  for (const raw of items) {
    const it = obj(raw);
    const event = str(it.event);
    const time = str(it.created_at) ?? str(it.submitted_at) ?? str(it.updated_at);
    const login = str(obj(it.actor).login) ?? str(obj(it.user).login);
    const actor = hostActor(login);
    if (event === undefined || time === undefined) continue;
    const id = `${idPrefix}:${str(it.id) ?? String(num(it.id) ?? time)}`;
    const base = { time, id, ...(actor !== undefined ? { actor } : {}) };
    if (event === 'labeled' || event === 'unlabeled') out.push({ ...base, kind: 'label', what: `label "${str(obj(it.label).name) ?? '?'}" ${event === 'labeled' ? 'applied' : 'removed'}` });
    else if (event === 'reviewed') out.push({ ...base, kind: 'review', what: `review ${(str(it.state) ?? 'commented').toLowerCase()}`, ...urlOf(it.html_url) });
    else if (event === 'commented') {
      const spec = actor?.kind === 'bot' && SPEC_COMMENT.test(str(it.body) ?? '');
      out.push({ ...base, kind: spec ? 'spec' : 'comment', what: spec ? 'tech spec posted' : 'commented', ...urlOf(it.html_url) });
    } else if (event === 'merged') out.push({ ...base, kind: 'merge', what: 'merged' });
    else if (event === 'closed') out.push({ ...base, kind: 'close', what: 'closed' });
    else if (event === 'reopened') out.push({ ...base, kind: 'close', what: 'reopened' });
    else if (event === 'cross-referenced') {
      const src = obj(obj(it.source).issue);
      const n = num(src.number);
      if (n !== undefined && src.pull_request !== undefined && prNumberOf(str(src.html_url), repo) === n) {
        out.push({ ...base, id: `pr#${n}:${id}`, kind: 'comment', what: `pull request #${n} referenced this issue`, ...urlOf(src.html_url) });
      }
    }
  }
  return out;
}

/** The issue's timeline, then each PR's (`knownPrs` plus those the issue timeline names). A failure comes back as an unavailable source, never a throw. */
export async function fetchGithubHostEvents(repo: string, issue: number, knownPrs: readonly number[], gh: GhRunner = defaultGhRunner): Promise<{ events: HostEvent[]; unavailable: string[] }> {
  const events: HostEvent[] = [];
  const unavailable: string[] = [];
  const queue = new Set(knownPrs);
  try {
    events.push(...githubTimelineEvents(await fetchTimeline(repo, issue, gh), `issue#${issue}`, repo));
  } catch {
    return { events, unavailable: ['github'] };
  }
  for (const e of events) {
    const m = /^pr#(\d+)/.exec(e.id);
    if (m) queue.add(Number(m[1]));
  }
  for (const pr of queue) {
    try {
      events.push(...githubTimelineEvents(await fetchTimeline(repo, pr, gh), `pr#${pr}`, repo));
    } catch {
      unavailable.push(`github PR #${pr}`);
    }
  }
  return { events, unavailable };
}

// ---- reading the sources -------------------------------------------------------------------------

export interface ReadHistoryOptions {
  repoPath: string;
  /** `owner/repo`. */
  repo: string;
  issue: number;
  /** The hub config dir holding `audit.jsonl`; omitted = no hub stream. */
  hubConfigDir?: string;
  branch?: string;
  /** Skip the Git host (offline). */
  offline?: boolean;
  gh?: GhRunner;
  /** The checkout's own `owner/repo`; default: from its origin. A different one means the local sources are not this repo's. */
  localRepo?: string;
}

/** The issue's runs and its spec runs, then the review and revise runs of the PRs those opened. */
async function runSources(repoPath: string, repo: string, issue: number): Promise<{ runs: HistoryRun[]; taskIds: string[] }> {
  const root = runsRoot(repoPath);
  const all = await listRuns(root);
  const own = all.filter((s) => issueOfTaskId(s.taskId, repo) === issue);
  const prs = new Set(own.map((s) => prNumberOf(s.prUrl, repo)).filter((n): n is number => n !== undefined));
  const summaries = [...own, ...all.filter((s) => prs.has(prRunOf(s.taskId, repo) ?? -1))];
  const runs: HistoryRun[] = [];
  for (const s of summaries) {
    const detail = await readRunRecords(root, s.taskId, s.timestamp).catch(() => undefined);
    runs.push({
      taskId: s.taskId,
      timestamp: s.timestamp,
      anyFailed: s.anyFailed,
      ...(s.prUrl !== undefined ? { prUrl: s.prUrl } : {}),
      ...(s.ciUrl !== undefined ? { ciUrl: s.ciUrl } : {}),
      ...(s.startedBy !== undefined ? { startedBy: s.startedBy } : {}),
      stages: (detail?.stages ?? []).map((d) => ({
        name: d.record.stage ?? 'run',
        timestamp: d.record.timestamp,
        ...(d.record.verdict !== undefined ? { verdict: d.record.verdict } : {}),
      })),
    });
  }
  return { runs, taskIds: [...new Set(summaries.map((s) => s.taskId))] };
}

/** Read every source for `repo#issue` and build its history. A source that cannot be read is listed in `unavailable`. */
export async function readIssueHistory(opts: ReadHistoryOptions): Promise<IssueHistory> {
  const unavailable: string[] = [];
  const units: ChainUnit[] = [];
  const guard = async (name: string, read: () => Promise<AuditFile[]>): Promise<AuditFile[]> => {
    try {
      return await read();
    } catch {
      unavailable.push(name);
      return [];
    }
  };
  // Run records, run-event logs and the decisions branch are this checkout's: they are only this issue's
  // when the checkout is the repo asked about.
  const local = opts.localRepo ?? (await detectRepoSlug(opts.repoPath).catch(() => undefined));
  let runs: HistoryRun[] = [];
  if (local !== undefined && local !== opts.repo) {
    unavailable.push(`local records (this checkout is ${local}, not ${opts.repo})`);
  } else {
    const found = await runSources(opts.repoPath, opts.repo, opts.issue).catch(() => {
      unavailable.push('run records');
      return { runs: [] as HistoryRun[], taskIds: [] as string[] };
    });
    runs = found.runs;
    for (const taskId of found.taskIds) {
      const dir = join(stateDir(opts.repoPath), 'runs', taskId);
      for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
        if (!f.startsWith('events-') || !f.endsWith('.jsonl')) continue;
        const files = await guard(`run-events ${taskId}`, () => localAdapter({ file: join(dir, f), repoPath: opts.repoPath }).files());
        units.push({ stream: 'run-events', name: `${taskId}/${f}`, files });
      }
    }
    const decisions = await guard('decisions', () => branchAdapter(opts.repoPath, { ...(opts.branch !== undefined ? { branch: opts.branch } : {}), file: DECISIONS_FILE }).files());
    if (decisions.some((f) => f.text !== '')) units.push({ stream: 'decisions', name: 'decisions', files: decisions });
    // Hub lines reach an issue only through a run id of one of its run-event logs, so with none the (large) log is not read.
    if (opts.hubConfigDir !== undefined && units.some((u) => u.stream === 'run-events')) {
      const files = await guard('hub', () => localAdapter({ file: join(opts.hubConfigDir!, 'audit.jsonl') }).files());
      if (files.some((f) => f.text !== '')) units.push({ stream: 'hub', name: 'hub', files });
    }
  }

  let host: HostEvent[] = [];
  if (opts.offline !== true) {
    const prs = runs.map((r) => prNumberOf(r.prUrl, opts.repo)).filter((n): n is number => n !== undefined);
    const res = await fetchGithubHostEvents(opts.repo, opts.issue, prs, opts.gh);
    host = res.events;
    unavailable.push(...res.unavailable);
  }
  return buildIssueHistory({ repo: opts.repo, issue: opts.issue, repoAliases: [opts.repoPath], units, runs, host, unavailable });
}

// ---- text ----------------------------------------------------------------------------------------

const actorLabel = (a: AuditActor | undefined): string => a?.name ?? a?.kind ?? 'unknown';

export function formatHistoryText(h: IssueHistory): string {
  const lines = [`History of ${h.repo}#${h.issue}${h.prs.length > 0 ? ` (PR ${h.prs.map((p) => `#${p}`).join(', ')})` : ''}`];
  for (const c of h.chains) lines.push(`${c.ok ? 'ok  ' : 'FAIL'} chain ${c.name}: ${c.records} record(s)${c.legacy > 0 ? `, ${c.legacy} unchained` : ''}${c.problems.map((p) => `\n       ${p.file}:${p.line}: ${p.reason}`).join('')}`);
  for (const u of h.unavailable) lines.push(`warn could not read ${u}`);
  if (h.entries.length === 0) lines.push('(no records)');
  for (const e of h.entries) {
    const mark = e.chain === 'verified' ? '' : e.chain === 'failed' ? ' [chain FAILED]' : ' [no chain]';
    lines.push(`${e.time}  ${actorLabel(e.actor)}  ${e.what}  <${e.source.stream} ${e.source.ref}${e.source.url !== undefined ? ` ${e.source.url}` : ''}>${mark}`);
  }
  return `${lines.join('\n')}\n`;
}
