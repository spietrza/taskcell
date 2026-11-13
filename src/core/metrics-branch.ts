import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseJsonlLines } from './stats.js';
import { stateDir } from './state-path.js';
import { keyedLock } from './keyed-lock.js';

/**
 * Durable run metrics for hosts whose checkout does not survive the run (GitHub Actions): the
 * `metrics.jsonl` lines a run wrote under `.taskcell/runs/` are appended to a single file on an
 * orphan branch of the repo, with git plumbing only — no checkout, no worktree, no merge. The branch
 * can hold more than one file (e.g. the approver's decisions.jsonl); appendBranchLines preserves every
 * tree entry it does not touch, so unrelated files never conflict with each other. `taskcell stats
 * --branch` reads the metrics copy from anywhere the repo is cloned.
 */
export const METRICS_BRANCH_DEFAULT = 'taskcell-metrics';
/** The default before the Taskcell rename; read (and continued from) while the new default does not exist yet. */
export const METRICS_BRANCH_LEGACY = 'vanguard-metrics';
export const METRICS_FILE = 'metrics.jsonl';

export interface MetricsBranchOptions {
  branch?: string;
  remote?: string;
}

export interface BranchFileOptions {
  branch?: string;
  remote?: string;
  file?: string;
}

export interface PushMetricsResult {
  branch: string;
  /** Lines appended (lines already on the branch are skipped, so a re-run never duplicates). */
  pushed: number;
  /** Lines the branch holds after the push. */
  total: number;
}

const git = (cwd: string, args: string[]): Promise<string> =>
  execa('git', args, { cwd }).then((r) => r.stdout);

/** The named ref a branch's tip is fetched into: unlike FETCH_HEAD, a concurrent fetch of another branch cannot overwrite it. */
export const tipRef = (remote: string, branch: string): string => `refs/taskcell/tips/${remote}/${branch}`;

// One fetch of a given tip ref at a time: two racing fetches of a moved tip fail with "cannot lock ref".
const tipLock = keyedLock();

