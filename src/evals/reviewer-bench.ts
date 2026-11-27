import { createHash } from 'node:crypto';
import { reviewVerdictOf } from '../pipeline/review-verdict.js';
import type { Finding } from '../wire.js';

/** The dataset slice and revision the benchmark is pinned to; the report also records the content hash. */
export const AACR_DATASET = 'Alibaba-Aone/aacr-bench';
export const AACR_VERSION = 'data/v2';
export const AACR_DEFAULT_SAMPLE = 25;
/** A finding within this many lines of an annotated issue's range matches without asking the judge. */
export const LINE_TOLERANCE = 5;
/** Beyond LINE_TOLERANCE, up to this many lines (or no line at all) in the same file is a close call for the judge. */
export const JUDGE_WINDOW = 30;

export interface BenchIssue {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface BenchPr {
  id: string;
  repo: string;
  title: string;
  body: string;
  diff: string;
  issues: BenchIssue[];
}

/** A reviewer finding plus the file/line it points at, read from its title/evidence (the findings schema has no location field). */
export interface LocatedFinding extends Finding {
  file?: string;
  line?: number;
}

export interface ReviewRun {
  findings: Finding[];
  completed: boolean;
  tokens: number;
  costUsd?: number;
  durationMs: number;
}

export type CloseCallJudge = (finding: LocatedFinding, issue: BenchIssue) => Promise<boolean>;

export interface PrScore {
  prId: string;
  findings: number;
  issues: number;
  matchedFindings: number;
  matchedIssues: number;
  blocking: number;
  blockingMatched: number;
  completed: boolean;
  tokens: number;
  costUsd?: number;
  durationMs: number;
}

export interface ModelScore {
  model: string;
  prs: number;
  findings: number;
  issues: number;
  matchedFindings: number;
  matchedIssues: number;
  precision: number;
  recall: number;
  f1: number;
  blocking: number;
  blockingMatched: number;
  nonBlocking: number;
  nonBlockingMatched: number;
  incomplete: number;
  tokens: number;
  costUsd?: number;
  durationMs: number;
  perPr: PrScore[];
}

export interface BenchReport {
  dataset: string;
  version: string;
  datasetHash: string;
  sampleSize: number;
  models: ModelScore[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};

function parseIssue(raw: unknown): BenchIssue | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const file = str(r.path) ?? str(r.file) ?? str(r.file_path);
  const text = str(r.text) ?? str(r.comment) ?? str(r.body) ?? str(r.description) ?? str(r.issue) ?? '';
  if (file === undefined) return undefined;
  const start = num(r.start_line) ?? num(r.line) ?? num(r.new_line) ?? num(r.line_start) ?? 1;
  const end = num(r.end_line) ?? num(r.line_end) ?? start;
  return { file: normalizePath(file), startLine: Math.min(start, end), endLine: Math.max(start, end), text };
}

/**
 * Read AACR-Bench records (a JSON array or JSONL). Field names are matched tolerantly
 * (`diff`|`patch`, `issues`|`comments`|`annotations`) because the schema is read from the dataset, not owned here.
 * A record without a diff or without any parseable issue is dropped.
 */
export function parseAacrDataset(text: string): BenchPr[] {
  const trimmed = text.trim();
  const records: unknown[] = trimmed.startsWith('[')
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown);
  const prs: BenchPr[] = [];
  for (const rec of records) {
    if (typeof rec !== 'object' || rec === null) continue;
    const r = rec as Record<string, unknown>;
    const diff = str(r.diff) ?? str(r.patch);
    const rawIssues = [r.issues, r.comments, r.annotations].find(Array.isArray) as unknown[] | undefined;
    const issues = (rawIssues ?? []).map(parseIssue).filter((i): i is BenchIssue => i !== undefined);
    if (diff === undefined || issues.length === 0) continue;
    const repo = str(r.repo) ?? str(r.repository) ?? 'unknown/unknown';
    const number = num(r.pr_number) ?? num(r.number) ?? num(r.id);
    prs.push({
      id: str(r.instance_id) ?? str(r.id) ?? `${repo}#${number ?? prs.length}`,
      repo,
      title: str(r.title) ?? str(r.pr_title) ?? '',
      body: str(r.body) ?? str(r.description) ?? '',
      diff,
      issues,
    });
  }
  return prs;
}

