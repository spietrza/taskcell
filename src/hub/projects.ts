// Port of apps/desktop/src-tauri/src/projects.rs — see that file for the original Rust implementation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readAppConfig } from './app-config.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import { listActive } from './active.js';
import { fanOut } from '../pipeline/fan-out.js';
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

function repoNameOf(repoPath: string): string {
  const base = basename(repoPath);
  return base !== '' ? base : repoPath;
}

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

export async function list(configDir: string): Promise<Project[]> {
  const paths = await loadPaths(configDir);
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
): Promise<{ items: (T & RepoStamp)[]; failures: RepoReadFailure[] }> {
  const paths = await loadPaths(configDir);
  const outcomes = await fanOut(paths, async (repoPath) => read(await resolve(repoPath)), { concurrency: 4 });
  const items: (T & RepoStamp)[] = [];
  const failures: RepoReadFailure[] = [];
  for (const o of outcomes) {
    const stamp = { repoPath: o.item, repoName: repoNameOf(o.item) };
    if (o.status === 'fulfilled') items.push(...o.value.map((i) => ({ ...i, ...stamp })));
    else failures.push({ ...stamp, error: o.reason instanceof Error ? o.reason.message : String(o.reason) });
  }
  return { items, failures };
}
