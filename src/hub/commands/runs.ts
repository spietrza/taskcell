// Hub commands: run history: persisted run records, events, CI imports, live sessions. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { defaultRunsRoot, remoteRunsRoot, listRunSummaries, readRunDetail } from '../runs.js';
import { readRunEvents } from '../run-events.js';
import { isSafeTaskId } from '../../core/state-path.js';
import { listActive, readSession } from '../active.js';
import * as projects from '../projects.js';
import * as teams from '../teams.js';
import * as remote from '../remote.js';
import type { ActiveRun, RemoteImport, RemoteRun, RepoReadFailure, RepoStamp, RunDetail, RunSource, RunSummary, SessionRead } from '../../wire.js';
import { defineCommands, requireString, optionalString, optionalNumber } from '../command-kit.js';

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

export const commands = defineCommands<RunsCommands>({
  list_runs: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return listRunSummaries(defaultRunsRoot(real));
  },
  list_runs_all: async ({ ctx, allow, scope }) => {
    const { items, failures } = await projects.listAcrossProjects(
      ctx.configDir,
      allow,
      (real) => listRunSummaries(defaultRunsRoot(real)),
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
  read_session: async ({ ctx, args, roots }) => {
    const sessionFile = requireString(args, 'sessionFile');
    const real = await ctx.allowlist.assertSessionPath(sessionFile);
    teams.assertRepoInRoots(await roots(), real);
    return readSession(real);
  },
});
