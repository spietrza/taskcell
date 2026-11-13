import { useEffect, useRef, useState } from 'react';
import { Button, Chip, cn } from '@/ui';
import { ArrowLeft, FilePlus, RefreshCw } from 'lucide-react';
import { canUseFleet, isHubMode, subscribe, onStreamReset } from '../../transport';
import {
  listRuns,
  listRunsAll,
  listActive,
  readRun,
  watchProject,
  unwatchProject,
  apiCapabilitiesCached,
  apiCreateRun,
  apiActiveRun,
  apiRunBacklog,
  apiQueue,
  apiCancel,
  apiRepoOk,
  type Capabilities,
  type CreateRunParams,
} from '../../ipc';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import { LiveRun } from './LiveRun';
import { RemoteRuns } from './RemoteRuns';
import { AuditLog } from '../audit/AuditLog';
import { Fleet } from '../fleet/Fleet';
import { Settings } from '../settings/Settings';
import { TaskBoard } from '../board/TaskBoard';
import { TaskDetail } from '../board/TaskDetail';
import { WorkflowEditor } from '../workflow/WorkflowEditor';
import { TaskDraftScreen } from '../task/TaskDraftScreen';
import { NeedsYou } from '../needs-you/NeedsYou';
import { NewRunForm } from './NewRunForm';
import { RunStrip } from './RunStrip';
import { foldLiveEvent, reduceTypedRun, initialTypedRun, type TypedRunState, type RunEvent, type AppRunEvent } from './typedRunReducer';
import { useAppConfig } from '../../hooks';
import { RepoFailures } from '../../RepoViews';
import type { RepoReadFailure, RepoStamp } from '../../wire';
import type { Project } from '../../taskcell-output';
import type { RunSummary, RunDetail as RunDetailT, ActiveRun, RunRef, RunSource } from '../../taskcell-output';

