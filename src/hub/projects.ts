// Port of apps/desktop/src-tauri/src/projects.rs — see that file for the original Rust implementation.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readAppConfig } from './app-config.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import { listActive } from './active.js';
import { fanOut } from '../pipeline/fan-out.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { RepoReadFailure, RepoStamp } from '../wire.js';

export interface Project {
  path: string;
  name: string;
  runCount: number;
  taskCount: number;
  totalCostUsd: number;
  failedCount: number;
  lastRun?: string;
  /** In-flight runs right now (from active sessions). */
  runningCount: number;
  /** Completed runs whose timestamp is within the last 24h (velocity). */
  runsLast24h: number;
  /** Configured per-project color (`#rrggbb`), or undefined -> the UI derives one from the path. */
  color?: string;
}

function projectsFile(configDir: string): string {
  return join(configDir, 'projects.json');
}

/** The persisted project list is just an array of repo paths; metrics are recomputed on read. */
export async function loadPaths(configDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(projectsFile(configDir), 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      return [];
    }
    throw e;
  }
  // Surface a corrupt store as an error — do NOT default to empty, or the next add/remove would
  // save_paths over it and wipe the user's whole project list.
  return JSON.parse(raw) as string[];
}

export async function savePaths(configDir: string, paths: string[]): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(projectsFile(configDir), JSON.stringify(paths, null, 2));
}

const repoDisplayName = (repoPath: string): string => basename(repoPath) || repoPath;

/** Aggregate a repo's `.taskcell/runs` into a dashboard summary (+ live running count). */
export async function aggregate(repoPath: string, now: Date = new Date()): Promise<Project> {
  const name = repoDisplayName(repoPath);
  const [summaries, runningCount, { color }] = await Promise.all([
    listRunSummaries(defaultRunsRoot(repoPath)),
    listActive(repoPath).then((active) => active.length),
    readAppConfig(repoPath),
  ]);
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;

  const tasks = new Set<string>();
  let totalCostUsd = 0;
  let failedCount = 0;
  let runsLast24h = 0;
  let lastRun: string | undefined;
  for (const s of summaries) {
    tasks.add(s.taskId);
    totalCostUsd += s.totalCostUsd;
    if (s.anyFailed) {
      failedCount += 1;
    }
    if (lastRun === undefined || s.timestamp > lastRun) {
      lastRun = s.timestamp;
    }
    const parsed = new Date(s.timestamp).getTime();
    if (!Number.isNaN(parsed) && parsed >= cutoff) {
      runsLast24h += 1;
    }
  }

  return {
    path: repoPath,
    name,
    runCount: summaries.length,
    taskCount: tasks.size,
    totalCostUsd,
    failedCount,
    ...(lastRun !== undefined ? { lastRun } : {}),
    runningCount,
    runsLast24h,
    ...(color !== undefined ? { color } : {}),
  };
}

/** The hub's project paths, limited to `only` when given. */
async function loadScopedPaths(configDir: string, only?: readonly string[]): Promise<string[]> {
  const paths = await loadPaths(configDir);
  return only === undefined ? paths : paths.filter((p) => only.includes(p));
}

export async function list(configDir: string, only?: readonly string[]): Promise<Project[]> {
  const paths = await loadScopedPaths(configDir, only);
  return Promise.all(paths.map((p) => aggregate(p)));
}

/** Add a path (de-duped — adding an already-present path is a no-op for the stored list). */
export async function add(configDir: string, path: string): Promise<Project[]> {
  const paths = await loadPaths(configDir);
  if (!paths.includes(path)) {
    paths.push(path);
  }
  await savePaths(configDir, paths);
  return list(configDir);
}

/** Remove a path (idempotent — removing an absent path is fine). */
export async function remove(configDir: string, path: string): Promise<Project[]> {
  const paths = (await loadPaths(configDir)).filter((p) => p !== path);
  await savePaths(configDir, paths);
  return list(configDir);
}

/**
 * Run `read` over every project (the same loop as `list`) and stamp each returned item with its
 * repository. One repository failing does not empty the rest: it is named in `failures` instead.
 * `resolve` gates each path (the hub's allowlist) inside that isolation. Bounded concurrency: each
 * read can start `gh` subprocesses or tracker calls.
 */
export async function listAcrossProjects<T extends object>(
  configDir: string,
  resolve: (repoPath: string) => Promise<string>,
  read: (repoPath: string) => Promise<T[]>,
  only?: readonly string[],
): Promise<{ items: (T & RepoStamp)[]; failures: RepoReadFailure[] }> {
  const paths = await loadScopedPaths(configDir, only);
  const outcomes = await fanOut(paths, async (repoPath) => read(await resolve(repoPath)), { concurrency: 4 });
  const items: (T & RepoStamp)[] = [];
  const failures: RepoReadFailure[] = [];
  for (const o of outcomes) {
    const stamp = { repoPath: o.item, repoName: repoDisplayName(o.item) };
    if (o.status === 'fulfilled') items.push(...o.value.map((i) => ({ ...i, ...stamp })));
    else failures.push({ ...stamp, error: failureMessage(o.reason) });
  }
  return { items, failures };
}

/** A failure's error goes to the browser: redacted, and capped so one runaway message cannot flood the list. */
const MAX_FAILURE_ERROR = 300;
function failureMessage(reason: unknown): string {
  const text = redactForPublish(reason instanceof Error ? reason.message : String(reason));
  return text.length > MAX_FAILURE_ERROR ? `${text.slice(0, MAX_FAILURE_ERROR)}…` : text;
}

/** The registered project path `input` names (exact, or the same directory through a symlink), as
 * stored in projects.json — teams store that string so list filters and removals match it. */
export async function registeredPath(configDir: string, input: string): Promise<string | undefined> {
  const paths = await loadPaths(configDir);
  if (paths.includes(input)) return input;
  const real = await realpath(input).catch(() => undefined);
  if (real === undefined) return undefined;
  for (const p of paths) if ((await realpath(p).catch(() => undefined)) === real) return p;
  return undefined;
}
