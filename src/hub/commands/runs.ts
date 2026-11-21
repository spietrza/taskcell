// Hub commands: run history: persisted run records, events, CI imports, live sessions. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError, invokeCoreMethod } from '../../sidecar/sidecar.js';
import { defaultRunsRoot, remoteRunsRoot, listRunSummaries, readRunDetail, readConflictStats } from '../runs.js';
import { withCiRuns } from '../ci-metrics.js';
import { readAppConfig } from '../app-config.js';
import { listHubBoard } from '../hub-board.js';
import { readRunEvents } from '../run-events.js';
import { isSafeTaskId } from '../../core/state-path.js';
import { listActive, readSession } from '../active.js';
import * as projects from '../projects.js';
import * as remote from '../remote.js';
import { taskRefKey } from '../../tasks/board.js';
import type { ActiveRun, ConflictStats, RemoteImport, RemoteRun, RepoReadFailure, RepoStamp, RunDetail, RunSource, RunSummary, SessionRead } from '../../wire.js';
import { defineCommands, requireString, optionalString, optionalNumber, assertHasRemote } from '../command-kit.js';

export interface RunsCommands {
  list_runs: { args: { repoPath: string }; result: RunSummary[] };
  /** HUB_ONLY: `list_runs` across every hub repository, each row stamped with its repository. */
  list_runs_all: { args: { teamId?: string } | undefined; result: { runs: (RunSummary & RepoStamp)[]; failures: RepoReadFailure[] } };
  read_run: { args: { repoPath: string; taskId: string; timestamp: string; source: RunSource }; result: RunDetail };
  /** HUB_ONLY, read-only: a run's persisted event log (`.taskcell/runs/<taskId>/events-*.jsonl`), events with
   *  `id > after` (the SSE `id:`), at most `limit`; `timestamp` (a run record's, from `list_runs`) picks that run, default the newest. */
  read_run_events: {
    args: { repoPath: string; taskId: string; timestamp?: string; after?: number; limit?: number };
    result: { events: { id: number; ts: string; event: string; data: unknown }[]; nextAfter: number; hasMore: boolean; truncated: boolean };
  };
  list_remote_runs: { args: { repoPath: string }; result: RemoteRun[] };
  /** Both backends implement this: Tauri downloads+caches under the app config dir, the hub under
   * the project's `.taskcell/remote-runs/<id>` — each resolves `source: { kind: 'ci', runId }` for
   * a later `read_run` to its own root. A cache hit skips `gh run download` on both sides. */
  import_remote_run: { args: { repoPath: string; runId: number }; result: RemoteImport };
  list_active: { args: { repoPath: string }; result: ActiveRun[] };
  read_session: { args: { sessionFile: string }; result: SessionRead };
  /** HUB_ONLY, read-only: conflicts with the base per week (total, auto-resolved, left for a human) and the top conflicted files, as `taskcell stats` prints them. */
  conflict_stats: { args: { repoPath: string }; result: ConflictStats };
}

/** `read_run`'s `source` (wire's `RunSource`) → the root the records live under: the project's own
 * `.taskcell/runs`, or a CI run's imported `.taskcell/remote-runs/<id>`. The client never names a
 * root — the same discriminant resolves against the Tauri cache dir on the desktop side. */
function runSourceRoot(repoPath: string, raw: unknown): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (source.kind === 'local') return defaultRunsRoot(repoPath);
  if (source.kind === 'ci' && typeof source.runId === 'number') return remoteRunsRoot(repoPath, source.runId);
  throw new BadRequestError("source is required and must be { kind: 'local' } or { kind: 'ci', runId: number }");
}

/** The board's done cards per repository, kept briefly: a tracker read per listing would slow every Runs refresh. */
const DONE_TTL_MS = 30_000;
const doneCache = new Map<string, { at: number; done: Set<string> }>();

/**
 * Runs whose card sits in the board's Done column: one with a PR is marked merged, a passed one without a PR (a hub card's
 * local branch) or one whose agent stopped to ask `cardDone`. Best effort: a board that cannot be read leaves them unmarked. `listBoard` reads a hub board
 * (its tasks are the hub's, not the tracker's); absent, the tracker is read through core.
 */
