// The one implementation of the on-disk run-record format: naming, writing, listing and reading.
// The reader that used to re-derive this format now forwards here: src/hub/runs.ts (thin re-export
// shim). The desktop app has no reader of its own; its window is a client of the local hub.
import { createHash } from 'node:crypto';
import { writeFile, unlink, readdir, lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunResult } from './types.js';
import { estimatedCostUsd, stageMetric } from './run-metric.js';
import { exportRunTrace } from './otlp-sink.js';
import { appendAudit, defaultActor, localAdapter, STREAMS } from './audit.js';
import { assertStatePath, ensureStateDir, isSafeTaskId, readTextNoSymlink, stateDir } from './state-path.js';
import { injectedSecretValues, redactForPublish, scanForInjectedSecrets, scanForSecrets, withRegisteredSecretValues } from './secret-scan.js';
import { redactVerificationOutput } from '../pipeline/verify.js';
import type { VerificationResult } from '../pipeline/verify.js';
import type { VisualProofResult } from '../pipeline/visual-proof.js';
import { ciRunUrl, diffUrlFor, httpsUrl } from './links.js';
import { reviewVerdictOf } from '../pipeline/review-verdict.js';
import { parseSkillsUsed, sanitizeSkillIds } from './skills-used.js';
import { parseMetrics } from './stats.js';
import { taskRefKey } from '../tasks/board.js';
import { workflowPaths } from './taskcell.js';
import type { DecisionProbeResult } from './decision-probe.js';
import type { BaseMergeEvent } from './conflict-stats.js';
import type { Finding, Proof, RunDetail, RunRecord, RunSummary, StageDetail, VisualProof } from '../wire.js';

export { readTextNoSymlink };

/**
 * Stages whose reply carries a review verdict + `<findings>` block. Hard-coded string literals, not
 * `STAGE.REVIEWER`/`STAGE.CONFORMANCE`: this module must not take an import on pipeline.ts (which
 * pulls runAgent, providers, the whole pipeline graph) — the same reason WIRE_PROVIDER_NAMES is a
 * literal. run-store.test.ts pins this set equal to [STAGE.REVIEWER, STAGE.CONFORMANCE].
 */
export const VERDICT_STAGES: ReadonlySet<string> = new Set(['reviewer', 'conformance']);

export type { AgentUsage, Proof, RunDetail, RunRecord, RunSummary, StageDetail, VisualProof, VisualProofArtifact } from '../wire.js';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * `<runsRoot>` is the directory directly containing per-task subdirectories: `.taskcell/runs` for a
 * repo's own history, or `.taskcell/remote-runs/<origin>` for an imported CI run's records.
 */
export function runsRoot(repoPath: string, origin?: number): string {
  return origin === undefined
    ? join(stateDir(repoPath), 'runs')
    : join(stateDir(repoPath), 'remote-runs', String(origin));
}

/** Filesystem-safe form of an ISO timestamp, shared by every record filename. */
export function sanitizeTimestamp(ts: string): string {
  return ts.replace(/[^0-9A-Za-z]/g, '-');
}

export function isRunRecordFile(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.proof.json') && !name.endsWith('.visual-proof.json');
}

/** 32-bit FNV-1a over a string; used only to fold file name+mtime into a stable fingerprint. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Cheap, order-independent change-detector for a runs tree: folds each record file's name + mtime
 * together without reading contents. Missing/empty tree -> 0.
 */
