import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  /** Aborting kills the `git fetch` child (a fetch still queued for the tip lock never starts). */
  signal?: AbortSignal;
}

export interface BranchFileOptions {
  branch?: string;
  remote?: string;
  file?: string;
  signal?: AbortSignal;
}

export interface PushMetricsResult {
  branch: string;
  /** Lines appended (lines already on the branch are skipped, so a re-run never duplicates). */
  pushed: number;
  /** Lines the branch holds after the push. */
  total: number;
}

/** Signal a detached child's whole process group (its transport helpers too); the child alone where groups do not exist. */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, sig);
  } catch {
    // already gone
  }
}

const KILL_GRACE_MS = 2000;
/** Detached children still running, and killed ones inside their grace: a process exit sends them SIGKILL (an `unref`'d timer would never fire then). */
const liveGroups = new Set<number>();
const killing = new Set<number>();
let exitHooked = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => [...liveGroups, ...killing].forEach((p) => signalGroup(p, 'SIGKILL')));
}

/** SIGTERM first so git can remove its lockfiles; SIGKILL after a grace period for what ignores it. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  signalGroup(pid, 'SIGTERM');
  killing.add(pid);
  setTimeout(() => {
    killing.delete(pid);
    signalGroup(pid, 'SIGKILL');
  }, KILL_GRACE_MS).unref();
}

/**
 * Run git. With a signal, aborting settles the call at once and kills git's whole process group: killing
 * only `git fetch` leaves `git remote-http` alive holding the stderr pipe, so the child never settles
 * (and the tip lock its caller holds is never released).
 */
function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal === undefined) return execa('git', args, { cwd }).then((r) => r.stdout);
  signal.throwIfAborted();
  const child = execa('git', args, {
    cwd,
    detached: process.platform !== 'win32',
    // Never wait on a credential prompt nobody can answer.
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  const pid = child.pid;
  if (pid !== undefined) trackGroup(pid);
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => {
      killGroup(child.pid);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.then((r) => resolve(r.stdout), reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
      if (pid !== undefined) liveGroups.delete(pid);
    });
  });
}

/** The named ref a branch's tip is fetched into: unlike FETCH_HEAD, a concurrent fetch of another branch cannot overwrite it. */
export const tipRef = (remote: string, branch: string): string => `refs/taskcell/tips/${remote}/${branch}`;

// One fetch of a given tip ref at a time: two racing fetches of a moved tip fail with "cannot lock ref".
const tipLock = keyedLock();
/** Wait before the one retry of a fetch whose ref lock another process held past git's own 100 ms (the lock above is per process). */
const TIP_LOCK_RETRY_MS = 500;

/** The lock key of a tip fetch. By the repository's real path: a symlinked or relative spelling of it is the same repository. */
export function tipLockKey(cwd: string, remote: string, branch: string): string {
  let real = resolve(cwd);
  try {
    real = realpathSync(real);
  } catch {
    // a path that does not exist: the fetch reports it
  }
  return `${real}\0${remote}\0${branch}`;
}

const isLockError = (err: unknown): boolean => /cannot lock ref/i.test(String((err as { stderr?: unknown }).stderr ?? ''));

/** The branch tip's commit sha, or undefined when the remote has no such branch yet. */
function fetchTip(cwd: string, remote: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
  return tipLock(tipLockKey(cwd, remote, branch), async () => {
    // Aborted while queued: do not start a fetch nobody waits for.
    signal?.throwIfAborted();
    const ref = tipRef(remote, branch);
    const fetch = (): Promise<string> => git(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${ref}`], signal);
    const revParse = (args: string[]): Promise<string | undefined> => git(cwd, ['rev-parse', ...args, ref]).catch(() => undefined);
    try {
      await fetch();
    } catch (err) {
      // A killed fetch is a failure, not "no such branch".
      if (signal?.aborted) throw err;
      if (!isLockError(err)) return undefined;
      // Another process (a CLI run beside the hub) fetching the same ref: retry once rather than read as empty.
      await new Promise((r) => setTimeout(r, TIP_LOCK_RETRY_MS));
      try {
        await fetch();
      } catch (again) {
        if (signal?.aborted) throw again;
        if (!isLockError(again)) return undefined;
        // Still locked: read the tip ref as it stands (possibly behind) rather than report the branch absent.
        // With no tip ref yet the lock failure propagates: it is not "no such branch".
        return (await revParse(['--verify', '--quiet'])) ?? Promise.reject(again);
      }
    }
    return revParse([]);
  });
}

/**
 * fetchTip, except that the default branch falls back to the legacy one while it does not exist yet:
 * readers keep seeing the old history, and the first append starts the new branch on top of it. An
 * explicit `--branch` never falls back.
 */
async function fetchTipWithLegacy(cwd: string, remote: string, branch: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  const tip = await fetchTip(cwd, remote, branch ?? METRICS_BRANCH_DEFAULT, signal);
  if (tip !== undefined || branch !== undefined) return tip;
  return fetchTip(cwd, remote, METRICS_BRANCH_LEGACY, signal);
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
  return fileAtName(repoPath, await fetchTipWithLegacy(repoPath, remote, opts.branch, opts.signal), file);
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
      '-c', 'user.name=Taskcell', '-c', 'user.email=vanguard@local',
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