export function Inspector({
  project,
  projects,
  allRepos,
  screen,
  focusRunning,
  clearNonce,
  newTaskNonce,
  onCrumb,
  onTaskCrumb,
  onNewTask,
  onOpenBoard,
}: {
  project: string;
  /** Every hub repository: "All repositories" watches and lists running runs for each. */
  projects: Project[];
  /** The shared repository filter is "All repositories": Board, Runs and Needs you list every repository. */
  allRepos: boolean;
  screen: 'runs' | 'board' | 'task' | 'fleet' | 'remote' | 'workflow' | 'settings' | 'needs' | 'audit';
  focusRunning: ActiveRun | null;
  clearNonce: number;
  newTaskNonce: number;
  onCrumb: (c: string | null) => void;
  /** Task screen only: publishes the open conversation's name + rename hook for the breadcrumb. */
  onTaskCrumb: (c: { name: string; onRename: (v: string) => void } | null) => void;
  onNewTask: () => void;
  onOpenBoard: () => void;
}) {
  const [runs, setRuns] = useState<(RunSummary & Partial<RepoStamp>)[]>([]);
  const [failures, setFailures] = useState<RepoReadFailure[]>([]);
  // Under "All repositories" an opened run / task belongs to ITS repository, not the active project.
  const [detailRepo, setDetailRepo] = useState(project);
  const [taskDetailRepo, setTaskDetailRepo] = useState(project);
  const [active, setActive] = useState<(ActiveRun & Partial<RepoStamp>)[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [liveRun, setLiveRun] = useState<(ActiveRun & Partial<RepoStamp>) | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A live run under "All repositories" is held to its own repository's budget.
  const [cfg] = useAppConfig(liveRun?.repoPath ?? project);
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(false);
  const [tick, setTick] = useState(0);
  const [showNewRun, setShowNewRun] = useState(false);
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);
  // Typed run (S1): capabilities for the form, the single in-flight typed run, and the idle-check.
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [typedRun, setTypedRun] = useState<TypedRunState | null>(null);
  // Live-run strip minimized to reveal the runs list. Distinct from dismissal: events keep folding,
  // so restoring the strip (or the run finishing) loses nothing. Dismissal is terminal-only.
  const [stripMinimized, setStripMinimized] = useState(false);
  const [checkedIdle, setCheckedIdle] = useState(false); // false until apiActiveRun() resolves on mount
  const [foreignRun, setForeignRun] = useState<string | null>(null); // repoPath of another project's live run (S8)
  const typedRunRef = useRef<TypedRunState | null>(null); // latest typedRun, readable in async callbacks
  const dismissedRunId = useRef<string | null>(null); // a run the user closed — ignore its late events
  const runGen = useRef(0); // bumped per launch; a settled apiCreateRun from an older run is dropped
  const [repoOk, setRepoOk] = useState(true); // cached: is `project` a git work tree? (fails a run at click)

  // The open detail's ref, so `refresh` can re-read it: which run, and which tree it came from —
  // the project's own runs, or a CI run imported by the Remote screen. Only the discriminant
  // travels — whichever backend answers `read_run` resolves it to a root. Written by `open`.
  const openRef = useRef<{ ref: RunRef; repo: string } | null>(null);
  // Latest loadRuns wins: a slow listRunsAll must not overwrite a newer per-repository load.
  const runsGen = useRef(0);
  useEffect(() => {
    if (!detail) openRef.current = null;
  }, [detail]);

  // Rail navigation drops any open drill-down.
  useEffect(() => {
    setDetail(null);
    setLiveRun(null);
    setTaskDetailId(null);
  }, [screen]);

  // The rail "Running" click opens that live run.
  useEffect(() => {
    if (focusRunning) setLiveRun(focusRunning);
  }, [focusRunning]);

  // Report the current drill-down up to the top-bar breadcrumb.
  useEffect(() => {
    onCrumb(detail ? detail.taskId : liveRun ? liveRun.taskId : (taskDetailId ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, liveRun, taskDetailId]);

  // A breadcrumb crumb click clears the open drill-down.
  useEffect(() => {
    if (clearNonce > 0) {
      setDetail(null);
      setLiveRun(null);
      setTaskDetailId(null);
    }
  }, [clearNonce]);

  const loadRuns = async (): Promise<void> => {
    const gen = ++runsGen.current;
    if (allRepos) {
      const [r, a] = await Promise.all([
        listRunsAll(),
        Promise.all(
          projects.map((p) =>
            listActive(p.path).then(
              (rows) => ({ rows: rows.map((x) => ({ ...x, repoPath: p.path, repoName: p.name })) }),
              // One repository's running rows failing leaves the others listed; it is named in `failures`.
              (e: unknown) => ({ rows: [], failure: { repoPath: p.path, repoName: p.name, error: String(e) } }),
            ),
          ),
        ),
      ]);
      if (gen !== runsGen.current) return;
      const activeFailures = a.flatMap((x) =>
        'failure' in x && !r.failures.some((f) => f.repoPath === x.failure.repoPath) ? [x.failure] : [],
      );
      setRuns(r.runs);
      setFailures([...r.failures, ...activeFailures]);
      setActive(a.flatMap((x) => x.rows));
      return;
    }
    const [r, a] = await Promise.all([listRuns(project), listActive(project)]);
    if (gen !== runsGen.current) return;
    setRuns(r);
    setFailures([]);
    setActive(a);
  };

  const load = async (): Promise<void> => {
    setError(null);
    setDetail(null);
    setLiveRun(null);
    setLoading(true);
    try {
      await loadRuns();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      await loadRuns();
      setTick((t) => t + 1);
      const o = openRef.current;
      if (o) setDetail(await readRun(o.repo, o.ref));
    } catch {
      // transient mid-write; next event resyncs
    }
  };
  // Load on mount and when the filter mode changes — not when only the repository list changes,
  // so an open run is not closed by a repository being added or removed.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, allRepos]);

  // The listener is registered once, so it reaches the latest render's `refresh` through a ref.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // The paths being watched; "All repositories" watches every repository, so any of them live-updates the list.
  const watchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const unlisten = subscribe<string>('vanguard:changed', (e) => {
      if (watchedRef.current.has(e.payload)) void refreshRef.current();
    });
    // A stream-reset means the SSE gap may have swallowed a vanguard:changed we'd otherwise have
    // reacted to, so resync unconditionally rather than trusting the stream to have told us (#491).
    const unlistenReset = onStreamReset(() => void refreshRef.current());
    return () => {
      setWatching(false);
      watchedRef.current.forEach((p) => void unwatchProject(p));
      watchedRef.current = new Set();
      void unlisten.then((f) => f());
      void unlistenReset.then((f) => f());
    };
  }, []);

  // Diff the watched set: watch only the added paths, unwatch only the removed ones.
  const watchKey = allRepos ? projects.map((p) => p.path).join('\n') : project;
  const watchedMode = useRef<boolean | null>(null);
  useEffect(() => {
    const next = new Set(watchKey.split('\n').filter((p) => p !== ''));
    const prev = watchedRef.current;
    const added = [...next].filter((p) => !prev.has(p));
    [...prev].filter((p) => !next.has(p)).forEach((p) => void unwatchProject(p));
    watchedRef.current = next;
    void Promise.all(added.map((p) => watchProject(p)))
      .then(() => setWatching(true))
      .catch(() => setWatching(false));
    // Only the repository list changed: re-read the runs without closing what is open (a mode change is `load`'s).
    if (watchedMode.current === allRepos) void refreshRef.current();
    watchedMode.current = allRepos;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchKey]);

  // Load the capability surface once (cached; pure — never blocks on a live run).
  useEffect(() => {
    void apiCapabilitiesCached().then(setCaps).catch(() => setCaps(null));
  }, []);

  // Cached repo pre-flight per project (Inspector is key={project}, so this runs once per project).
  useEffect(() => {
    void apiRepoOk(project).then(setRepoOk).catch(() => setRepoOk(true)); // couldn't verify → don't block
  }, [project]);

  // Mirror typedRun into a ref so async callbacks (the apiCreateRun catch) can read the latest value.
  useEffect(() => {
    typedRunRef.current = typedRun;
  }, [typedRun]);

  // Subscribe to the typed-run event stream and fold into `typedRun` (reducer drops foreign runIds).
  // Ignore events for a run the user has dismissed, so a late event can't resurrect a closed strip.
  useEffect(() => {
    const un = subscribe<{ runId: string; event: RunEvent }>('api:event', (e) => {
      if (e.payload.runId === dismissedRunId.current) return;
      // repoPath scopes adoption: a foreign project's run can never seed a strip here (S8).
      const type = e.payload.event.type;
      if (type === 'run-end' || type === 'run-error' || type === 'run-cancelled') {
        // ANY observed terminal means the foreign run is over — the note would otherwise outlive the
        // run it warns about (review #343 r2). (A LOCAL run's note-hiding needs no clear here: the
        // note renders only while typedRun === null, and a local run materializes the strip.)
        setForeignRun(null);
      }
      // ...and a newly accepted run in another project (e.g. promoted from the hub queue) re-arms it.
      const accepted = e.payload.event as AppRunEvent;
      if (accepted.type === 'run-accepted' && accepted.repoPath !== undefined && accepted.repoPath !== project) {
        setForeignRun(accepted.repoPath);
      }
      // foldLiveEvent keeps null null when the reducer declines — materializing an empty strip
      // for a foreign event would hide the note and render a blank panel (r3 blocking).
      setTypedRun((prev) => foldLiveEvent(prev, e.payload, project));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // On mount, learn whether a typed run is already in flight and re-attach its strip by replaying the
  // buffered backlog. Runs after the listen effect so the live tail isn't lost. Fold the backlog INTO
  // current state (not replace) so events that arrived on the channel during the await aren't dropped;
  // the reducer's last-wins keys + idempotence make the merge safe.
  useEffect(() => {
    const attach = async (): Promise<void> => {
      try {
        const active = await apiActiveRun();
        let runId = active !== null && active.repoPath === project ? active.runId : undefined;
        if (active !== null && runId === undefined) {
          // Another project's run holds the sidecar. Don't fold its backlog — surface a note
          // instead; New-run stays enabled (Tauri's single-in-flight guard rejects with a clear
          // error, the hub queues the run — either beats disabling the button for an unseen run).
          setForeignRun(active.repoPath);
        }
        // Hub: no active run of ours, but one may be waiting in the queue — re-attach that instead,
        // or a reload would leave it with no strip and no way to cancel it. The hub allows at most
        // one queued run per project (run-session.ts), so `find` cannot miss a second one.
        if (runId === undefined && isHubMode()) runId = (await apiQueue()).find((q) => q.repoPath === project)?.runId;
        if (runId === undefined) return;
        const backlog = (await apiRunBacklog(runId)) as { runId: string; event: RunEvent }[];
        // Fold BEFORE flipping checkedIdle: between the two the button's guard would see
        // checkedIdle && typedRun === null and enable New run while a run is genuinely live.
        setTypedRun((prev) =>
          backlog.reduce((s, p) => reduceTypedRun(s, p, project), prev ?? initialTypedRun()),
        );
      } catch {
        // Treat an unverifiable idle-check as idle: a rejected apiActiveRun (sidecar not up yet, IPC
        // error) must not leave the New-run button disabled forever. A second concurrent run is still
        // rejected (Tauri's busy guard) or queued (hub), so the worst case is confusion, not corruption.
      } finally {
        setCheckedIdle(true);
      }
    };
    void attach();
  }, []);

  const startTypedRun = (params: CreateRunParams): void => {
    // Guard the launch itself, not just the toolbar button — the form has a second entry point
    // (board → TaskDetail → New Run) that isn't screen-gated, so a click there could clobber the
    // in-flight run's client state. The ref is synced for a run that's been live a moment.
    //
    // checkedIdle is part of the guard, not just the button's disabled state: during mount re-attach
    // a run can be live in the sidecar while typedRunRef is still null, and a board-path launch in
    // that window would set a fresh strip, get rejected by the Rust busy guard, and wipe the strip
    // the re-attach effect is concurrently folding the backlog into.
    if (!checkedIdle) return;
    if (typedRunRef.current !== null && typedRunRef.current.terminal === undefined) return;
    if (!repoOk) {
      setError(`${project} is not a git work tree — cannot run here.`);
      return;
    }
    setShowNewRun(false);
    setError(null);
    // Dismiss the outgoing terminal run: the fresh state has no runId yet, so a late buffered event
    // from the previous run would otherwise be ADOPTED as this run's identity (`state.runId ?? payload.runId`)
    // and the new run's own run-accepted then dropped as foreign.
    dismissedRunId.current = typedRunRef.current?.runId ?? null;
    // Tie both continuations below to THIS launch. Without it they read current state: run A settling
    // after run B started would let A's catch wipe B's strip, or A's terminal land on B.
    const gen = ++runGen.current;
    const started = initialTypedRun();
    typedRunRef.current = started; // sync in-flight marker (the effect-synced ref lags a render)
    setTypedRun(started); // "starting…" — "run live" derives from this
    setStripMinimized(false); // a fresh launch always shows its strip
    setDetail(null);
    setLiveRun(null);
    void apiCreateRun(params)
      .then((res) => {
        if (runGen.current !== gen) return; // a newer run owns the strip
        // The event stream owns the terminal; this is a backstop only if the terminal event was lost —
        // write it ONLY when still non-terminal. Precedence matches the reducer (prUrl → secretBlocked).
        // NOTE: the spec (Part 3, G6) says the reducer alone owns terminal and the promise must never
        // write it. This is a deliberate deviation: the `terminal === undefined` guard neutralizes the
        // double-badge race the spec warned about, and without the backstop a lost run-end would spin
        // the strip forever.
        setTypedRun((prev) =>
          prev !== null && prev.terminal === undefined
            ? { ...prev, terminal: res.prUrl !== undefined ? { kind: 'success', prUrl: res.prUrl } : res.secretBlocked === true ? { kind: 'secret-blocked' } : { kind: 'no-changes' } }
            : prev,
        );
      })
      .catch((e) => {
        if (runGen.current !== gen) return; // a newer run owns the strip
        // apiCreateRun rejects on BOTH a pre-start rejection (Tauri's single-in-flight guard or a full
        // hub queue, both before any run event) AND a run that started then errored/cancelled
        // (resolve_terminal returns Err for those). Only the former needs clearing + a banner — it never
        // adopted a runId. A real error/cancel already folded run-accepted, so its runId is set and the
        // terminal EVENT renders it in the strip; don't wipe it or double-report.
        //
        // Asymmetry with .then above, on purpose: this path does NOT synthesize a terminal backstop. A
        // lost run-error/run-cancelled would spin the strip forever, and we lean on the S0.5 guarantee
        // that Rust buffers a terminal on every in-session path rather than guessing one here.
        if (typedRunRef.current?.runId === undefined) {
          setError(String(e));
          setTypedRun(null);
        }
      });
  };

  const open = async (r: RunSummary & Partial<RepoStamp>, source: RunSource = { kind: 'local' }): Promise<void> => {
    const repo = r.repoPath ?? project;
    setError(null);
    const ref: RunRef = { source, taskId: r.taskId, timestamp: r.timestamp };
    try {
      setDetail(await readRun(repo, ref));
      setDetailRepo(repo);
      openRef.current = { ref, repo };
    } catch (e) {
      setError(String(e));
    }
  };

  const detailPassed =
    detail && (detail.proof ? detail.proof.passed : !detail.stages.some((s) => !s.record.completed));

  return (
    // Fixed-height frame: chrome (toolbar / banners) is shrink-0; the content region below owns scroll.
    // Centered + width-capped, except the board which needs full width for horizontal column scroll.
    <div
      className={cn(
        'mx-auto flex h-full w-full min-h-0 flex-col gap-4 p-6 max-md:p-3',
        screen !== 'board' && screen !== 'task' && 'max-w-5xl',
      )}
    >
      {screen === 'runs' && (
      <div className="flex shrink-0 items-center gap-3">
        {watching && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Watching .taskcell for changes">
            <span className="size-2 animate-pulse rounded-full bg-success" />
            live
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {detail && <span className="tabular-nums text-xs text-muted-foreground">{detail.timestamp}</span>}
          {liveRun && <Chip color="success" variant="outlined">running</Chip>}
          {typedRun !== null && stripMinimized && (
            <button
              onClick={() => setStripMinimized(false)}
              aria-label={typedRun.terminal === undefined ? 'show live run' : 'show finished run'}
              className="cursor-pointer"
            >
              <Chip color="success" variant="outlined">
                {typedRun.terminal === undefined ? 'running — view' : 'run finished — view'}
              </Chip>
            </button>
          )}
          {detail && <Chip color={detailPassed ? 'success' : 'destructive'}>{detailPassed ? 'passed' : 'failed'}</Chip>}
          {/* S10 (D3): the toolbar path to the provider form is gone — runs start from the board
              (TaskDetail keeps the only setShowNewRun entry). Authoring starts here instead. */}
          <Button
            variant="outlined"
            color="secondary"
            onClick={onNewTask}
            startIcon={<FilePlus className="size-4" />}
          >
            New Task
          </Button>
          <Button variant="text" color="secondary" onClick={load} loading={loading} startIcon={<RefreshCw className="size-4" />}>
            Reload
          </Button>
        </div>
      </div>
      )}

      {error && (
        <div className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {showNewRun && caps !== null && (
        <div className="shrink-0">
          <NewRunForm capabilities={caps} project={project} onRun={startTypedRun} onCancel={() => setShowNewRun(false)} />
        </div>
      )}

      {foreignRun !== null && typedRun === null && screen === 'runs' && (
        <div className="mb-2 rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          a run is live in <code className="font-mono">{foreignRun}</code> —{' '}
          {isHubMode() ? 'a run started here will be queued until it finishes' : 'starting one here will be rejected until it finishes'}
        </div>
      )}
      {typedRun !== null && screen === 'runs' && !stripMinimized ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <button
            onClick={() => {
              if (typedRun.terminal !== undefined) {
                // Record the runId as dismissed so a late event can't resurrect the closed strip.
                if (typedRun.runId !== undefined) dismissedRunId.current = typedRun.runId;
                setTypedRun(null);
              } else {
                // Run still live: minimize, don't dismiss — events keep folding and the toolbar
                // chip restores the strip (dogfood: the live strip trapped the user fullscreen).
                setStripMinimized(true);
              }
            }}
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to runs
          </button>
          <RunStrip
            state={typedRun}
            // Always by id: with a hub queue, an id-less cancel hits whatever run is active NOW, which
            // may be the next one promoted after this run ended. Unset only while "starting…".
            onCancel={() => void apiCancel(typedRun.runId)}
          />
        </div>
      ) : detail ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <RunDetail detail={detail} project={detailRepo} />
        </div>
      ) : liveRun ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <LiveRun active={liveRun} refreshKey={tick} budgetUsd={cfg.budgetUsd} />
        </div>
      ) : taskDetailId ? (
        // taskDetailId only fires from the board (full-bleed frame) — re-cap width so this reading
        // view matches every other detail view instead of spanning edge-to-edge.
        <div className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto">
          <TaskDetail
            project={taskDetailRepo}
            taskId={taskDetailId}
            runs={runs.filter((r) => r.repoPath === undefined || r.repoPath === taskDetailRepo)}
            canRun={taskDetailRepo === project}
            onBack={() => setTaskDetailId(null)}
            onNewRun={() => {
              setTaskDetailId(null);
              setShowNewRun(true);
            }}
          />
        </div>
      ) : screen === 'runs' ? (
        // In-flight runs render as running rows at the top of the RunList table.
        <div className="flex min-h-0 flex-1 flex-col">
          <RepoFailures failures={failures} />
          <RunList runs={runs} active={active} showRepo={allRepos} onSelect={open} onOpenActive={setLiveRun} />
        </div>
      ) : screen === 'board' ? (
        <TaskBoard
          project={project}
          allRepos={allRepos}
          onOpenTask={(id, repo) => {
            setTaskDetailRepo(repo ?? project);
            setTaskDetailId(id);
          }}
          onNewTask={onNewTask}
        />
      ) : screen === 'needs' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NeedsYou project={project} allRepos={allRepos} />
        </div>
      ) : screen === 'audit' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <AuditLog />
        </div>
      ) : screen === 'remote' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <RemoteRuns project={project} onOpenRun={open} />
        </div>
      ) : screen === 'fleet' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {canUseFleet() ? (
            <Fleet project={project} active={active} />
          ) : (
            <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Fleet is not available in hub mode — it spawns shell commands, which is remote code execution
              on a reachable server.
            </div>
          )}
        </div>
      ) : screen === 'workflow' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkflowEditor project={project} />
        </div>
      ) : screen === 'settings' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Settings project={project} />
        </div>
      ) : screen === 'task' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <TaskDraftScreen
            project={project}
            freshNonce={newTaskNonce}
            onOpenBoard={onOpenBoard}
            onConversationCrumb={onTaskCrumb}
          />
        </div>
      ) : null}
    </div>
  );
}