export async function fingerprint(root: string): Promise<number> {
  let taskDirs;
  try {
    taskDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let fp = 0;
  for (const task of taskDirs) {
    if (!task.isDirectory()) continue;
    const taskPath = join(root, task.name);
    let files;
    try {
      files = await readdir(taskPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!isRunRecordFile(file.name)) continue;
      let mtimeMs = 0;
      try {
        const info = await stat(join(taskPath, file.name));
        mtimeMs = info.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      fp = (fp + fnv1a(`${file.name}:${mtimeMs}`)) >>> 0;
    }
  }
  return fp;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Matches the `sanitizeTimestamp()` shape of an ISO timestamp, e.g. `2026-10-17T17-57-10-100Z`. */
const SANITIZED_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
/** Character length of every string `SANITIZED_TIMESTAMP_RE` matches. */
const SANITIZED_TIMESTAMP_LENGTH = '2026-10-17T17-57-10-100Z'.length;

/** Parse a `sanitizeTimestamp()`-shaped prefix back into epoch ms, or undefined if it doesn't match. */
function parseSanitizedTimestampMs(sanitized: string): number | undefined {
  const m = SANITIZED_TIMESTAMP_RE.exec(sanitized);
  if (m === null) return undefined;
  const [, date, hh, mm, ss, mmm] = m;
  const ms = Date.parse(`${date}T${hh}:${mm}:${ss}.${mmm}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** How far back a proof/visual-proof file may sit from the stage timestamp it's matched to as a fallback. */
const PROOF_FALLBACK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pick the sibling `*<suffix>` file (by name, from a task dir listing) closest to and not later than
 * `stageMs`, within `PROOF_FALLBACK_WINDOW_MS`. Covers runs persisted before one timestamp was shared
 * across the proof writers and the stage writer: the proof file is stamped a few seconds earlier than
 * the stage records and never matches them exactly.
 */
function findClosestProofFile(fileNames: readonly string[], suffix: string, stageMs: number): string | undefined {
  let best: { name: string; ms: number } | undefined;
  for (const name of fileNames) {
    if (!name.endsWith(suffix)) continue;
    const ms = parseSanitizedTimestampMs(name.slice(0, -suffix.length));
    if (ms === undefined || ms > stageMs || stageMs - ms > PROOF_FALLBACK_WINDOW_MS) continue;
    if (best === undefined || ms > best.ms) best = { name, ms };
  }
  return best?.name;
}

let runTrigger: 'watch' | undefined;

/** Stamp every run record this process writes from now on with `trigger` (`taskcell watch` sets `'watch'`). */
export function setRunTrigger(trigger: 'watch' | undefined): void {
  runTrigger = trigger;
}

/** Best-effort parse of a run record file; returns undefined on any read or JSON error. */
async function tryReadRecord(path: string): Promise<RunRecord | undefined> {
  try {
    const contents = await readTextNoSymlink(path);
    return JSON.parse(contents) as RunRecord;
  } catch {
    return undefined;
  }
}

/** A record's estimate: a finite, non-negative number on a record without a reported cost (the JSON is not trusted). */
function recordEst(r: RunRecord): number | undefined {
  const est: unknown = r.estCostUsd;
  return r.costUsd === undefined && typeof est === 'number' && Number.isFinite(est) && est >= 0 ? est : undefined;
}

/** Longest `RunSummary.asked` text: the end of the agent's last reply, where its questions are. */
const ASKED_MAX = 2000;
const askedText = (text: unknown): string => {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length > ASKED_MAX ? `…${t.slice(-ASKED_MAX)}` : t;
};

/** A proof file's `passed`, or undefined when it cannot be read. */
async function tryReadProofPassed(path: string): Promise<boolean | undefined> {
  try {
    const passed: unknown = (JSON.parse(await readTextNoSymlink(path)) as { passed?: unknown }).passed;
    return typeof passed === 'boolean' ? passed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each card's newest local run, keyed by its board id (`taskRefKey`: `gh-owner-repo-904` and `gh-904` are one card).
 * CI-imported runs are never a card's run. Newest by timestamp, whatever order `runs` come in.
 */
export function newestRuns<T extends Pick<RunSummary, 'taskId' | 'timestamp' | 'source'>>(runs: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of runs) {
    if (r.source === 'ci') continue;
    const key = taskRefKey(r.taskId);
    const held = out.get(key);
    if (held === undefined || held.timestamp < r.timestamp) out.set(key, r);
  }
  return out;
}

async function parseRunSummaries(root: string): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];

  let taskDirs;
  try {
    taskDirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summaries;
    throw error;
  }

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue;
    const taskPath = join(root, taskEntry.name);
    const groups = new Map<string, RunRecord[]>();
    const files = await readdir(taskPath, { withFileTypes: true });
    for (const file of files) {
      if (!isRunRecordFile(file.name)) continue;
      const record = await tryReadRecord(join(taskPath, file.name));
      if (record === undefined) continue;
      const group = groups.get(record.timestamp);
      if (group === undefined) {
        groups.set(record.timestamp, [record]);
      } else {
        group.push(record);
      }
    }
    for (const [timestamp, records] of groups) {
      const first = records[0];
      if (first === undefined) continue;
      const stages = records.map((r) => r.stage ?? 'run').sort();
      const totalCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const estCostUsd = records.reduce((sum, r) => sum + (recordEst(r) ?? 0), 0);
      // Stages that used tokens but have neither a reported cost nor an estimate (an unpriced model).
      const unpriced = records.some((r) => r.costUsd === undefined && r.usage !== undefined && recordEst(r) === undefined);
      // No stage reported a cost: the estimate stands in for it, or the cost is unknown (never $0.00).
      const costUnknown = (estCostUsd > 0 || unpriced) && records.every((r) => r.costUsd === undefined);
      const failed = records.filter((r) => !r.completed);
      const anyFailed = failed.length > 0;
      // Only the flag the run recorded itself: the final text is agent prose, which may well quote a limit.
      // Every failed stage must carry it: a later provider stop must not hide a genuine stage failure.
      const providerLimit = failed.length > 0 && failed.every((r) => r.stoppedBy === 'provider-limit');
      const prUrl = httpsUrl(records.find((r) => r.prUrl !== undefined)?.prUrl);
      const ciUrl = httpsUrl(records.find((r) => r.ciUrl !== undefined)?.ciUrl);
      const startedBy = records.find((r) => r.startedBy !== undefined)?.startedBy;
      const trigger = records.some((r) => r.trigger === 'watch') ? 'watch' : undefined;
      const extraAttempts = records.reduce((n, r) => n + (typeof r.attempts === 'number' && r.attempts > 1 ? Math.floor(r.attempts) - 1 : 0), 0);
      const failedStage = failed.find((r) => r.stage !== undefined)?.stage;
      // `incomplete`: the agent stopped on its own without its done signal (no turn cap, no timeout): it waits on a person.
      // Or it finished but delivered nothing: what it ended on (a question, a "nothing to do") waits on a person too.
      const stoppedEarly = records.find((r) => r.stage === 'implementer' && ((r.exitReason === 'incomplete' && r.stoppedBy === undefined) || (r.completed && r.noChanges === true)));
      const asked = stoppedEarly === undefined ? undefined : askedText(stoppedEarly.finalText);
      // The implementer ran on a fallback entry (a limit moved it): the entry it used and the ones it passed over.
      const moved = records.find((r) => r.stage === 'implementer')?.modelPick;
      const ranOn = moved !== undefined && (moved.pick === 'skip-limit' || moved.pick === 'fallback')
        ? { entry: `${moved.provider}/${moved.model ?? ''}`, pick: moved.pick, ...(moved.skipped !== undefined && moved.skipped.length > 0 ? { skipped: moved.skipped.map((k) => (k.until !== undefined ? `${k.entry} until ${k.until}` : k.entry)) } : {}) }
        : undefined;
      // shortcut: only a proof stamped with the run's own timestamp counts (not readRunDetail's fallback for older runs).
      const proofName = `${sanitizeTimestamp(timestamp)}.proof.json`;
      const proofPassed = files.some((f) => f.name === proofName) ? await tryReadProofPassed(join(taskPath, proofName)) : undefined;
      summaries.push({
        taskId: first.taskId,
        timestamp,
        stages,
        totalCostUsd,
        ...(estCostUsd > 0 ? { estCostUsd } : {}),
        ...(unpriced && (estCostUsd > 0 || records.some((r) => r.costUsd !== undefined)) ? { estPartial: true as const } : {}),
        ...(costUnknown ? { costUnknown: true as const } : {}),
        anyFailed,
        ...(providerLimit ? { stoppedBy: 'provider-limit' as const } : {}),
        ...(prUrl !== undefined ? { prUrl } : {}),
        ...(ciUrl !== undefined ? { ciUrl } : {}),
        ...(startedBy !== undefined ? { startedBy } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(extraAttempts > 0 ? { extraAttempts } : {}),
        ...(failedStage !== undefined ? { failedStage } : {}),
        ...(proofPassed === false ? { verifyFailed: true as const } : {}),
        ...(proofPassed === true ? { verifyPassed: true as const } : {}),
        ...(asked !== undefined ? { asked } : {}),
        ...(ranOn !== undefined ? { ranOn } : {}),
      });
    }
  }

  summaries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return summaries;
}

/**
 * Parsed run summaries per runs root, reused while the tree is unchanged: a fresh parse re-reads and
 * JSON-parses every run record, and a caller (e.g. the dashboard) polling every few seconds should not
 * pay that cost when nothing changed. Keyed by root; the tree fingerprint invalidates an entry when a
 * record is added, removed, or rewritten.
 */
const listCache = new Map<string, { fingerprint: number; summaries: RunSummary[] }>();

/**
 * List and group run summaries under `root` (fingerprint-cached). Missing root -> []. Each task
 * subdirectory's record files are read, parsed, and grouped by `record.timestamp` (unparseable files
 * are skipped).
 */
export async function listRuns(root: string): Promise<RunSummary[]> {
  const fp = await fingerprint(root);
  const cached = listCache.get(root);
  if (cached !== undefined && cached.fingerprint === fp) {
    return cached.summaries;
  }
  // Only cache a successful parse. Caching a transient error's empty result would pin a dashboard at
  // 0 runs until the tree fingerprint next shifts; let a failure self-heal on the next call instead.
  const summaries = await parseRunSummaries(root);
  listCache.set(root, { fingerprint: fp, summaries });
  return summaries;
}

/** How many record files older than the window `recentWatchTimestamps` opens, newest first, to find the last watch run. */
const OLDER_WATCH_SCAN_CAP = 50;

/**
 * Timestamps of `taskcell watch`-stamped records under `root` whose file name (the sanitized run
 * timestamp) is at or after `sinceMs`. Older files, and names that carry no timestamp, are skipped
 * before any read, so the work is bounded by the window rather than the history. When no in-window
 * record is watch-stamped, up to `OLDER_WATCH_SCAN_CAP` older files are opened newest first and the
 * first watch-stamped one's name time is returned, so a worker that stopped a while ago still reads stale.
 */
export async function recentWatchTimestamps(root: string, sinceMs: number): Promise<string[]> {
  let taskDirs;
  try {
    taskDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const older: Array<{ ms: number; path: string }> = [];
  for (const task of taskDirs) {
    if (!task.isDirectory()) continue;
    const taskPath = join(root, task.name);
    const files = await readdir(taskPath).catch((): string[] => []);
    for (const name of files) {
      if (!isRunRecordFile(name)) continue;
      // `<sanitized timestamp>[-<stage>].json`: the name opens with the timestamp.
      const ms = parseSanitizedTimestampMs(name.slice(0, SANITIZED_TIMESTAMP_LENGTH));
      if (ms === undefined) continue;
      if (ms < sinceMs) {
        older.push({ ms, path: join(taskPath, name) });
        continue;
      }
      const record = await tryReadRecord(join(taskPath, name));
      if (record?.trigger === 'watch' && typeof record.timestamp === 'string') out.push(record.timestamp);
    }
  }
  if (out.length > 0) return out;
  // The name, not the record body, dates an older file: it cannot claim a time inside the window.
  for (const { ms, path } of older.sort((a, b) => b.ms - a.ms).slice(0, OLDER_WATCH_SCAN_CAP)) {
    if ((await tryReadRecord(path))?.trigger === 'watch') return [new Date(ms).toISOString()];
  }
  return [];
}

/**
 * Read the full detail (stages + proof) for one task's run at one timestamp. taskId is validated
 * against path traversal before any filesystem access.
 */
export async function readRun(root: string, taskId: string, timestamp: string): Promise<RunDetail> {
  const detail = await readRunRecords(root, taskId, timestamp, true);
  return withSkillsUsed(root, detail);
}

type SkillsIndex = Map<string, Map<string, string[]>>;
/** Per metrics.jsonl: its size+mtime and the `taskId|ts` -> stage -> skillsUsed index built from it. The file only grows, so a changed stamp rebuilds. */
const skillsIndexCache = new Map<string, { stamp: string; index: SkillsIndex }>();

/** The skillsUsed index of a runs root's metrics.jsonl, parsed once per file change; undefined when there is no file. */
async function skillsIndex(file: string): Promise<SkillsIndex | undefined> {
  const st = await lstat(file).catch(() => undefined);
  if (st === undefined || !st.isFile()) return undefined;
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = skillsIndexCache.get(file);
  if (hit?.stamp === stamp) return hit.index;
  const index: SkillsIndex = new Map();
  for (const m of parseMetrics(await readTextNoSymlink(file).catch(() => ''))) {
    if (m.ts === undefined || m.stage === undefined || m.skillsUsed === undefined) continue;
    const key = `${m.taskId}|${m.ts}`;
    const run = index.get(key) ?? new Map<string, string[]>();
    run.set(m.stage, m.skillsUsed);
    index.set(key, run);
  }
  skillsIndexCache.set(file, { stamp, index });
  return index;
}

/**
 * Attach each stage's `skillsUsed` from the run's `run_complete` metric lines (the record JSON does not
 * carry it). A stage whose line lacks the field (older runs, a withheld transcript) stays without it.
 */
async function withSkillsUsed(root: string, detail: RunDetail): Promise<RunDetail> {
  const used = (await skillsIndex(join(root, 'metrics.jsonl')))?.get(`${detail.taskId}|${detail.timestamp}`);
  if (used === undefined) return detail;
  return {
    ...detail,
    stages: detail.stages.map((s) => {
      const skills = s.record.stage === undefined ? undefined : used.get(s.record.stage);
      return skills === undefined ? s : { ...s, record: { ...s.record, skillsUsed: skills } };
    }),
  };
}

const C_ESCAPES: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };

/** A path as git prints it in a diff header: C-quoted (`"a/caf\303\251.yml"`) when it holds special bytes, else bare. */
function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const s = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
    const n = s[++i] ?? '';
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; } else bytes.push(C_ESCAPES[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Every path a diff touches, both sides of a rename (a rename into or out of a CI directory counts), read from the
 * file headers only (never hunk lines): `diff --git`, `---`/`+++`, `rename`/`copy from|to`. Handles paths with spaces
 * (git ends those `---`/`+++` names with a tab) and C-quoted paths.
 */
export function diffPaths(diff: string): string[] {
  const out = new Set<string>();
  const add = (raw: string, prefix?: string): void => {
    const p = unquoteGitPath(raw.replace(/\t$/, ''));
    if (p === '/dev/null') return;
    out.add(prefix !== undefined && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  };
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      const rest = line.slice('diff --git '.length);
      const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
      const mid = (rest.length - 1) / 2;
      if (quoted !== null) { add(quoted[1]!, 'a/'); add(quoted[2]!, 'b/'); }
      // Unquoted with spaces: the two halves of a non-rename header are the same path (a rename names both below).
      else if (rest.startsWith('a/') && rest.slice(mid, mid + 3) === ' b/' && rest.slice(2, mid) === rest.slice(mid + 3)) add(rest.slice(2, mid));
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith('@@')) { inHeader = false; continue; }
    const m = /^(---|\+\+\+|rename from|rename to|copy from|copy to) (.+)$/.exec(line);
    if (m === null) continue;
    add(m[2]!, m[1] === '---' ? 'a/' : m[1] === '+++' ? 'b/' : undefined);
  }
  return [...out];
}

/** Record/proof-only read for the board; never opens diff/transcript files. */
export async function readRunRecords(root: string, taskId: string, timestamp: string, includeArtifacts = false): Promise<RunDetail> {
  if (!isSafeTaskId(taskId)) {
    throw new BadRequestError('invalid task id');
  }
  const taskDir = join(root, taskId);
  if ((await lstat(taskDir)).isSymbolicLink()) {
    throw new BadRequestError('refusing to read a symlinked task directory');
  }
  const stages: StageDetail[] = [];

  const files = await readdir(taskDir, { withFileTypes: true });
  for (const file of files) {
    if (!isRunRecordFile(file.name)) continue;
    const path = join(taskDir, file.name);
    const record = await tryReadRecord(path);
    if (record === undefined) continue;
    if (record.timestamp !== timestamp) continue;
    const base = path.endsWith('.json') ? path.slice(0, -'.json'.length) : path;
    const diff = includeArtifacts ? await readTextNoSymlink(`${base}.diff`).catch(() => undefined) : undefined;
    const transcript = includeArtifacts ? await readTextNoSymlink(`${base}.transcript.log`).catch(() => undefined) : undefined;
    stages.push({
      record,
      ...(diff !== undefined ? { diff, ciConfigPaths: workflowPaths(diffPaths(diff)) } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
    });
  }

  stages.sort((a, b) => {
    const sa = a.record.stage;
    const sb = b.record.stage;
    if (sa === sb) return 0;
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const fileNames = files.map((f) => f.name);
  const stageMs = Date.parse(timestamp);

  /** Read `<ts><suffix>`, or — if absent — the closest sibling `*<suffix>` file (see findClosestProofFile). */
  const readProofFile = async <T>(suffix: string): Promise<T | undefined> => {
    const exactPath = join(taskDir, `${sanitizeTimestamp(timestamp)}${suffix}`);
    try {
      return JSON.parse(await readTextNoSymlink(exactPath)) as T;
    } catch {
      // fall through to the closest-preceding fallback below
    }
    if (Number.isNaN(stageMs)) return undefined;
    const fallbackName = findClosestProofFile(fileNames, suffix, stageMs);
    if (fallbackName === undefined) return undefined;
    try {
      return JSON.parse(await readTextNoSymlink(join(taskDir, fallbackName))) as T;
    } catch {
      return undefined;
    }
  };

  const proof = await readProofFile<Proof>('.proof.json');
  const visualProof = await readProofFile<VisualProof>('.visual-proof.json');

  const prUrl = httpsUrl(stages.find((s) => s.record.prUrl !== undefined)?.record.prUrl);
  const diffUrl = diffUrlFor(prUrl);
  const ciUrl = httpsUrl(stages.find((s) => s.record.ciUrl !== undefined)?.record.ciUrl);
  return {
    taskId,
    timestamp,
    stages,
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(diffUrl !== undefined ? { diffUrl } : {}),
    ...(ciUrl !== undefined ? { ciUrl } : {}),
    ...(proof !== undefined ? { proof } : {}),
    ...(visualProof !== undefined ? { visualProof } : {}),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The skills of a run: the ones named by hand that it loaded, and the other installed ones the agent could pick from. */
export interface RunSkills {
  /** Named by hand (`Skills:` line, `--skill`, the hub) and loaded. Empty when the provider reads no skills. */
  named: string[];
  /** The other installed skills, available to the automatic selection. Not a list of what the agent used. */
  available: string[];
  /** What the run summary says about the hand-picked list: an ignored `Skills:` line, a provider that reads no skills. */
  notes?: string[];
}

/** `true`: the secret gate blocked the run; `'not-scanned'`: the run stopped before the gate ran. */
export type OmitDiff = boolean | 'not-scanned';

export interface WriteStagesOptions {
  /** The PR opened for this run, if any. */
  prUrl?: string;
  /** Flow and provider names of the run, recorded on the exported trace (see otlp-sink). */
  flow?: string;
  provider?: string;
  /** The branch this run's PR targets (card label / repo default / --base), recorded on every stage. */
  baseBranch?: string;
  /** Gate-config files the delivered diff changed; recorded on every stage (any delivery kind). */
  configPaths?: readonly string[];
  /** The run delivered nothing (an empty diff): its implementer's last words are what it waits on. */
  noChanges?: true;
  /** The run's gate-repair cap (`--max-repair-iterations`), recorded on every stage. */
  maxRepairIterations?: number;
  /** The sandbox image's content digest (IsolatedSandboxProvider.imageDigest), recorded on every
   *  stage of the run so a run record can be traced back to the exact image it executed against. */
  imageDigest?: string;
  /** The LLM-proxy credential the run ended on (RunRecord.llmCredential). */
  llmCredential?: { index: number; of: number; note?: string };
  /** `instance` or `user`: which kind of credential funded the run (never the value). */
  credentialSource?: 'instance' | 'user';
  /** The user-given name of the stored credential that funded the run (never the value). */
  credentialName?: string;
  /**
   * Leave the `.diff`, `.bundle` and `.transcript.log` off disk and stub `finalText`; only the JSON
   * record (marked `diffOmitted: 'secret-blocked'`, or `'not-scanned'` for the value below) and the metric line are written for every stage.
   * Set for secret-blocked runs: the payloads hold the very secret the scan caught, and the run record
   * may be uploaded as a CI artifact (`upload-run-records`). `'not-scanned'` withholds the same way for
   * a revise round that stopped before the scan ran (hold, unanswered items, diff not captured) and
   * marks it `diffOmitted: 'not-scanned'`, so it is not mistaken for a scan hit. Independently of this
   * flag, a stage diff that `scanForSecrets` flags is withheld with `diffOmitted: 'secret-scan'`.
   */
  omitDiff?: OmitDiff;
  /** Ids of the lessons injected into the run's prompts, recorded on every stage. */
  lessonIds?: readonly string[];
  skills?: RunSkills;
  /** Ids of the installed skills, for a run that passes no `skills`; `skillsUsed` keeps only installed ids. */
  skillIds?: readonly string[];
  /** Per stage name: the provider/model it ran on and why (model pools: rotation, skip-limit, fallback, label, config). */
  modelPicks?: Readonly<Record<string, StageModelPick>>;
}

/** The model a stage actually used and why it was picked; recorded as `modelPick` on the record and `provider`/`pick` on the metric line. */
export interface StageModelPick {
  provider: string;
  model?: string;
  pick: string;
  /** Entries passed over because they were out of quota (`entry` = `provider/model`, `until` = reset time when known). */
  skipped?: Array<{ entry: string; until?: string }>;
}

/** A handle for one run: owns its timestamp, so every record it writes shares one prefix. */
export interface RunWriter {
  /** Persist one record per pipeline stage under the writer's timestamp, then mirror the run as one
   * OTLP trace when an exporter is configured (opt-in, best-effort — see otlp-sink). */
  writeStages(outcomes: ReadonlyArray<{ name: string; result: RunResult; model?: string; primaryAuthRefused?: string }>, opts?: WriteStagesOptions): Promise<void>;
  /** Persist a verification proof to `<ts>.proof.json` and append a `{ evt: 'verify', ... }` metric line. */
  writeProof(result: VerificationResult, opts?: { baseRed?: boolean }): Promise<string>;
  /** Persist a visual proof to `<ts>.visual-proof.json` and append a `{ evt: 'visual_proof', ... }` metric line. */
  writeVisualProof(result: VisualProofResult): Promise<string>;
}

/** Options of {@link beginRun}. */
export interface BeginRunOptions {
  /** Env var names of credentials the static injected-secret list cannot know (a custom provider's `keyEnv`). */
  secretEnvVars?: readonly string[];
  /** Who started the run (hub login, or `token`); written to every stage record. */
  startedBy?: string;
}

interface WriteRecordOptions {
  /** Exact values of the credentials injected into this run's sandbox, removed from every free-text field. */
  secretValues: readonly string[];
  label?: string;
  prUrl?: string;
  requestedModel?: string;
  omitDiff?: OmitDiff;
  imageDigest?: string;
  llmCredential?: { index: number; of: number; note?: string };
  baseBranch?: string;
  configPaths?: readonly string[];
  noChanges?: true;
  maxRepairIterations?: number;
  credentialSource?: 'instance' | 'user';
  credentialName?: string;
  startedBy?: string;
  lessonIds?: readonly string[];
  skills?: RunSkills;
  skillIds?: readonly string[];
  modelPick?: StageModelPick;
  /** The stage's own provider refused its credential and the fallback ran it: the refused provider's name. */
  primaryAuthRefused?: string;
}

/**
 * Persist a run's metadata to `.taskcell/runs/<taskId>/<ts>[-label].json` and append one compact
 * metric line to `.taskcell/runs/metrics.jsonl`, so an AFK fleet leaves a cost/usage/exit trace. Free
 * text in the record (`finalText`, the sibling `.transcript.log`) is masked by redactForPublish; the (potentially
 * large) diff goes to a sibling `.diff` file plus a `.bundle` of the worktree HEAD, both skipped under
 * `omitDiff`. Every path is checked with assertStatePath first: a repo-committed symlink under
 * `.taskcell` must not redirect these writes out of the checkout. Returns the written JSON path.
 */
async function writeRecord(repoPath: string, taskId: string, timestamp: string, result: RunResult, opts: WriteRecordOptions): Promise<string> {
  const root = runsRoot(repoPath);
  const taskDir = await ensureStateDir(repoPath, join(root, taskId));

  const { diff, transcript, mergedEstCostUsd: _merged, cachedInInput: _cached, skillsUsed: priorSkillsUsed, ...meta } = result;
  // The skills installed for the run; a transcript's claim of any other id is discarded, so a caller
  // that passes no registry records none.
  const installedSkillIds = opts.skillIds ?? (opts.skills !== undefined ? [...opts.skills.named, ...opts.skills.available] : []);
  // Why the diff (and bundle) are withheld, recorded on run.json so the hub and a human can tell
  // "withheld" from "no diff" or "bundle creation failed":
  //  - 'secret-blocked': the caller's publish gate fired (opts.omitDiff: true).
  //  - 'not-scanned': the round stopped before the gate ran (opts.omitDiff: 'not-scanned').
  //  - 'secret-scan': a stage's diff is the worktree at the end of THAT stage, while the gate scans the
  //    final diff only — a secret the implementer wrote and the simplifier removed passes the gate yet
  //    sits in the implementer's record, so every stage diff meets the same scans first: the patterns
  //    (which exempt test paths, isTestPath) and the exact-value check on injected credentials.
  const diffOmitted: RunRecord['diffOmitted'] = opts.omitDiff === 'not-scanned'
    ? 'not-scanned'
    : opts.omitDiff === true
      ? 'secret-blocked'
      : diff !== undefined && diff !== '' && (scanForSecrets(diff).length > 0 || scanForInjectedSecrets(diff, opts.secretValues).length > 0)
        ? 'secret-scan'
        : undefined;
  // Free text is masked before it reaches disk (the record may leave the job as a CI artifact): injected
  // credentials by exact value, then token shapes. When the diff is withheld, so is the text: the
  // closing message tends to quote the change and the pattern pass is lossy (a fragment past a token's
  // char class survives).
  const review = opts.label !== undefined && VERDICT_STAGES.has(opts.label) ? reviewVerdictOf(result.finalText) : undefined;
  // Findings quote the withheld change directly; only the payload-free verdict may survive.
  const findings: Finding[] = diffOmitted === undefined && review !== undefined
    ? review.findings.map((finding) => ({
        ...finding,
        title: redactForPublish(finding.title, opts.secretValues),
        evidence: redactForPublish(finding.evidence, opts.secretValues),
      }))
    : [];
  // The model the stage ASKED for (alias or pin), beside `model` — the one the provider served. Goes
  // on the record as well as the metric line, so the run's own file names the routed model even when
  // the provider reported none.
  const requested = opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {};
  const estCostUsd = estimatedCostUsd(result);
  const ciUrl = ciRunUrl();
  const record = {
    ...meta,
    ...(review !== undefined ? { verdict: review.verdict } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    ...requested,
    ...(estCostUsd !== undefined ? { estCostUsd } : {}),
    finalText: diffOmitted !== undefined ? `[withheld: ${diffOmitted}]` : redactForPublish(result.finalText, opts.secretValues),
    timestamp,
    ...(opts.label !== undefined ? { stage: opts.label } : {}),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
    ...(ciUrl !== undefined ? { ciUrl } : {}),
    ...(opts.imageDigest !== undefined ? { imageDigest: opts.imageDigest } : {}),
    ...(opts.llmCredential !== undefined ? { llmCredential: { ...opts.llmCredential, ...(opts.llmCredential.note !== undefined ? { note: redactForPublish(opts.llmCredential.note, opts.secretValues) } : {}) } } : {}),
    ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    ...(opts.configPaths !== undefined && opts.configPaths.length > 0 ? { configPaths: [...opts.configPaths] } : {}),
    ...(opts.noChanges === true ? { noChanges: true } : {}),
    ...(opts.maxRepairIterations !== undefined ? { maxRepairIterations: opts.maxRepairIterations } : {}),
    ...(opts.credentialSource !== undefined ? { credentialSource: opts.credentialSource } : {}),
    ...(opts.credentialName !== undefined ? { credentialName: redactForPublish(opts.credentialName, opts.secretValues) } : {}),
    ...(diffOmitted !== undefined ? { diffOmitted } : {}),
    ...(opts.startedBy !== undefined ? { startedBy: opts.startedBy } : {}),
    ...(runTrigger !== undefined ? { trigger: runTrigger } : {}),
    ...(opts.lessonIds !== undefined && opts.lessonIds.length > 0 ? { lessonIds: [...opts.lessonIds] } : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts.modelPick !== undefined ? { modelPick: opts.modelPick } : {}),
    ...(opts.primaryAuthRefused !== undefined ? { primaryAuthRefused: opts.primaryAuthRefused } : {}),
  };
  const suffix = opts.label !== undefined ? `-${opts.label}` : '';
  const base = join(taskDir, `${sanitizeTimestamp(timestamp)}${suffix}`);
  const file = `${base}.json`;
  await assertStatePath(repoPath, file);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  if (diffOmitted === 'secret-scan') {
    // Visible in the job log too, so a scan false positive on a green run does not vanish silently.
    console.error(`taskcell: run record ${taskId}${suffix}: diff, bundle and transcript withheld (secret-scan)`);
  }
  if (diffOmitted === undefined) {
    // The transcript is raw agent output: tool results can echo env or config (a `cat` of the Codex
    // auth.json lands JSON-escaped, out of the patterns' reach), so mask injected values and known
    // token shapes (lossy is fine for a log). When the diff is withheld the transcript is skipped entirely:
    // the tool call that wrote the secret is in there verbatim, and skipping beats pattern-only masking.
    if (transcript) {
      await assertStatePath(repoPath, `${base}.transcript.log`);
      await writeFile(`${base}.transcript.log`, redactForPublish(transcript, opts.secretValues));
    }
    // Written faithful, not masked: this is what the hub's diff viewer and a human reconstructing the
    // run read, and redactTokens would mangle ordinary code (`password: process.env.X` → `[REDACTED]`).
    if (diff) {
      await assertStatePath(repoPath, `${base}.diff`);
      await writeFile(`${base}.diff`, diff);
    }
    const bundlePath = `${base}.bundle`;
    await assertStatePath(repoPath, bundlePath);
    try {
      await execa('git', hostGitArgs(['-C', result.worktreePath, 'bundle', 'create', bundlePath, 'HEAD']));
    } catch {
      // best-effort: remove any partial file git may have opened before it failed
      await unlink(bundlePath).catch(() => undefined);
    }
  }

  const metric = {
    evt: 'run_complete',
    ts: timestamp,
    ...stageMetric(result, opts.label, requested),
    // `costUsd` reads 0 when the agent reported no cost: say so, so a reader shows "unknown", not $0.
    // A reported cost is the agent CLI's own figure at list prices, never a provider's invoice.
    ...(result.costUsd === undefined ? { costUnknown: true } : { costKind: 'estimated' }),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
    ...(runTrigger !== undefined ? { trigger: runTrigger } : {}),
    // Parsed on the host from every folded attempt. A withheld transcript is unknown, so omit the
    // field; an available but unrecognised transcript is the known empty list. `verdict` feeds stats.
    // No registry (`skills`/`skillIds` both absent) means the installed set is unknown: omit too.
    ...(diffOmitted === undefined && (opts.skills !== undefined || opts.skillIds !== undefined)
      ? { skillsUsed: sanitizeSkillIds([...(priorSkillsUsed ?? []), ...parseSkillsUsed(transcript)], installedSkillIds).map((id) => redactForPublish(id, opts.secretValues)) }
      : {}),
    ...(review !== undefined ? { verdict: review.verdict } : {}),
    ...(opts.modelPick !== undefined ? { provider: opts.modelPick.provider, pick: opts.modelPick.pick } : {}),
    ...(opts.credentialName !== undefined ? { credential: redactForPublish(opts.credentialName, opts.secretValues) } : {}),
    // Implement/revise runs pass their lesson ids (possibly none): how many the run loaded, 0 when none.
    ...(opts.lessonIds !== undefined ? { lessonsLoaded: opts.lessonIds.length, ...(opts.lessonIds.length > 0 ? { lessonIds: [...opts.lessonIds] } : {}) } : {}),
  };
  await appendMetric(repoPath, metric);
  return file;
}

/** Append one chained record to `.taskcell/runs/metrics.jsonl` (telemetry: best-effort, but a refused path throws; never rotated, since `stats` and `metrics push` read only the live file). */
async function appendMetric(repoPath: string, metric: object): Promise<void> {
  const file = join(runsRoot(repoPath), 'metrics.jsonl');
  await assertStatePath(repoPath, file); // a symlinked leaf or parent is refused loudly, not swallowed as telemetry
  await appendAudit(STREAMS.metrics, localAdapter({ file, repoPath, maxBytes: Number.POSITIVE_INFINITY }), metric as Record<string, unknown>, { actor: defaultActor() });
}

/**
 * Begin one run: a `RunWriter` handle that owns `taskId`'s timestamp, so proof.json, visual-proof.json
 * and every stage record share one prefix and the hub/desktop readers can match a run's proof to its
 * stage records by name. `timestamp` is only for deterministic tests — production callers pass
 * `undefined`. The injected credential values are snapshotted once here, for every record of the run.
 */
export function beginRun(
  repoPath: string,
  taskId: string,
  timestamp: string = new Date().toISOString(),
  runOpts: BeginRunOptions = {},
): RunWriter {
  const root = runsRoot(repoPath);
  const envSecretValues = injectedSecretValues(process.env, runOpts.secretEnvVars ?? []);
  // Plus values registered after this snapshot (an App token minted mid-run), merged at each write.
  const secretValues = (): string[] => withRegisteredSecretValues(envSecretValues);

  return {
    async writeStages(outcomes, opts = {}): Promise<void> {
      for (const outcome of outcomes) {
        await writeRecord(repoPath, taskId, timestamp, outcome.result, {
          secretValues: secretValues(),
          label: outcome.name,
          ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
          ...(outcome.model !== undefined ? { requestedModel: outcome.model } : {}),
          ...(opts.omitDiff ? { omitDiff: opts.omitDiff } : {}),
          ...(opts.imageDigest !== undefined ? { imageDigest: opts.imageDigest } : {}),
          ...(opts.llmCredential !== undefined ? { llmCredential: opts.llmCredential } : {}),
          ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
          ...(opts.configPaths !== undefined ? { configPaths: opts.configPaths } : {}),
          ...(opts.noChanges === true ? { noChanges: true } : {}),
          ...(opts.maxRepairIterations !== undefined ? { maxRepairIterations: opts.maxRepairIterations } : {}),
          ...(opts.credentialSource !== undefined ? { credentialSource: opts.credentialSource } : {}),
          ...(opts.credentialName !== undefined ? { credentialName: opts.credentialName } : {}),
          ...(runOpts.startedBy !== undefined ? { startedBy: runOpts.startedBy } : {}),
          ...(opts.lessonIds !== undefined ? { lessonIds: opts.lessonIds } : {}),
          ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
          ...(opts.skillIds !== undefined ? { skillIds: opts.skillIds } : {}),
          ...(opts.modelPicks?.[outcome.name] !== undefined ? { modelPick: opts.modelPicks[outcome.name] } : {}),
          ...(outcome.primaryAuthRefused !== undefined ? { primaryAuthRefused: outcome.primaryAuthRefused } : {}),
        });
      }
      const first = outcomes[0];
      if (first === undefined) return;
      const { omitDiff: _omitDiff, credentialName: _credentialName, llmCredential: _llmCredential, baseBranch: _baseBranch, configPaths: _configPaths, noChanges: _noChanges, maxRepairIterations: _maxRepairIterations, lessonIds: _lessonIds, skills: _skills, skillIds: _skillIds, modelPicks: _modelPicks, ...trace } = opts;
      await exportRunTrace({
        taskId,
        timestamp,
        stages: outcomes.map((o) => stageMetric(o.result, o.name, o.model !== undefined ? { requestedModel: o.model } : undefined)),
        ...trace,
      });
    },

    async writeProof(result, opts = {}): Promise<string> {
      const taskDir = await ensureStateDir(repoPath, join(root, taskId));
      const base = join(taskDir, sanitizeTimestamp(timestamp));
      const file = `${base}.proof.json`;
      await assertStatePath(repoPath, file);
      // outputTail and firstErrorLines are verbatim command output: masked like every other free text in the record.
      await writeFile(file, `${JSON.stringify(redactVerificationOutput(result, secretValues()), null, 2)}\n`);

      // A base-red proof is the base commit's verdict, not a verification of this run's work.
      const metric = { evt: opts.baseRed === true ? 'base_red' : 'verify', ts: timestamp, taskId, passed: result.passed, exitCode: result.exitCode, sha256: result.sha256 };
      await appendMetric(repoPath, metric);
      return file;
    },

    async writeVisualProof(result: VisualProofResult): Promise<string> {
      const taskDir = await ensureStateDir(repoPath, join(root, taskId));
      const base = join(taskDir, sanitizeTimestamp(timestamp));
      const file = `${base}.visual-proof.json`;
      await assertStatePath(repoPath, file);
      // Masked like proof.json (sha256 is over the full output there). On the did-not-run path
      // (exitCode -1) visual-proof.ts hashes `outputTail` itself, so the hash is recomputed over the
      // masked text to keep the stored proof verifiable.
      const outputTail = redactForPublish(result.outputTail, secretValues());
      const stored = {
        ...result,
        outputTail,
        ...(result.exitCode === -1 && outputTail !== result.outputTail ? { sha256: createHash('sha256').update(outputTail).digest('hex') } : {}),
      };
      await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

      const metric = {
        evt: 'visual_proof',
        ts: timestamp,
        taskId,
        passed: result.passed,
        exitCode: result.exitCode,
        sha256: stored.sha256,
        artifacts: result.artifacts.length,
      };
      await appendMetric(repoPath, metric);
      return file;
    },
  };
}

// ---------------------------------------------------------------------------
// Deprecated compatibility surface — one release, for the pre-RunWriter exports of src/index.ts
// ---------------------------------------------------------------------------

/** @deprecated Options of {@link persistRunRecord}; `beginRun().writeStages()` covers these. */
export interface PersistOptions {
  /** ISO timestamp; defaults to now. Injected for deterministic tests. */
  timestamp?: string;
  /** Stage name, when persisting a single stage of a multi-stage run. */
  label?: string;
  /** The PR opened for this run, if any. */
  prUrl?: string;
  /** Model the stage was configured with (StageOutcome.model); recorded next to the served `model`. */
  requestedModel?: string;
  /** See {@link WriteStagesOptions.omitDiff}. */
  omitDiff?: OmitDiff;
}

/**
 * @deprecated Use `beginRun(repoPath, taskId).writeStages([...])` — a writer owns the run's timestamp,
 * so its proof files share the stage records' prefix. Kept for one release of compatibility.
 */
export async function persistRunRecord(localRepoPath: string, result: RunResult, opts: PersistOptions = {}): Promise<string> {
  return writeRecord(localRepoPath, result.taskId, opts.timestamp ?? new Date().toISOString(), result, {
    secretValues: injectedSecretValues(),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
    ...(opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {}),
    ...(opts.omitDiff !== undefined ? { omitDiff: opts.omitDiff } : {}),
  });
}

/**
 * @deprecated Use `beginRun(repoPath, taskId).writeStages(outcomes, opts)`. Kept for one release of
 * compatibility; takes the run's taskId from the first outcome, as the old writer did.
 */
export async function persistStageOutcomes(
  localRepoPath: string,
  outcomes: ReadonlyArray<{ name: string; result: RunResult; model?: string }>,
  opts: WriteStagesOptions & { timestamp?: string } = {},
): Promise<void> {
  const first = outcomes[0];
  if (first === undefined) return;
  const { timestamp, ...rest } = opts;
  await beginRun(localRepoPath, first.result.taskId, timestamp).writeStages(outcomes, rest);
}

/**
 * Append one `{ evt: 'decision_probe', ts, taskId, ... }` line to metrics.jsonl — the log-only
 * difficulty probe, joined to the stage outcomes by taskId in `taskcell stats`. Independent of
 * `beginRun`: the probe runs (and may fail) before a run's timestamp is otherwise needed.
 */
export async function persistDecisionProbe(
  localRepoPath: string,
  taskId: string,
  probe: DecisionProbeResult,
  opts: { timestamp?: string } = {},
): Promise<void> {
  await ensureStateDir(localRepoPath, runsRoot(localRepoPath));
  const metric = { evt: 'decision_probe', ts: opts.timestamp ?? new Date().toISOString(), taskId, ...probe };
  await appendMetric(localRepoPath, metric);
}

/**
 * Append one `base_merge` line to `.taskcell/runs/metrics.jsonl`: how a reviser's check of a PR branch
 * against its base ended. `taskcell stats` and the hub's `conflict_stats` command (shown on the Runs page) roll these up as conflicts per week.
 */
export async function persistBaseMerge(
  localRepoPath: string,
  event: Omit<BaseMergeEvent, 'ts'>,
  opts: { timestamp?: string } = {},
): Promise<void> {
  await ensureStateDir(localRepoPath, runsRoot(localRepoPath));
  await appendMetric(localRepoPath, { evt: 'base_merge', ts: opts.timestamp ?? new Date().toISOString(), ...event });
}