/** Hash of the fetched dataset bytes: the report's proof of which corpus the numbers came from. */
export function datasetHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Deterministic sample of `n` PRs: ordered by a hash of the id so the same dataset and n pick the same PRs. */
export function samplePrs(prs: BenchPr[], n: number): BenchPr[] {
  return prs
    .map((pr) => ({ pr, key: createHash('sha256').update(pr.id).digest('hex') }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, Math.max(0, n))
    .map((x) => x.pr);
}

function normalizePath(p: string): string {
  return p.trim().replace(/^[ab]\//, '').replace(/^\.\//, '');
}

/** Same file when equal, or one path is a `/`-boundary suffix of the other (the reviewer may cite a short path). */
export function samePath(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

const LOCATION_RE = /([\w@.\-/]+\.[A-Za-z][\w]*):(\d+)(?:\s*[-–]\s*(\d+))?/;

/** Pull `path/to/file.ext:42` (or `:42-50`) out of a finding's evidence/title; absent when it cites none. */
export function locateFinding(f: Finding): LocatedFinding {
  const m = LOCATION_RE.exec(f.evidence) ?? LOCATION_RE.exec(f.title);
  if (m?.[1] === undefined || m[2] === undefined) return f;
  return { ...f, file: normalizePath(m[1]), line: Number(m[2]) };
}

export type MatchKind = 'match' | 'close' | 'none';

/** Distance in lines from `line` to the issue's range (0 inside it). */
const lineDistance = (line: number, issue: BenchIssue): number =>
  line < issue.startLine ? issue.startLine - line : line > issue.endLine ? line - issue.endLine : 0;

/**
 * `match`: same file and within LINE_TOLERANCE lines. `close`: same file but farther away (up to
 * JUDGE_WINDOW) or with no line cited — the judge decides. `none`: other file, or no file cited.
 */
export function classifyMatch(f: LocatedFinding, issue: BenchIssue): MatchKind {
  if (f.file === undefined || !samePath(f.file, issue.file)) return 'none';
  if (f.line === undefined) return 'close';
  const d = lineDistance(f.line, issue);
  return d <= LINE_TOLERANCE ? 'match' : d <= JUDGE_WINDOW ? 'close' : 'none';
}

/**
 * Greedy one-to-one matching of findings to annotated issues: clear location matches first, then
 * close calls via `judge` (when given). Returns the matched index pairs.
 */
export async function matchFindings(
  findings: Finding[],
  issues: BenchIssue[],
  judge?: CloseCallJudge,
): Promise<Array<{ finding: number; issue: number }>> {
  const located = findings.map(locateFinding);
  const pairs: Array<{ finding: number; issue: number }> = [];
  const usedF = new Set<number>();
  const usedI = new Set<number>();
  for (const pass of ['match', 'close'] as const) {
    if (pass === 'close' && judge === undefined) break;
    for (const [fi, f] of located.entries()) {
      if (usedF.has(fi)) continue;
      for (const [ii, issue] of issues.entries()) {
        if (usedI.has(ii) || classifyMatch(f, issue) !== pass) continue;
        if (pass === 'close' && !(await judge!(f, issue))) continue;
        pairs.push({ finding: fi, issue: ii });
        usedF.add(fi);
        usedI.add(ii);
        break;
      }
    }
  }
  return pairs;
}

const isBlocking = (f: Finding): boolean => f.severity === 'high' || f.severity === 'critical';

/** Score one reviewer reply against one PR's annotated issues. */
export async function scorePr(pr: BenchPr, run: ReviewRun, judge?: CloseCallJudge): Promise<PrScore> {
  const pairs = await matchFindings(run.findings, pr.issues, judge);
  const matched = new Set(pairs.map((p) => p.finding));
  return {
    prId: pr.id,
    findings: run.findings.length,
    issues: pr.issues.length,
    matchedFindings: pairs.length,
    matchedIssues: pairs.length,
    blocking: run.findings.filter(isBlocking).length,
    blockingMatched: run.findings.filter((f, i) => isBlocking(f) && matched.has(i)).length,
    completed: run.completed,
    tokens: run.tokens,
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    durationMs: run.durationMs,
  };
}

/** Findings from a raw reviewer reply (`[]` when it carries no parseable `<findings>` block). */
export function findingsOfReply(text: string): Finding[] {
  return reviewVerdictOf(text).findings;
}

const ratio = (n: number, d: number): number => (d === 0 ? 0 : n / d);

/** Micro-averaged precision/recall/F1 over all of a model's PRs, plus the blocking split and usage totals. */
export function aggregateScores(model: string, perPr: PrScore[]): ModelScore {
  const sum = (pick: (s: PrScore) => number): number => perPr.reduce((a, s) => a + pick(s), 0);
  const findings = sum((s) => s.findings);
  const matchedFindings = sum((s) => s.matchedFindings);
  const issues = sum((s) => s.issues);
  const matchedIssues = sum((s) => s.matchedIssues);
  const precision = ratio(matchedFindings, findings);
  const recall = ratio(matchedIssues, issues);
  const blocking = sum((s) => s.blocking);
  const blockingMatched = sum((s) => s.blockingMatched);
  const priced = perPr.filter((s) => s.costUsd !== undefined);
  return {
    model,
    prs: perPr.length,
    findings,
    issues,
    matchedFindings,
    matchedIssues,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    blocking,
    blockingMatched,
    nonBlocking: findings - blocking,
    nonBlockingMatched: matchedFindings - blockingMatched,
    incomplete: perPr.filter((s) => !s.completed).length,
    tokens: sum((s) => s.tokens),
    ...(priced.length > 0 ? { costUsd: priced.reduce((a, s) => a + (s.costUsd ?? 0), 0) } : {}),
    durationMs: sum((s) => s.durationMs),
    perPr,
  };
}

export interface RunBenchOptions {
  prs: BenchPr[];
  models: string[];
  review: (model: string, pr: BenchPr) => Promise<ReviewRun>;
  judge?: CloseCallJudge;
  log?: (line: string) => void;
}

/** Run every model over every PR (sequentially: a subscription's usage window is the constraint) and score it. */
export async function runReviewerBench(opts: RunBenchOptions): Promise<ModelScore[]> {
  const scores: ModelScore[] = [];
  for (const model of opts.models) {
    const perPr: PrScore[] = [];
    for (const [i, pr] of opts.prs.entries()) {
      opts.log?.(`reviewer-bench ${model} ${i + 1}/${opts.prs.length}: ${pr.id}`);
      perPr.push(await scorePr(pr, await opts.review(model, pr), opts.judge));
    }
    scores.push(aggregateScores(model, perPr));
  }
  return scores;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Human-readable report: dataset version/hash, then one row per model. */
export function formatBenchReport(report: BenchReport): string {
  const lines = [
    `Reviewer benchmark: ${report.dataset} @ ${report.version}`,
    `Dataset hash: ${report.datasetHash}`,
    `Sample: ${report.sampleSize} PRs`,
    '',
  ];
  for (const m of report.models) {
    lines.push(
      `${m.model}`,
      `  precision ${pct(m.precision)}  recall ${pct(m.recall)}  F1 ${pct(m.f1)}`,
      `  findings ${m.findings} (${m.matchedFindings} matched) vs ${m.issues} annotated issues (${m.matchedIssues} found)`,
      `  blocking ${m.blockingMatched}/${m.blocking} matched; non-blocking ${m.nonBlockingMatched}/${m.nonBlocking} matched`,
      `  tokens ${m.tokens}  cost ${m.costUsd !== undefined ? `$${m.costUsd.toFixed(2)}` : 'n/a'}  time ${(m.durationMs / 1000).toFixed(0)}s${m.incomplete > 0 ? `  incomplete reviews ${m.incomplete}` : ''}`,
      '',
    );
  }
  return lines.join('\n').trimEnd();
}