export async function markMerged<T extends RunSummary>(deps: Parameters<typeof invokeCoreMethod>[0], repoPath: string, runs: T[], listBoard?: () => Promise<{ id: string; column: string }[]>): Promise<T[]> {
  if (runs.length === 0) return runs;
  try {
    let entry = doneCache.get(repoPath);
    if (entry === undefined || Date.now() - entry.at > DONE_TTL_MS) {
      const tasks = listBoard !== undefined ? await listBoard() : ((await invokeCoreMethod(deps, 'listTasks', { repoPath })) as { tasks: { id: string; column: string }[] }).tasks;
      entry = { at: Date.now(), done: new Set(tasks.filter((t) => t.column === 'done').map((t) => taskRefKey(t.id))) };
      doneCache.set(repoPath, entry);
    }
    const { done } = entry;
    return runs.map((r) => {
      if (!done.has(taskRefKey(r.taskId))) return r;
      if (r.prUrl !== undefined) return { ...r, prState: 'merged' as const };
      // A done card waits on no answer (Home's inbox drops it too): its asked run is marked so it reads "stopped to ask".
      return r.anyFailed && r.asked === undefined ? r : { ...r, cardDone: true as const };
    });
  } catch {
    return runs;
  }
}

/** A hub-board project's board reader for markMerged; undefined for a tracker project. */
async function hubBoardReader(configDir: string, real: string): Promise<(() => Promise<{ id: string; column: string }[]>) | undefined> {
  return (await readAppConfig(real)).taskSource === 'hub' ? async () => (await listHubBoard(configDir, real)).tasks : undefined;
}

/** Marks a hub-board project's done-card runs for the project summary; a tracker project is left as is (no tracker read). */
export const hubDoneMarker = (ctx: { deps: Parameters<typeof invokeCoreMethod>[0]; configDir: string }): projects.MarkDone => async (real, runs) => {
  const reader = await hubBoardReader(ctx.configDir, real);
  return reader === undefined ? runs : markMerged(ctx.deps, real, runs, reader);
};

export const commands = defineCommands<RunsCommands>({
  list_runs: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return markMerged(ctx.deps, real, await withCiRuns(real, await listRunSummaries(defaultRunsRoot(real))), await hubBoardReader(ctx.configDir, real));
  },
  list_runs_all: async ({ ctx, allow, scope }) => {
    const { items, failures } = await projects.listAcrossProjects(
      ctx.configDir,
      allow,
      async (real) => markMerged(ctx.deps, real, await withCiRuns(real, await listRunSummaries(defaultRunsRoot(real))), await hubBoardReader(ctx.configDir, real)),
      await scope(),
    );
    // Newest first across repositories, as each repository's own list is.
    items.sort((x, y) => (x.timestamp < y.timestamp ? 1 : x.timestamp > y.timestamp ? -1 : 0));
    return { runs: items, failures };
  },
  read_run: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const taskId = requireString(args, 'taskId');
    const timestamp = requireString(args, 'timestamp');
    return readRunDetail(runSourceRoot(real, args.source), taskId, timestamp);
  },
  read_run_events: async ({ args, allow }) => {
    // Read-only: allowed in server mode like read_run.
    const real = await allow(requireString(args, 'repoPath'));
    const taskId = requireString(args, 'taskId');
    if (!isSafeTaskId(taskId)) throw new BadRequestError('taskId must name a single direct child of the runs root');
    const timestamp = optionalString(args, 'timestamp');
    const after = optionalNumber(args, 'after');
    const limit = optionalNumber(args, 'limit');
    return readRunEvents(real, taskId, {
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  },
  list_remote_runs: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    await assertHasRemote(real);
    return remote.listRemoteRuns(real);
  },
  import_remote_run: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const runId = optionalNumber(args, 'runId');
    if (runId === undefined) throw new BadRequestError('runId is required and must be a number');
    return remote.fetchRemoteRun(real, runId);
  },
  list_active: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return listActive(real);
  },
  read_session: async ({ ctx, args, repos }) => {
    const sessionFile = requireString(args, 'sessionFile');
    const real = await ctx.allowlist.assertSessionPath(sessionFile);
    (await repos()).assert(real);
    return readSession(real);
  },
  conflict_stats: async ({ args, allow }) => readConflictStats(await allow(requireString(args, 'repoPath'))),
}, {
  list_runs: { write: false, repo: 'repoPath' },
  list_runs_all: { write: false },
  read_run: { write: false, repo: 'repoPath' },
  read_run_events: { write: false, repo: 'repoPath' },
  list_remote_runs: { write: false, repo: 'repoPath' },
  import_remote_run: { write: true, repo: 'repoPath', unaudited: 'copies a CI run record into the repository\'s local run store' },
  list_active: { write: false, repo: 'repoPath' },
  read_session: { write: false, gatedBy: 'the handler resolves sessionFile through the allowlist and the caller\'s teams' },
  conflict_stats: { write: false, repo: 'repoPath' },
});
