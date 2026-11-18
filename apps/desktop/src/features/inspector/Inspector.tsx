import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, PAGE_CLASS, cn } from '@/ui';
import { FilePlus, RefreshCw } from 'lucide-react';
import { canUseFleet, isDemoMode, subscribe, onStreamReset } from '../../transport';
import { DEMO_READ_ONLY_MESSAGE } from '../../errors';
import {
  listRuns,
  listRunsAll,
  listActive,
  listTasks,
  listTasksAll,
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
import { RunList, activeKey, runKey } from './RunList';
import { projectColor } from '../../color';
import { RunPane } from './RunPane';
import { cardIdOf, issueNumber, repoInitials, titleKey } from '../../runLabels';
import { setUrlParam, urlParam } from '../../screenUrl';
import { CostBreakdown } from './CostBreakdown';
import { ConflictStats } from './ConflictStats';
import { RunDetail } from './RunDetail';
import { LiveRun } from './LiveRun';
import { RemoteRuns } from './RemoteRuns';
import { Fleet } from '../fleet/Fleet';
import { SettingsScreen } from '../settings/SettingsScreen';
import type { SettingsSection } from '../settings/sections';
import { TaskBoard } from '../board/TaskBoard';
import { TaskDetail } from '../board/TaskDetail';
import { TaskDraftScreen } from '../task/TaskDraftScreen';
import { NewRunForm } from './NewRunForm';
import { foldLiveEvent, reduceTypedRun, initialTypedRun, type TypedRunState, type RunEvent, type AppRunEvent } from './typedRunReducer';
import { useAppConfig } from '../../hooks';
import { inRepos } from '../../repoFilter';
import { configuredSources, type HubFilter } from '../../filterState';
import { RepoFailures } from '../../RepoViews';
import type { RepoReadFailure, RepoStamp } from '../../wire';
import type { TeamScreen } from '../settings/Members';
import type { Project } from '../../taskcell-output';
import { publishRuns, type PaletteCard, type PaletteRun } from '../../paletteIndex';
import { CardAnswer } from '../needs-you/CardAnswer';
import type { RunSummary, RunDetail as RunDetailT, ActiveRun, RunRef, RunSource } from '../../taskcell-output';

export function Inspector({
  project,
  projects,
  teamScreen,
  teamId,
  allRepos,
  filter,
  onFilter,
  screen,
  settingsSection,
  onSettingsSection,
  focusRunning,
  focusRun,
  openCard,
  clearNonce,
  newTaskNonce,
  onCrumb,
  onTaskCrumb,
  onNewTask,
  onOpenBoard,
  onOpenRuns,
  onOpenRunning,
  onOpenSettings,
  onOpenSetup,
}: {
  project: string;
  /** Every hub repository: "All repositories" watches and lists running runs for each. */
  projects: Project[];
  /** The selected team (hub), for the members screen under Settings. */
  teamScreen?: TeamScreen;
  /** The selected team (hub): the all-repositories lists are read for it. */
  teamId?: string;
  /** Board and Runs list every repository of the team (hub); the filter narrows them. */
  allRepos: boolean;
  /** The filter Board and Runs share, and its setter (persisted by the app). */
  filter: HubFilter;
  onFilter: (f: HubFilter) => void;
  screen: 'runs' | 'board' | 'task' | 'settings';
  /** Settings only: the open section, owned by the app (the address names it). */
  settingsSection: SettingsSection;
  onSettingsSection: (s: SettingsSection) => void;
  focusRunning: ActiveRun | null;
  /** A finished run to open on Runs (⌘K); a fresh object per request. */
  focusRun?: PaletteRun | null;
  /** A card to open on the Board (⌘K); a fresh object per request. */
  openCard?: PaletteCard | null;
  clearNonce: number;
  newTaskNonce: number;
  onCrumb: (c: string | null) => void;
  /** Task screen only: publishes the open conversation's name + rename hook for the breadcrumb. */
  onTaskCrumb: (c: { name: string; onRename: (v: string) => void } | null) => void;
  onNewTask: () => void;
  onOpenBoard: () => void;
  /** Switches to Runs, where a run launched from the Board opens in the split pane. */
  onOpenRuns?: () => void;
  /** Opens one live run on Runs (as Home's Moving rows do): the Board card's Open the run. */
  onOpenRunning?: (run: ActiveRun & Partial<RepoStamp>) => void;
  /** Opens this project's Settings (the Board's "no task source yet" hint). */
  onOpenSettings?: () => void;
  /** Reopen the first-run guide (Settings). */
  onOpenSetup?: () => void;
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
  // The first load has answered (a `?run=` link waits for it, not for a list that may stay empty).
  const [loaded, setLoaded] = useState(false);
  const [watching, setWatching] = useState(false);
  const [tick, setTick] = useState(0);
  const [showNewRun, setShowNewRun] = useState(false);
  const [newRunTask, setNewRunTask] = useState<string | undefined>(); // the card New Run was opened from
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);
  const [taskDetailSkills, setTaskDetailSkills] = useState<string[] | undefined>(); // the opened card's `Skills:` line
  // Typed run (S1): capabilities for the form, the single in-flight typed run, and the idle-check.
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [typedRun, setTypedRun] = useState<TypedRunState | null>(null);
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

  // Task titles from the board, for the Runs rows (a run record has none). Best effort: a failed read leaves the task ids.
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [labels, setLabels] = useState<Map<string, string[]>>(new Map());
  const [taskUrls, setTaskUrls] = useState<Map<string, string>>(new Map());
  // Wide screens open a run by themselves, once per visit: the running one, else the newest finished one.
  const autoPicked = useRef(false);

  // Rail navigation drops any open drill-down.
  useEffect(() => {
    autoPicked.current = false;
    setDetail(null);
    setLiveRun(null);
    setTaskDetailId(null);
    // The New Run form belongs to the screen it was opened on; its error goes with it.
    if (showNewRun) closeNewRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Opening a run from its row removes the row that had focus: hand it to the detail instead of the page body.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detail && document.activeElement === document.body) detailRef.current?.focus();
  }, [detail]);

  // The rail "Running" click opens that live run.
  useEffect(() => {
    if (!focusRunning) return;
    // This run, not the one Runs would open by itself (it reads state from the same render, so it would win).
    autoPicked.current = true;
    setDetail(null);
    setTaskDetailId(null);
    setLiveRun(focusRunning);
  }, [focusRunning]);

  // ⌘K's run: opened here, not the one Runs would pick by itself.
  useEffect(() => {
    if (!focusRun) return;
    autoPicked.current = true;
    setTaskDetailId(null);
    // Also as the screen's linked run: a list load that follows a screen switch clears the detail and would pick the newest.
    linkedRun.current = `${focusRun.taskId}@${focusRun.timestamp}`;
    void open(focusRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun]);

  // ⌘K searches the runs this list last loaded.
  useEffect(() => publishRuns(runs), [runs]);

  // Report the current drill-down up to the top-bar breadcrumb.
  useEffect(() => {
    // The card id the Board shows (gh-904, hub-4), not the internal task id gh-owner-repo-904.
    const id = detail ? detail.taskId : liveRun ? liveRun.taskId : (taskDetailId ?? null);
    onCrumb(id !== null ? cardIdOf(id) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, liveRun, taskDetailId]);

  // `?screen=runs&run=<taskId>@<timestamp>` opens that run once Runs has it; from then on the address follows the open run.
  const linkedRun = useRef<string | null>(screen === 'runs' ? urlParam('run') : null);
  useEffect(() => {
    if (screen !== 'runs' || linkedRun.current !== null) return;
    setUrlParam('run', detail ? `${detail.taskId}@${detail.timestamp}` : liveRun ? liveRun.taskId : null);
  }, [screen, detail, liveRun]);

  // A breadcrumb crumb click, or a rail click on the screen already open, clears the open drill-down and folds
  // a run's strip to its toolbar chip: "Runs" then shows the list. Only on a click made while this screen is
  // mounted: a reload, a project switch or a fresh launch still opens the strip.
  const seenClear = useRef(clearNonce);
  useEffect(() => {
    if (clearNonce === seenClear.current) return;
    seenClear.current = clearNonce;
    autoPicked.current = true;
    setDetail(null);
    setLiveRun(null);
    setTaskDetailId(null);
  }, [clearNonce]);

  // `projects` is the selected team's repositories; the hub's all-repositories lists span every team.
  const repos = projects.map((p) => p.path);
  // Card sources the Source filter can offer: those of the projects in view (the Projects filter, else all, else the open one).
  const configured = configuredSources(projects, allRepos ? (filter.repos.length > 0 ? filter.repos : repos) : [project]);

  const loadRuns = async (): Promise<void> => {
    const gen = ++runsGen.current;
    if (allRepos) {
      const [r, a] = await Promise.all([
        listRunsAll(teamId).then((l) => ({ runs: inRepos(l.runs, repos), failures: inRepos(l.failures, repos) })),
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
    // Stamped with the project so ⌘K can place each run in the team.
    setRuns(r.map((x) => ({ ...x, repoPath: project })));
    setFailures([]);
    setActive(a);
  };

  const load = async (): Promise<void> => {
    setError(null);
    autoPicked.current = false;
    setDetail(null);
    setLiveRun(null);
    setLoading(true);
    try {
      await loadRuns();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setLoaded(true);
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
  // Another team's rows do not stay on screen while the new team's list is read.
  const loadedTeam = useRef(teamId);
  // Load on mount and when the filter mode changes — not when only the repository list changes,
  // so an open run is not closed by a repository being added or removed.
  useEffect(() => {
    if (loadedTeam.current !== teamId) {
      loadedTeam.current = teamId;
      setRuns([]);
      setActive([]);
      setFailures([]);
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, allRepos, teamId]);

  // Why a `?run=` link did not open what it named (the run ended, or is gone); cleared by leaving Runs.
  const [linkNote, setLinkNote] = useState<string | null>(null);
  useEffect(() => {
    if (screen !== 'runs') setLinkNote(null);
  }, [screen]);
  const taskCount = runs.length + active.length;
  useEffect(() => {
    if (screen !== 'runs') return;
    let alive = true;
    const read = allRepos
      ? listTasksAll(teamId).then((r) => r.tasks)
      : listTasks(project).then((r) => r.tasks.map((t) => ({ ...t, repoPath: project })));
    read
      .then((tasks) => {
        if (!alive) return;
        setTitles(new Map(tasks.map((t) => [titleKey(t.repoPath, t.id), t.title])));
        setLabels(new Map(tasks.flatMap((t) => (t.labels ? [[titleKey(t.repoPath, t.id), t.labels] as const] : []))));
        setTaskUrls(new Map(tasks.flatMap((t) => (t.url !== undefined ? [[titleKey(t.repoPath, t.id), t.url] as const] : []))));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [screen, project, allRepos, teamId, taskCount]);

  useEffect(() => {
    if (screen === 'runs' && linkedRun.current !== null) {
      const [taskId, timestamp] = linkedRun.current.split('@');
      // Wait for the first load; a live run that has ended since the link was made is not waited for (it never returns).
      if (loading || !loaded) return;
      linkedRun.current = null;
      const r = timestamp !== undefined ? runs.find((x) => x.source !== 'ci' && x.taskId === taskId && x.timestamp === timestamp) : undefined;
      const a = timestamp === undefined ? active.find((x) => x.taskId === taskId) : undefined;
      // The live run has ended: its newest finished run (runs come newest first) stands in for it.
      const ended = timestamp === undefined && a === undefined ? runs.find((x) => x.source !== 'ci' && x.taskId === taskId) : undefined;
      if (r || a || ended) {
        autoPicked.current = true;
        if (a) setLiveRun(a);
        else void open((r ?? ended)!);
        if (ended) setLinkNote(`The live run of ${cardIdOf(taskId)} has ended; showing its finished run.`);
        return;
      }
      setLinkNote(`${cardIdOf(taskId)}: the linked run is not in this list (it may have ended or been removed).`);
    }
    if (screen !== 'runs' || loading || autoPicked.current || detail || liveRun || typedRun !== null) return;
    // Narrow screens show the list first: a run opens only when the user picks it.
    if (window.matchMedia?.('(max-width: 767px)').matches) return;
    const a = active[0];
    const r = runs.find((x) => x.source !== 'ci');
    if (!a && !r) return;
    autoPicked.current = true;
    if (a) setLiveRun(a);
    else if (r) void open(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, loading, runs, active]);

  // The run launched here is live from its run-start, but `list_active` sees it only once its first session
  // file lands (after Code): until then it is listed from the launch itself, so the Runs list is never empty.
  const launchingTask = typedRun !== null && typedRun.terminal === undefined ? typedRun.taskId : undefined;
  const shownActive = useMemo(
    () =>
      launchingTask === undefined || active.some((a) => a.taskId === launchingTask && (a.repoPath ?? project) === project)
        ? active
        : [{ taskId: launchingTask, sessionFile: '', lastActivityMs: Date.now(), repoPath: project, repoName: projects.find((p) => p.path === project)?.name }, ...active],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, launchingTask, project],
  );

  // A run launched from the board opens in the split pane as soon as the run list shows it (once per
  // launch, so a later pick of another run is not overridden).
  const adoptedGen = useRef(-1);
  useEffect(() => {
    if (screen !== 'runs' || typedRun?.taskId === undefined || adoptedGen.current === runGen.current) return;
    const a = shownActive.find((x) => x.taskId === typedRun.taskId);
    if (!a) return;
    adoptedGen.current = runGen.current;
    setDetail(null);
    setLiveRun(a);
  }, [screen, typedRun?.taskId, shownActive]);

  // A live run that ends opens its finished record in the pane: the live view never fills in Tests or the PR.
  // Records of the task that existed when the live run was opened are older runs, never this one.
  const priorRecords = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!liveRun) {
      priorRecords.current = null;
      return;
    }
    const repo = liveRun.repoPath ?? project;
    const mine = runs.filter((r) => r.taskId === liveRun.taskId && (r.repoPath ?? project) === repo && r.source !== 'ci');
    if (priorRecords.current === null) {
      priorRecords.current = new Set(mine.map((r) => r.timestamp));
      return;
    }
    if (shownActive.some((a) => a.taskId === liveRun.taskId && (a.repoPath ?? project) === repo)) return;
    const done = mine.find((r) => !priorRecords.current!.has(r.timestamp));
    if (done) void open(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRun, runs, shownActive]);

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
      watchedRef.current.forEach((p) => void unwatchProject(p).catch(() => {}));
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
    [...prev].filter((p) => !next.has(p)).forEach((p) => void unwatchProject(p).catch(() => {}));
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
          // instead; New-run stays enabled (the hub queues the run — better than disabling the
          // button for an unseen run).
          setForeignRun(active.repoPath);
        }
        // No active run of ours, but one may be waiting in the queue — re-attach that instead,
        // or a reload would leave it with no strip and no way to cancel it. The hub allows at most
        // one queued run per project (run-session.ts), so `find` cannot miss a second one.
        if (runId === undefined) runId = (await apiQueue()).find((q) => q.repoPath === project)?.runId;
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
        // queued (hub), so the worst case is confusion, not corruption.
      } finally {
        setCheckedIdle(true);
      }
    };
    void attach();
  }, []);

  const closeNewRun = (): void => {
    setShowNewRun(false);
    setError(null);
  };

  const startTypedRun = (params: CreateRunParams): void => {
    // Guard the launch itself, not just the toolbar button — the form has a second entry point
    // (board → TaskDetail → New Run) that isn't screen-gated, so a click there could clobber the
    // in-flight run's client state. The ref is synced for a run that's been live a moment.
    //
    // checkedIdle is part of the guard, not just the button's disabled state: during mount re-attach
    // a run can be live in the sidecar while typedRunRef is still null, and a board-path launch in
    // that window would set a fresh strip, get rejected by the hub, and wipe the strip
    // the re-attach effect is concurrently folding the backlog into.
    // The demo refuses every write; say so here, where its sample live run would otherwise answer first.
    if (isDemoMode()) {
      setError(DEMO_READ_ONLY_MESSAGE);
      return;
    }
    if (!checkedIdle) return;
    if (typedRunRef.current !== null && typedRunRef.current.terminal === undefined) {
      setError('A run is already live in this project. Wait for it to finish or stop it on the Runs screen, then run again.');
      return;
    }
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
    setDetail(null);
    setLiveRun(null);
    if (screen !== 'runs') onOpenRuns?.();
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
        // apiCreateRun rejects on BOTH a pre-start rejection (a full hub queue, before any run event) AND a run that started then errored/cancelled
        // (resolve_terminal returns Err for those). Only the former needs clearing + a banner — it never
        // adopted a runId. A real error/cancel already folded run-accepted, so its runId is set and the
        // terminal EVENT renders it in the strip; don't wipe it or double-report.
        //
        // Asymmetry with .then above, on purpose: this path does NOT synthesize a terminal backstop. A
        // lost run-error/run-cancelled would spin the strip forever, and we lean on the S0.5 guarantee
        // that the hub buffers a terminal on every in-session path rather than guessing one here.
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
      const d = await readRun(repo, ref);
      setLiveRun(null);
      setDetail(d);
      setDetailRepo(repo);
      openRef.current = { ref, repo };
    } catch (e) {
      setError(String(e));
    }
  };

  // Narrow screens: the pane's back button. The list stays on screen after it, so nothing is picked for the user again.
  const closeRun = (): void => {
    autoPicked.current = true;
    setDetail(null);
    setLiveRun(null);
  };
  const openActive = (a: ActiveRun & Partial<RepoStamp>): void => {
    setDetail(null);
    setLiveRun(a);
  };
  const repoNameOf = (path: string): string | undefined => projects.find((p) => p.path === path)?.name;
  const titleOf = (repo: string, taskId: string): string | undefined => titles.get(titleKey(repo, taskId));
  const selectedKey = detail ? runKey(detailRepo, detail.taskId, detail.timestamp) : liveRun ? activeKey(liveRun.repoPath ?? project, liveRun.taskId) : undefined;
  const cancelRun = (runId: string): void => (isDemoMode() ? setError(DEMO_READ_ONLY_MESSAGE) : void apiCancel(runId));

  return (
    // Fixed-height frame: chrome (toolbar / banners) is shrink-0; the content region below owns scroll.
    // Centered + width-capped, except the board which needs full width for horizontal column scroll.
    <div
      className={cn(
        'flex h-full min-h-0 flex-col gap-4',
        PAGE_CLASS,
        // The board's columns scroll sideways, so it (and the task screen) drop the width cap only.
        (screen === 'board' || screen === 'task' || screen === 'runs') && 'max-w-none',
        // One width for every Settings section, so switching tabs does not jump; wide enough for the Runners table.
        screen === 'settings' && 'max-w-6xl',
      )}
    >
      {screen === 'runs' && (
      <div className={cn('flex shrink-0 flex-wrap items-center gap-3', (detail !== null || liveRun !== null) && 'max-md:hidden')}>
        {watching && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Watching .taskcell for changes">
            <span className="size-2 animate-pulse rounded-full bg-success" />
            live
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          {/* S10 (D3): the toolbar path to the provider form is gone — runs start from the board
              (TaskDetail keeps the only setShowNewRun entry). Authoring starts here instead. */}
          {/* Filled, as on the Board: New card is the one way to start work on both screens. */}
          <Button onClick={onNewTask} startIcon={<FilePlus className="size-4" />}>
            New card
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
          <NewRunForm key={newRunTask ?? ''} capabilities={caps} project={project} taskId={newRunTask} taskSkills={newRunTask !== undefined ? taskDetailSkills : undefined} onRun={startTypedRun} onCancel={closeNewRun} />
        </div>
      )}

      {foreignRun !== null && typedRun === null && screen === 'runs' && (
        <div className="mb-2 rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          a run is live in <code className="font-mono">{foreignRun}</code> —{' '}
          a run started here will be queued until it finishes
        </div>
      )}
      {detail && screen !== 'runs' ? (
        // A CI run imported from Settings opens as the plain detail; on Runs the record is the split view's right pane.
        <div ref={detailRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col gap-3 outline-none">
          <CardAnswer project={detailRepo} taskId={detail.taskId} showQuestion />
          <RunDetail detail={detail} project={detailRepo} />
        </div>
      ) : liveRun && screen !== 'runs' ? (
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
              setNewRunTask(taskDetailId);
              setTaskDetailId(null);
              setShowNewRun(true);
            }}
          />
        </div>
      ) : screen === 'runs' ? (
        // In-flight runs render as running rows at the top of the RunList table.
        <div className="flex min-h-0 flex-1 flex-col">
          <RepoFailures failures={failures} total={projects.length} />
          {linkNote !== null && (
            <p role="status" className="mb-2 flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <span className="min-w-0 flex-1">{linkNote}</span>
              <Button variant="text" onClick={() => setLinkNote(null)}>Dismiss</Button>
            </p>
          )}
          {!allRepos && <CostBreakdown project={project} />}
          {!allRepos && <ConflictStats repoPath={project} refreshKey={tick} />}
          <RunList
            runs={runs}
            active={shownActive}
            starting={typedRun !== null && typedRun.terminal === undefined}
            showRepo={allRepos}
            hub={filter}
            onHub={onFilter}
            configured={configured}
            projects={allRepos ? projects : []}
            onSelect={open}
            onOpenActive={openActive}
            onNewTask={onNewTask}
            selected={selectedKey}
            titles={titles}
            labels={labels}
            paneOpen={detail !== null || liveRun !== null}
            identity={(path) => {
              const p = projects.find((x) => x.path === (path ?? project));
              return p && { name: p.name, color: projectColor(p), initials: repoInitials(p.name, projects.map((x) => x.name)) };
            }}
            pane={
              detail ? (
                <RunPane key={selectedKey} repo={detailRepo} repoName={repoNameOf(detailRepo)} initials={repoInitials(repoNameOf(detailRepo), projects.map((p) => p.name))} taskId={detail.taskId} title={titleOf(detailRepo, detail.taskId)} issue={issueNumber(detail.taskId)} issueHref={taskUrls.get(titleKey(detailRepo, detail.taskId))} summary={runs.find((r) => r.taskId === detail.taskId && r.timestamp === detail.timestamp && (r.repoPath === undefined || r.repoPath === detailRepo))} detail={detail} tick={tick} onBack={closeRun} onCancel={cancelRun} />
              ) : liveRun ? (
                <RunPane key={selectedKey} repo={liveRun.repoPath ?? project} repoName={liveRun.repoName ?? repoNameOf(liveRun.repoPath ?? project)} initials={repoInitials(liveRun.repoName ?? repoNameOf(liveRun.repoPath ?? project), projects.map((p) => p.name))} taskId={liveRun.taskId} title={titleOf(liveRun.repoPath ?? project, liveRun.taskId)} issue={issueNumber(liveRun.taskId)} issueHref={taskUrls.get(titleKey(liveRun.repoPath ?? project, liveRun.taskId))} active={shownActive.find((a) => a.taskId === liveRun.taskId && (a.repoPath ?? project) === (liveRun.repoPath ?? project)) ?? liveRun} tick={tick} onBack={closeRun} onCancel={cancelRun} />
              ) : (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">Select a run to see its stages and log.</div>
              )
            }
          />
        </div>
      ) : screen === 'board' ? (
        <TaskBoard
          project={project}
          allRepos={allRepos}
          repos={repos}
          teamId={teamId}
          filter={filter}
          onFilter={onFilter}
          projects={projects}
          configured={configured}
          onOpenTask={(id, repo, skills) => {
            setTaskDetailRepo(repo ?? project);
            setTaskDetailSkills(skills);
            setTaskDetailId(id);
          }}
          onNewTask={onNewTask}
          {...(openCard ? { openCard } : {})}
          {...(onOpenSettings ? { onOpenSettings } : {})}
          onStartRun={(id, skills) => {
            setNewRunTask(id);
            setTaskDetailSkills(skills);
            setShowNewRun(true);
          }}
          // The card's own live run when the hub lists one (a claimed card may have none yet): else the Runs list.
          onOpenRun={(id, repo) => {
            const path = repo ?? project;
            void listActive(path)
              .then((rows) => rows.find((a) => a.taskId === id), () => undefined)
              .then((a) => (a && onOpenRunning ? onOpenRunning({ ...a, repoPath: path, repoName: projects.find((p) => p.path === path)?.name ?? path }) : onOpenRuns?.()));
          }}
          {...(onOpenSettings ? { onOpenSkills: () => { onSettingsSection('skills'); onOpenSettings(); } } : {})}
        />
      ) : screen === 'settings' ? (
        <SettingsScreen
          project={project}
          {...(teamScreen ? { teamScreen } : {})}
          {...(onOpenSetup ? { onOpenSetup } : {})}
          section={settingsSection}
          onSection={onSettingsSection}
          fleet={canUseFleet() ? <Fleet project={project} active={active} /> : null}
          remote={<RemoteRuns project={project} onOpenRun={open} />}
        />
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
