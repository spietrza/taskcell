import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { labelValue } from './labels.js';
import { TaskcellError } from './errors.js';
import { createLogger } from './logger.js';
import { redactTokens } from './secret-scan.js';
import { stateDir } from './state-path.js';
import type { TaskcellLogger } from './logger.js';

/**
 * Reject a base branch git would misread when it is passed as a bare argument. A leading "-" parses
 * as an option (e.g. --upload-pack=<cmd>). A ":" or a leading "+" makes `git fetch origin <base>` a
 * refspec that writes, or force-overwrites, a local branch. A blank base names no branch at all, and
 * git never allows a control character in a ref, which would otherwise reach log lines raw.
 */
export function assertSafeBaseBranch(base: string): void {
  if (base.trim() === '') throw new TaskcellError('Invalid base branch: it cannot be empty');
  if (base.startsWith('-') || base.startsWith('+') || base.includes(':') || /[\x00-\x1f\x7f]/.test(base)) {
    throw new TaskcellError(`Invalid base branch ${JSON.stringify(base)}: it cannot start with "-" or "+", or contain ":" or a control character`);
  }
  // Refspec globs and ref-syntax characters: `*` would turn `+refs/heads/<base>:refs/remotes/origin/<base>`
  // into a wildcard fetch of every branch; the rest can never name a branch (git check-ref-format).
  if (/[\s*?\[\]~^\\]|\.\.|@\{|\/$|\.lock$/.test(base)) {
    throw new TaskcellError(`Invalid base branch ${JSON.stringify(base)}: it cannot contain whitespace, "*", "?", "[", "]", "~", "^", "\\", "..", "@{", or end with "/" or ".lock"`);
  }
}

/** The base a run targets when no `--base` is given. Every default goes through this name, never a bare literal. */
export const DEFAULT_BASE_BRANCH = 'main';

/**
 * Issue label that carries a card's target branch: `taskcell:base=<branch>` (like `taskcell:model=<m>`).
 * Trust: anyone who can label the issue (GitHub triage) can set it, so it only SELECTS among the targets a
 * maintainer committed — the repo default plus `baseBranches` in `.taskcell/app.json` (see readAllowedBases).
 */
export const BASE_LABEL_PREFIX = 'taskcell:base=';

/** True for a `taskcell:base=` label. It names a branch, not a lifecycle state, so board column/chip reads skip it. */
export function isBaseLabel(label: string): boolean {
  return labelValue(label, BASE_LABEL_PREFIX) !== undefined;
}

/**
 * The target branch a card names, from its labels, or undefined when it names none. The one reader of
 * `taskcell:base=` labels. A label with an empty or unsafe value, or two labels naming different branches,
 * is refused, not ignored: opening the PR against some other branch than the one the card asked for is
 * worse than not running.
 * @throws TaskcellError (see assertSafeBaseBranch).
 */
export function baseFromLabels(labels: ReadonlyArray<string>): string | undefined {
  const values = [...new Set(labels.filter(isBaseLabel).map((l) => (labelValue(l, BASE_LABEL_PREFIX) ?? '').trim()))];
  if (values.length > 1) throw new TaskcellError(`Conflicting target branches: the card carries ${values.map((v) => `${BASE_LABEL_PREFIX}${v}`).join(', ')} — keep exactly one`);
  const value = values[0];
  if (value === undefined) return undefined;
  assertSafeBaseBranch(value);
  return value;
}

/** For display only (board, Needs-you): the card's target branch, or undefined when it names none or names it badly. */
export function shownBaseFromLabels(labels: ReadonlyArray<string>): string | undefined {
  try {
    return baseFromLabels(labels);
  } catch {
    return undefined;
  }
}

/** `.taskcell/app.json`, read leniently like the board config: anything unreadable or not an object is `{}`. */
async function readAppJson(repoPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir(repoPath), 'app.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A configured branch name: trimmed, undefined when blank, refused when unsafe. */
function configuredBranch(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return undefined;
  assertSafeBaseBranch(value);
  return value;
}

/**
 * The repository's default target branch: `baseBranch` in `.taskcell/app.json`. Undefined when the file
 * or key is absent. A set but unsafe value is refused.
 * @throws TaskcellError (see assertSafeBaseBranch).
 */
export async function readRepoBaseBranch(repoPath: string): Promise<string | undefined> {
  return configuredBranch((await readAppJson(repoPath)).baseBranch);
}

/**
 * The branches a `taskcell:base=` label may select: the repo default (`baseBranch`, else `main`) plus the
 * `baseBranches` list in `.taskcell/app.json`. With no list, only the default — a label can never point a
 * PR anywhere a maintainer did not commit. An unsafe entry is refused.
 * @throws TaskcellError (see assertSafeBaseBranch).
 */
export async function readAllowedBases(repoPath: string): Promise<string[]> {
  const cfg = await readAppJson(repoPath);
  const extra = Array.isArray(cfg.baseBranches) ? cfg.baseBranches.map(configuredBranch).filter((b): b is string => b !== undefined) : [];
  return [...new Set([configuredBranch(cfg.baseBranch) ?? DEFAULT_BASE_BRANCH, ...extra])];
}

/** Refuse a label-selected target that is not in the committed allowlist. @throws TaskcellError */
export function assertAllowedBase(base: string, allowed: ReadonlyArray<string>): void {
  if (!allowed.includes(base)) {
    throw new TaskcellError(`Target branch ${JSON.stringify(base)} is not allowed: a ${BASE_LABEL_PREFIX} label may only name ${allowed.join(', ')} (add it to baseBranches in .taskcell/app.json)`);
  }
}

/**
 * The branch a run's PR targets: an explicit `--base`, else the card's label (if allowlisted), else the repo
 * default, else `main`.
 */
export async function resolveTargetBase(repoPath: string, labels: ReadonlyArray<string>, explicit?: string): Promise<string> {
  // An explicit --base is the operator's own flag: checked by prepareContext/resolveRemoteBaseRef, not allowlisted.
  if (explicit !== undefined) return explicit;
  const labelled = baseFromLabels(labels);
  if (labelled === undefined) return (await readRepoBaseBranch(repoPath)) ?? DEFAULT_BASE_BRANCH;
  assertAllowedBase(labelled, await readAllowedBases(repoPath));
  return labelled;
}

/**
 * A base taken from a PR/MR record, or the default when the API left it out. The fallback is announced:
 * a review that silently reads the wrong branch is the failure this module exists to prevent.
 */
export function baseBranchOrDefault(base: string, what: string): string {
  if (base !== '') return base;
  console.warn(`taskcell: ${what} carries no base branch — reviewing against ${DEFAULT_BASE_BRANCH}`);
  return DEFAULT_BASE_BRANCH;
}

export interface ResolveRemoteBaseRefOptions {
  logger?: TaskcellLogger;
  /** Log-line prefix naming the pass ('spec', 'worktree'). */
  label?: string;
  /**
   * Keep a local base that is ahead of or diverged from origin (it may carry unpushed commits).
   * Default: outside CI only (`CI` unset, empty or "false") — on a CI checkout the local branch is the
   * event SHA and can never hold unpushed work, so there the remote copy always wins.
   */
  keepLocalIfAhead?: boolean;
}

/** Git never prompts for credentials from a daemon; an unreachable origin fails fast instead. */
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0' } as const;
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Resolve the commit a task worktree is cut from: fetch `base` from `origin` and prefer the remote
 * copy when it is ahead of the local branch, so the run (sandbox, verification, review) sees the
 * branch as it exists on the remote — on Actions the checkout is the event SHA and main may already
 * have moved (#423). Returns the remote tip as a SHA (immune to a concurrent run's fetch moving the
 * tracking ref, and to a same-named tag), or `refs/heads/<base>` when the local branch is kept, or
 * the bare `base` when no local branch exists. Best-effort: with no `origin`, offline, or a branch the
 * remote does not carry, it logs and returns the local base so the run still happens. The fetch
 * names its destination ref, so a single-branch clone (actions/checkout) tracks the base too.
 *
 * @throws TaskcellError when git would misread `base` (see assertSafeBaseBranch).
 */
export async function resolveRemoteBaseRef(repoPath: string, base: string, opts: ResolveRemoteBaseRefOptions = {}): Promise<string> {
  assertSafeBaseBranch(base);
  const label = opts.label ?? 'worktree';
  const keepLocal = opts.keepLocalIfAhead ?? !isCI();
  // Default a logger so the resolved baseline is ALWAYS announced — the one positive signal that tells
  // you which ref the run was actually cut from (vs a silent fallback to a stale local copy).
  const log = opts.logger ?? createLogger();
  const localRef = `refs/heads/${base}`;
  const hasLocal = (await execa('git', ['rev-parse', '--verify', '--quiet', localRef], { cwd: repoPath, reject: false })).exitCode === 0;
  const local = hasLocal ? localRef : base;   // the full ref: a same-named tag must not shadow the branch
  const hasOrigin = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).then(() => true, () => false);
  if (!hasOrigin) {
    log.info({ base }, `${label}: no origin remote — using local ${base}`);
    return local;
  }
  const remoteRef = `refs/remotes/origin/${base}`;
  const fetch = await fetchWithLockRetry(repoPath, `+${localRef}:${remoteRef}`, remoteRef, log, label);
  if (fetch.exitCode !== 0 && fetch.lockLost) {
    // Every attempt lost the lock: whoever held it has written the current value into the tracking
    // ref, so reading that beats falling back to the stale local base (#434).
    const held = (await execa('git', ['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repoPath, reject: false })).stdout.trim();
    if (held !== '') log.warn({ base, sha: held }, `${label}: ${remoteRef} stayed locked by concurrent fetches — using the value they wrote`);
    else log.warn({ base }, `${label}: ${remoteRef} stayed locked by concurrent fetches and is empty — using local ${base}`);
    if (held === '') return local;
  } else if (fetch.exitCode !== 0) {
    if (/couldn't find remote ref|remote ref does not exist/i.test(fetch.stderr)) {
      log.warn({ base }, `${label}: origin has no ${base} — using local ${base}`);
    } else {
      log.warn({ base, reason: redactGitError(fetch) }, `${label}: git fetch origin ${base} failed — using local ${base} (may be stale)`);
    }
    return local;
  }
  const sha = (await execa('git', ['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repoPath, reject: false })).stdout.trim();
  if (sha === '') {
    log.warn({ base }, `${label}: ${remoteRef} missing after the fetch — using local ${base}`);
    return local;
  }
  if (hasLocal && keepLocal) {
    // Exit 1 = local is ahead of or diverged from origin: keep it, it may carry unpushed commits.
    // Any other failure is a git error, reported as such; the remote copy is still the better cut.
    const ancestor = await execa('git', ['merge-base', '--is-ancestor', localRef, sha], { cwd: repoPath, reject: false });
    if (ancestor.exitCode === 1) {
      log.warn({ base, sha }, `${label}: local ${base} is ahead of or diverged from origin/${base} — using local ${base}`);
      return local;
    }
    if (ancestor.exitCode !== 0) log.warn({ base, reason: redactGitError(ancestor) }, `${label}: git merge-base failed — assuming origin/${base} is current`);
  }
  log.info({ base, sha }, `${label}: using origin/${base} @ ${sha.slice(0, 7)}`);
  return sha;
}

/**
 * git could not take the ref lock: another fetch in the same repository holds it (fan-out). Only the
 * `.lock` file message — the bare "cannot lock ref" also covers the permanent directory/file ref
 * conflict (`refs/remotes/origin/dev` vs `dev/sub`), which no retry can fix.
 */
const REF_LOCK_RE = /unable to create '.*\.lock'/i;
const LOCK_RETRIES = 3;
const LOCK_BACKOFF_MS = 250;

/**
 * `watch --concurrency` runs several tasks against one repoPath, and each resolves its base with a
 * fetch into the same `refs/remotes/origin/<base>`; the loser of that ref lock would otherwise fall
 * back to the stale local base — the #429 mismatch again (#434). Retry only the lock failure, with a
 * short backoff; every other failure is returned unchanged.
 */
interface FetchResult { exitCode: number | undefined; stderr: string; timedOut: boolean; lockLost: boolean }

async function fetchWithLockRetry(repoPath: string, refspec: string, remoteRef: string, log: TaskcellLogger, label: string): Promise<FetchResult> {
  let last = await runFetch(repoPath, refspec);
  // A timed-out fetch is never retried: it already spent the full budget, and its partial stderr may
  // happen to contain a lock line.
  for (let attempt = 1; attempt <= LOCK_RETRIES && last.lockLost; attempt += 1) {
    log.warn({ remoteRef, attempt }, `${label}: ${remoteRef} is locked by a concurrent fetch — retrying`);
    // Jitter so N losers of the same ref do not retry on the same grid.
    await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS * attempt + Math.random() * 100));
    last = await runFetch(repoPath, refspec);
  }
  return last;
}

async function runFetch(repoPath: string, refspec: string): Promise<FetchResult> {
  const r = await execa('git', ['fetch', '--end-of-options', 'origin', refspec], { cwd: repoPath, reject: false, env: FETCH_ENV, timeout: FETCH_TIMEOUT_MS });
  return { exitCode: r.exitCode, stderr: r.stderr, timedOut: r.timedOut, lockLost: r.exitCode !== 0 && !r.timedOut && REF_LOCK_RE.test(r.stderr) };
}

/** GitHub Actions and most CI set CI=true; unset, empty, "false" or "0" is not CI. */
function isCI(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

/** First `fatal:` line (or first line) of a git error, tokens and URL userinfo masked. */
export function redactGitError(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err);
  const line = text.split('\n').find((l) => l.startsWith('fatal:')) ?? text.split('\n')[0] ?? '';
  return redactTokens(line).replace(/\/\/[^/@\s]+@/g, '//***@');
}