/** The branch tip's commit sha, or undefined when the remote has no such branch yet. */
function fetchTip(cwd: string, remote: string, branch: string): Promise<string | undefined> {
  return tipLock(`${cwd}\0${remote}\0${branch}`, async () => {
    try {
      const ref = tipRef(remote, branch);
      await git(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${ref}`]);
      return await git(cwd, ['rev-parse', ref]);
    } catch {
      return undefined;
    }
  });
}

/**
 * fetchTip, except that the default branch falls back to the legacy one while it does not exist yet:
 * readers keep seeing the old history, and the first append starts the new branch on top of it. An
 * explicit `--branch` never falls back.
 */
async function fetchTipWithLegacy(cwd: string, remote: string, branch: string | undefined): Promise<string | undefined> {
  const tip = await fetchTip(cwd, remote, branch ?? METRICS_BRANCH_DEFAULT);
  if (tip !== undefined || branch !== undefined) return tip;
  return fetchTip(cwd, remote, METRICS_BRANCH_LEGACY);
}

async function fileAtName(cwd: string, commit: string | undefined, file: string): Promise<string> {
  if (commit === undefined) return '';
  try {
    return await git(cwd, ['show', `${commit}:${file}`]);
  } catch {
    return '';
  }
}

/** The named file as currently on the branch ('' when absent or the branch does not exist). */
export async function readBranchFile(repoPath: string, opts: BranchFileOptions = {}): Promise<string> {
  const remote = opts.remote ?? 'origin';
  const file = opts.file ?? METRICS_FILE;
  return fileAtName(repoPath, await fetchTipWithLegacy(repoPath, remote, opts.branch), file);
}

/** The metrics file as currently on the branch ('' when the branch does not exist). */
export async function readBranchMetrics(repoPath: string, opts: MetricsBranchOptions = {}): Promise<string> {
  return readBranchFile(repoPath, { ...opts, file: METRICS_FILE });
}

/** `git ls-tree <tip>` entries other than `file`, kept byte-for-byte so a mktree rewrite never drops a sibling file. */
async function sidelinedEntries(cwd: string, tip: string | undefined, file: string): Promise<string[]> {
  if (tip === undefined) return [];
  const out = await git(cwd, ['ls-tree', tip]);
  return out.split('\n').filter((entry) => entry.trim() !== '' && !entry.endsWith(`\t${file}`));
}

/**
 * Append JSONL lines to `opts.file` on the branch, preserving every other tree entry (so, for example,
 * `decisions.jsonl` and `metrics.jsonl` can coexist on the same orphan branch). Dedupe: by
 * `opts.key(record)` when given (skipping any record a key maps to undefined for), else by exact line
 * (the original metrics semantics). A malformed input line is dropped. Idempotent per key/line; a
 * concurrent push from another run is retried once on a fresh tip.
 */
export async function appendBranchLines(
  repoPath: string,
  lines: string[],
  opts: BranchFileOptions & {
    file: string;
    key?: (record: Record<string, unknown>) => string | undefined;
    /** Rewrites the records about to be appended (after dedupe), given what the branch already holds: the audit chain hooks in here, inside the retry loop. */
    seal?: (fresh: Record<string, unknown>[], existing: Record<string, unknown>[]) => Record<string, unknown>[];
  },
): Promise<PushMetricsResult> {
  const branch = opts.branch ?? METRICS_BRANCH_DEFAULT;
  const remote = opts.remote ?? 'origin';
  const file = opts.file;

  for (let attempt = 0; ; attempt += 1) {
    const tip = await fetchTipWithLegacy(repoPath, remote, opts.branch);
    const existingText = await fileAtName(repoPath, tip, file);
    const existingRecords = parseJsonlLines(existingText);
    const existingLines = existingRecords.map((o) => JSON.stringify(o));
    const seenKeys = new Set<string>(
      opts.key !== undefined
        ? existingRecords.map((r) => opts.key!(r)).filter((k): k is string => k !== undefined)
        : existingLines,
    );

    const freshRecords: Record<string, unknown>[] = [];
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const dedupeKey = opts.key !== undefined ? opts.key(parsed) : JSON.stringify(parsed);
      if (dedupeKey === undefined || seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      freshRecords.push(parsed);
    }
    const fresh = (opts.seal !== undefined && freshRecords.length > 0 ? opts.seal(freshRecords, existingRecords) : freshRecords).map((r) => JSON.stringify(r));
    if (fresh.length === 0) return { branch, pushed: 0, total: existingLines.length };

    const content = `${[...existingLines, ...fresh].join('\n')}\n`;
    const blob = (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: repoPath, input: content })).stdout;
    const others = await sidelinedEntries(repoPath, tip, file);
    const treeInput = `${[...others, `100644 blob ${blob}\t${file}`].join('\n')}\n`;
    const tree = (await execa('git', ['mktree'], { cwd: repoPath, input: treeInput })).stdout;
    const message = `${file}: +${fresh.length} line${fresh.length === 1 ? '' : 's'}`;
    const commit = await git(repoPath, [
      '-c', 'user.name=Vanguard', '-c', 'user.email=vanguard@local',
      'commit-tree', tree, ...(tip !== undefined ? ['-p', tip] : []), '-m', message,
    ]);
    try {
      await git(repoPath, ['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
      return { branch, pushed: fresh.length, total: existingLines.length + fresh.length };
    } catch (err) {
      // Another run pushed in between: re-fetch and append on top of its tip, once.
      if (attempt >= 1) throw err;
    }
  }
}

/**
 * Append the local run's metric lines to the branch and push. Idempotent: lines already present are
 * skipped. A concurrent push from another run is retried once on a fresh tip. Never throws for "no
 * local metrics" — a run that produced none has nothing to persist.
 */
export async function pushMetrics(repoPath: string, opts: MetricsBranchOptions = {}): Promise<PushMetricsResult> {
  const branch = opts.branch ?? METRICS_BRANCH_DEFAULT;
  const remote = opts.remote ?? 'origin';
  let localText = '';
  try {
    localText = await readFile(join(stateDir(repoPath), 'runs', METRICS_FILE), 'utf8');
  } catch {
    return { branch, pushed: 0, total: 0 };
  }
  return appendBranchLines(repoPath, localText.split('\n'), { ...(opts.branch !== undefined ? { branch: opts.branch } : {}), remote, file: METRICS_FILE });
}
