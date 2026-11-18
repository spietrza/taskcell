import { useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PAGE_CLASS, cn, type Theme } from '@/ui';
import { TopBar, type Crumb } from './TopBar';
import { MainNav, type Screen } from './MainNav';
import { ServerSwitcher } from './ServerSwitcher';
import { TeamSwitcher } from './TeamSwitcher';
import { CommandPalette } from './CommandPalette';
import { RepoPicker } from './RepoPicker';
import { TailwindDebugScreens } from './components/TailwindDebugScreens';
import { Dashboard } from './features/dashboard/Dashboard';
import { Home, HomeSkeleton } from './features/home/Home';
import { HUB_WIDE_SECTIONS, type SettingsSection } from './features/settings/sections';
import { Inspector } from './features/inspector/Inspector';
import { Onboarding } from './features/onboarding/Onboarding';
import { StarterTaskDialog } from './features/onboarding/StarterTaskDialog';
import { loadOnboarding, saveOnboarding, showOnFirstRun, type OnboardingStored } from './features/onboarding/steps';
import { factoryGateOf, useCallerCapabilities } from './hooks';
import { listProjects, addProject, cloneProject, removeProject, listNeedsYouAll, listTeams, teamAddRepository, factoryState, localWorkerState } from './ipc';
import { loadTeamId, resolveTeam, saveTeamId, teamProjects } from './teams';
import type { FactoryState, LocalWorkerState, RepoReadFailure, Team } from './wire';
import { projectColor, contrastColor } from './color';
import { createNavGuardRegistry, NavGuardContext } from './navGuard';
import { ProjectCombobox } from './ProjectCombobox';
import { inRepos } from './repoFilter';
import { loadFilter, saveFilter, type HubFilter } from './filterState';
import { resolveScreen, screenFromUrl, setUrlParam, settingsSectionFromUrl, urlForScreen } from './screenUrl';
import { hubSignedIn, isDemoMode, hubSignOut, onHubRestart, onHubConnectionIssue } from './transport';
import { applyTheme, initialTheme, saveTheme } from './theme';
import type { Project, ActiveRun } from './taskcell-output';
import type { StampedNeeds } from './features/home/homeModel';
import { clearPalette, loadPalette, paletteItems, type PaletteCard, type PaletteRun } from './paletteIndex';

export default function App() {
  const [allProjects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(loadTeamId);
  // Nothing is picked (active project, repository filter) before the first teams answer, or the unscoped list would win.
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  // The first unscoped project list has answered: "no projects" is only believed after that.
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  // Bumped by every local team edit so an older in-flight listTeams cannot overwrite it.
  const teamsGen = useRef(0);
  const team = resolveTeam(teams, teamId);
  // The selected team's projects as the hub lists them for its id: a signed-in user's unscoped list is
  // their first team's, so it cannot stand in for another team. Bumped to re-read after an add/remove.
  const [scoped, setScoped] = useState<{ teamId: string; list: Project[] } | null>(null);
  const [scopedNonce, setScopedNonce] = useState(0);
  const scopeId = team?.id;
  // Home, Board and Runs see only the selected team's repositories (no teams loaded = every project);
  // until the team's own list answers, the unscoped one filtered by the team's repositories stands in.
  const projects = useMemo(
    () => (scoped !== null && scoped.teamId === scopeId ? scoped.list : teamProjects(allProjects, team)),
    [scoped, scopeId, allProjects, team],
  );
  const [activeProject, setActiveProject] = useState<string | null>(null);
  // The filter Home, Board and Runs share (persisted): triage, projects, card source, search, grouping.
  const [filter, setFilter] = useState<HubFilter>(loadFilter);
  const [screen, setScreen] = useState<Screen>(screenFromUrl);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(settingsSectionFromUrl);
  // What waits on the user: the one poll behind Home's Waiting for you list, its sentence and the Home badge.
  const [needs, setNeeds] = useState<{ items: StampedNeeds[]; failures: RepoReadFailure[] } | null>(null);
  const [needsError, setNeedsError] = useState<string | null>(null);
  const [needsNonce, setNeedsNonce] = useState(0);
  const needsCount = needs?.items.length ?? 0;
  const [focusRunning, setFocusRunning] = useState<ActiveRun | null>(null);
  // ⌘K's picks: a finished run for Runs, a card for the Board (a fresh object per pick).
  const [focusRun, setFocusRun] = useState<PaletteRun | null>(null);
  const [openCard, setOpenCard] = useState<PaletteCard | null>(null);
  // A pick is spent once its screen is left: the Inspector remounts on the next screen and would open it again there.
  useEffect(() => {
    if (screen !== 'runs') {
      setFocusRun(null);
      setFocusRunning(null);
    }
    if (screen !== 'board') setOpenCard(null);
  }, [screen]);
  const [crumb, setCrumb] = useState<string | null>(null);
  // The task screen's trailing breadcrumb: the open conversation's name, click-to-rename
  // (dogfood r3). Published by TaskDraftScreen, cleared on its unmount.
  const [taskCrumb, setTaskCrumb] = useState<{ name: string; onRename: (v: string) => void } | null>(null);
  const [clearNonce, setClearNonce] = useState(0);
  // Bumped on every New Task click (S10): the task screen resets to a fresh draft only on an
  // unconsumed nonce, so returning to the screen by other paths restores the last-open draft.
  const [newTaskNonce, setNewTaskNonce] = useState(0);
  const [palette, setPalette] = useState(false);
  // Each palette open reads the team's cards and runs once (a cold start knows only what Board or Runs published); no polling.
  const [, setPaletteLoads] = useState(0);
  useEffect(() => {
    if (!palette) return;
    let alive = true;
    void loadPalette(team?.id).then(() => alive && setPaletteLoads((n) => n + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette]);
  const [hubRestarted, setHubRestarted] = useState(false);
  const [hubConnectionIssue, setHubConnectionIssue] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => void hubSignedIn().then(setSignedIn), []);
  // Navigation guard (S8, #339): a dirty screen registers a confirm; ALL App-owned navigation
  // routes through navigate(), because a project switch REMOUNTS Inspector (key below) and a
  // screen switch unmounts the editor — component-local confirms never fire for either.
  // Lazy init (review #343 r4 nit): useRef(create()) would re-run the factory every render and
  // discard the result — harmless here, but the idiom avoids the per-render allocation.
  const navGuardRef = useRef<ReturnType<typeof createNavGuardRegistry> | null>(null);
  navGuardRef.current ??= createNavGuardRegistry();
  const navGuard = navGuardRef as { current: ReturnType<typeof createNavGuardRegistry> };
  const navigate = (fn: () => void): void => {
    if (!navGuard.current.confirm()) return;
    fn();
  };
  // The address names the open screen: a reload restores it, and Back/Forward move between screens.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const sectionRef = useRef(settingsSection);
  sectionRef.current = settingsSection;
  useEffect(() => {
    // A screen change is a history step; a Settings section change only rewrites the address (Back leaves Settings, not a section).
    if (screenFromUrl() !== screen) window.history.pushState(window.history.state, '', urlForScreen(screen, settingsSection));
    else if (screen === 'settings' && settingsSectionFromUrl() !== settingsSection) window.history.replaceState(window.history.state, '', urlForScreen(screen, settingsSection));
  }, [screen, settingsSection]);
  useEffect(() => {
    const onPop = (): void => {
      const to = screenFromUrl();
      const section = settingsSectionFromUrl();
      if (to === screenRef.current && (to !== 'settings' || section === sectionRef.current)) return;
      if (navGuard.current.confirm()) {
        setScreen(to);
        setSettingsSection(section);
      }
      // Unsaved work kept: the address goes back to the screen that stays open.
      else window.history.pushState(window.history.state, '', urlForScreen(screenRef.current, sectionRef.current));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [theme, setTheme] = useState<Theme>(() => {
    // index.html already applied this before first paint; re-apply so React owns it from here.
    const initial = initialTheme();
    applyTheme(initial);
    return initial;
  });

  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      listProjects()
        .then((p) => {
          if (!alive) return;
          setProjects(p);
          setProjectsLoaded(true);
        })
        .catch(() => {});
      const gen = teamsGen.current;
      listTeams()
        .then((t) => {
          if (alive && gen === teamsGen.current) setTeams(t);
        })
        .catch(() => {})
        .finally(() => alive && setTeamsLoaded(true));
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (scopeId === undefined) return;
    let alive = true;
    const tick = (): void => {
      listProjects(scopeId)
        .then((list) => {
          if (alive) setScoped({ teamId: scopeId, list });
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [scopeId, scopedNonce]);

  // Default the current project to the persisted filter's repository, else the first, once projects load;
  // a project that left the selected team (team switch, repository removed) is replaced the same way.
  useEffect(() => {
    if (!teamsLoaded) return;
    // An empty list is believed only once it is the team's own answer (or the team has no repositories):
    // the stand-in used while that answer is in flight can be empty for a team that has some.
    const known = projects.length > 0 || (scoped !== null && scoped.teamId === scopeId) || team?.repositories.length === 0;
    if (activeProject && known && !projects.some((p) => p.path === activeProject)) setActiveProject(null);
    else if (!activeProject && projects.length) {
      setActiveProject(projects.find((p) => filter.repos.includes(p.path))?.path ?? projects[0].path);
    }
  }, [teamsLoaded, projects, activeProject, filter.repos, scoped, scopeId, team]);

  // A persisted filter naming repositories that are gone drops them.
  useEffect(() => {
    if (teamsLoaded && projects.length && filter.repos.some((r) => !projects.some((p) => p.path === r))) {
      changeFilter({ ...filter, repos: filter.repos.filter((r) => projects.some((p) => p.path === r)) });
    }
  }, [teamsLoaded, projects, filter]);

  const updateTeam = (t: Team): void => {
    teamsGen.current++;
    setTeams((all) => all.map((x) => (x.id === t.id ? t : x)));
    setScopedNonce((n) => n + 1);
  };

  // Re-read the teams and the selected team's projects after a local add/remove.
  const reloadTeams = async (): Promise<void> => {
    teamsGen.current++;
    setTeams(await listTeams().catch(() => teams));
    setScopedNonce((n) => n + 1);
  };

  // A project just added or cloned: a non-default team lists only what an admin put in it, so try to put
  // it there (a member is refused, and the project then shows on the default team only); then re-read.
  const adoptProject = async (path: string): Promise<void> => {
    teamsGen.current++;
    if (team && team.id !== 'default') await teamAddRepository(team.id, path).catch(() => undefined);
    await reloadTeams();
  };

  const chooseTeam = (id: string): void =>
    navigate(() => {
      if (id !== teamId) clearPalette();
      setTeamId(id);
      saveTeamId(id);
    });

  const changeFilter = (f: HubFilter): void => {
    setFilter(f);
    saveFilter(f);
    // One repository in the filter is the project New task and Settings act on.
    if (f.repos.length === 1) setActiveProject(f.repos[0]);
  };

  // Window close is the third discard path. Tauri/WKWebView does not reliably fire beforeunload
  // on native close, so onCloseRequested is the primary hook (beforeunload kept as a belt) — and
  // the only hook at all in a browser, where there is no Tauri window to close.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (navGuard.current.guarded()) {
        e.preventDefault();
        e.returnValue = ''; // some WebKit/Chromium builds need returnValue, not just preventDefault
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const un = getCurrentWindow().onCloseRequested(async (event) => {
      if (!navGuard.current.confirm()) {
        event.preventDefault();
        return;
      }
      // S10: a screen with debounced writes registered a flush — a fire-and-forget invoke would
      // race webview teardown, so hold the close, await the flush (bounded), then close for real.
      // destroy() skips this handler, so there is no re-entry loop.
      if (navGuard.current.hasFlush()) {
        event.preventDefault();
        await navGuard.current.flush(2000);
        void getCurrentWindow().destroy();
      }
    });
    return () => void un.then((f) => f());
  }, []);

  // A restarted hub invalidates this page's per-launch token: every RPC 401s and the SSE stream
  // stays closed, so point at the launch URL instead of letting the UI go silently stale.
  useEffect(() => {
    const un = onHubRestart(() => setHubRestarted(true));
    return () => void un.then((f) => f());
  }, []);

  // Anything else that kills the SSE stream for good — a 403 from the Host check, a reverse proxy's
  // 502 — is not fixed by reloading, so it gets its own neutral banner instead of "the hub restarted".
  useEffect(() => {
    const un = onHubConnectionIssue(() => setHubConnectionIssue(true));
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [showRepoPicker, setShowRepoPicker] = useState(false);
  // First-run guide: shown on a fresh hub, and reopened from Settings. A first project earns a starter task offer.
  const [onboarding, setOnboarding] = useState<OnboardingStored>(loadOnboarding);
  const [setupOpen, setSetupOpen] = useState(false);
  const [starterFor, setStarterFor] = useState<{ path: string; name: string } | null>(null);
  const changeOnboarding = (s: OnboardingStored): void => {
    setOnboarding(s);
    saveOnboarding(s);
  };
  // Once opened on a first run it stays until the user finishes, so the repo step can show Done.
  // A hub is fresh only when it has no project in any team (a team can be empty on an established hub).
  const firstRun = teamsLoaded && projectsLoaded && showOnFirstRun(onboarding, allProjects.length);
  // Set during render, not in an effect: a late effect could reopen the guide after Dismiss.
  if (firstRun && !setupOpen) setSetupOpen(true);
  const showSetup = setupOpen || firstRun;
  const offerStarter = (project: { path: string; name: string } | undefined): void => {
    if (project && allProjects.length === 0) setStarterFor({ path: project.path, name: project.name });
  };

  // Each project's factory checklist for its card's Auto-run line; re-read whenever Home shows (setup is in Settings → Line).
  const [factoryStates, setFactoryStates] = useState<Record<string, FactoryState>>({});
  // Keyed by the path list, not `projects`: the 5s project poll replaces that array every tick.
  const projectPaths = projects.map((p) => p.path).join('\n');
  const showHomeNow = screen === 'home' || activeProject === null;
  useEffect(() => {
    if (!showHomeNow || projectPaths === '') return;
    let alive = true;
    void Promise.all(
      projectPaths.split('\n').map((path) => factoryState(path).then((s) => [path, s] as const, () => null)),
    ).then((entries) => {
      if (alive) setFactoryStates(Object.fromEntries(entries.filter((e) => e !== null)));
    });
    return () => {
      alive = false;
    };
  }, [projectPaths, showHomeNow]);

  // The Local hub worker per project (the same refresh): the card shows on / off, last pick-up and last error.
  const [localWorkers, setLocalWorkers] = useState<Record<string, LocalWorkerState>>({});
  useEffect(() => {
    if (!showHomeNow || projectPaths === '') return;
    let alive = true;
    void Promise.all(projectPaths.split('\n').map((path) => localWorkerState(path).then((s) => [path, s] as const, () => null))).then((entries) => {
      if (alive) setLocalWorkers(Object.fromEntries(entries.filter((e) => e !== null)));
    });
    return () => {
      alive = false;
    };
  }, [projectPaths, showHomeNow]);

  const add = (): void => {
    // One picker everywhere (the desktop window shows the same hub-served UI as a browser): RepoPicker,
    // over the hub's browse_dirs.
    setShowRepoPicker(true);
  };

  const remove = async (path: string): Promise<void> => {
    // Removing the ACTIVE project unmounts Inspector — guard like any navigation.
    if (activeProject === path && !navGuard.current.confirm()) return;
    try {
      setProjects(await removeProject(path));
      await reloadTeams();
      if (activeProject === path) setActiveProject(null);
    } catch {
      /* ignore */
    }
  };

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    saveTheme(next);
  };

  // Old entries to the Needs you screen open Home, which starts with that section.
  // The Board from the top bar shows the saved filter (all projects until the user narrows it); entering one
  // project narrows the board for this visit only, so the saved choice is not overwritten.
  const goto = (s: Screen | 'needs'): void =>
    navigate(() => {
      const next = resolveScreen(s).screen;
      if (next === 'board') setFilter(loadFilter());
      setScreen(next);
    });

  const enterProject = (path: string, to: Screen = 'board'): void => {
    navigate(() => {
      setActiveProject(path);
      setFilter({ ...filter, repos: [path] });
      setScreen(to);
    });
  };

  // A tile's (or ⌘K's) Auto-run: that project's Settings → Line, station 01 Card, where the setup lives.
  const openAutoRun = (p: { path: string }): void =>
    navigate(() => {
      setUrlParam('station', 'card');
      setActiveProject(p.path);
      setSettingsSection('line');
      setScreen('settings');
    });

  // Opens one live run on Runs (Home's Moving rows, a Board card's Open the run); also discards a dirty editor.
  const openRunning = (r: ActiveRun): void =>
    navigate(() => {
      setScreen('runs');
      // A fresh object per click, so a repeat click on the same row still reopens the live run.
      setFocusRunning({ ...r });
    });

  // ⌘K opens a card on the Board: the address names it, and a Board already open is told directly.
  const openCardFromPalette = (c: PaletteCard): void =>
    navigate(() => {
      // A card of a repository the Projects filter leaves out would be closed at once: show every repository for this visit.
      if (filter.repos.length > 0 && c.repoPath !== undefined && !filter.repos.includes(c.repoPath)) setFilter({ ...filter, repos: [] });
      setUrlParam('card', c.id);
      setOpenCard({ ...c });
      setScreen('board');
    });
  const openRunFromPalette = (r: PaletteRun): void =>
    navigate(() => {
      setScreen('runs');
      setFocusRun({ ...r });
    });

  const active = projects.find((p) => p.path === activeProject) ?? null;
  // The hub's answer on what this caller may do; every Add project / Enable factory gate reads it.
  const caps = useCallerCapabilities(active?.path);
  const addGate = caps?.canAddProject;
  const factoryGate = factoryGateOf(caps);
  const showHome = screen === 'home' || !active;
  const titleBar = !showHome && active ? projectColor(active) : null;
  const needsYou = active !== null;
  // Home and the needs-you badge always cover every project of the team: the Board/Runs project filter is theirs alone.
  const repoPaths = projects.map((p) => p.path);
  const repoKey = repoPaths.join('\n');

  // Another scope: the old one's items and error must not show while the new read is out.
  useEffect(() => {
    setNeeds(null);
    setNeedsError(null);
  }, [scopeId, repoKey]);

  // The one read of what waits on the user (30 s, and after a reply or merge): Home's list, its sentence and the badge.
  useEffect(() => {
    if (!needsYou || !activeProject) {
      setNeeds(null);
      return;
    }
    let alive = true;
    const repos = repoKey.split('\n');
    const tick = (): void => {
      listNeedsYouAll(scopeId)
        .then((l) => {
          if (!alive) return;
          setNeeds({ items: inRepos(l.items, repos), failures: inRepos(l.failures, repos) });
          setNeedsError(null);
        })
        .catch((e) => alive && setNeedsError(String(e)));
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [needsYou, activeProject, scopeId, repoKey, needsNonce]);

  const SCREEN_LABEL: Record<Screen, string> = {
    home: 'Home',
    runs: 'Runs',
    board: 'Board',
    task: 'New card',
    settings: 'Settings',
  };
  // Home lives on the logo now; the project is picked in the filter (Board, Runs) or on the screen that needs one (Settings, New Task).
  const crumbs: Crumb[] = [];
  if (active && screen === 'task' && taskCrumb) {
    crumbs.push({ label: SCREEN_LABEL[screen] });
    crumbs.push({
      label: taskCrumb.name,
      edit: { placeholder: 'Name the card…', ariaLabel: 'rename card', onCommit: taskCrumb.onRename },
    });
  } else if (active && screen !== 'home') {
    if (crumb) {
      crumbs.push({ label: SCREEN_LABEL[screen], onClick: () => setClearNonce((n) => n + 1) });
      crumbs.push({ label: crumb });
    }
    // No crumb for a screen alone: the top-bar nav already marks it (it read "Settings | Settings").
  }
  const projectPicker =
    // Hub-wide Settings sections (Team & hub, Audit) belong to no project: no picker there.
    active && ((screen === 'settings' && !HUB_WIDE_SECTIONS.includes(settingsSection)) || screen === 'task') ? (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-sm">
        <span className="text-muted-foreground">Project:</span>
        <ProjectCombobox projects={projects} active={active} onSelect={(v) => navigate(() => setActiveProject(v))} />
      </div>
    ) : null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Custom titlebar (native decorations overlaid, macOS): the app/project identity. In a project
          it takes that project's color so the working context is unmistakable; generic on the dashboard.
          Tauri only — a browser (the hub, the dev mock) has its own chrome, so it would be a stray band. */}
      {isTauri() && (
        <div
          data-tauri-drag-region
          className="flex h-8 shrink-0 select-none items-center pl-20 pr-4 text-[13px] font-semibold text-foreground"
          style={titleBar ? { backgroundColor: titleBar, color: contrastColor(titleBar) } : undefined}
        >
          Taskcell Hub
        </div>
      )}
      {hubRestarted && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          This tab has no valid hub token. The token lives only in the tab that opened the launch link, so a new browser
          or tab opened by hand needs that link (<code className="font-mono">…/#token=…</code>): open the URL that{' '}
          <code className="font-mono">taskcell hub</code> printed in its terminal. Reloading will not help there. In the desktop app, the hub
          restarts on its own: quit and reopen the app if this stays. Your projects are still there.
        </div>
      )}
      {!hubRestarted && hubConnectionIssue && (
        <div role="alert" className="shrink-0 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
          Lost connection to the hub — check your network and reload if it doesn't come back.
        </div>
      )}
      {isDemoMode() && (
        <div role="status" className="shrink-0 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
          Demo project — sample data, read-only. Nothing is written to any repository or remote.
          {!window.__TASKCELL_DEMO__ && (
            <a className="ml-2 underline" href="/">
              Exit demo
            </a>
          )}
        </div>
      )}
      {/* A tab the hub refused from the start has nothing loaded: an empty Home ("No projects yet") under
          the refusal would read as lost projects. A tab that was already showing work keeps it on screen. */}
      {!(hubRestarted && projects.length === 0) && (
      <>
      <TopBar
        nav={
          <MainNav
            screen={showHome ? 'home' : screen}
            needsCount={needsCount}
            hasProject={active !== null}
            onScreen={(sc) =>
              navigate(() => {
                // A click on the screen already open leaves its drill-down (a run detail, a live strip) for the list.
                if (!showHome && sc === screen) setClearNonce((n) => n + 1);
                // The top-bar Board shows the saved filter, not a one-project visit entered from Home.
                if (sc === 'board') setFilter(loadFilter());
                setScreen(sc);
              })
            }
            onSettings={(section) =>
              navigate(() => {
                setSettingsSection(section);
                setScreen('settings');
              })
            }
          />
        }
        // Always shown: the server and team switchers live here, even when the selected team has no project yet.
        team={<TeamSwitcher teams={teams} active={team} onSelect={chooseTeam} />}
        switchers={<ServerSwitcher />}
        crumbs={crumbs}
        onHome={() => goto('home')}
        onCommandK={() => setPalette(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        {...(signedIn ? { onSignOut: () => { clearPalette(); void hubSignOut(); } } : {})}
      />
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden max-md:pb-16">
          {showHome ? (
            <div className="h-full overflow-y-auto">
              {/* One tree whether or not a project is active, so the project cards do not remount when one is picked. */}
              <div className={cn(PAGE_CLASS, 'space-y-6')}>
                {/* Before the project list arrives, Home's skeleton: not "No projects yet" for a hub that has some. */}
                {!projectsLoaded && <HomeSkeleton />}
                {projectsLoaded && active && (
                  <Home
                    project={active.path}
                    projects={projects}
                    repoPaths={repoPaths}
                    teamId={scopeId}
                    needs={needs}
                    needsError={needsError}
                    onReloadNeeds={() => setNeedsNonce((n) => n + 1)}
                    factoryStates={factoryStates}
                    localWorkers={localWorkers}
                    onOpenRunning={openRunning}
                    onEnterProject={(path) => enterProject(path, 'board')}
                    onSeeAllMoving={() =>
                      navigate(() => {
                        changeFilter({ ...filter, triage: 'running', repos: [] });
                        setScreen('board');
                      })
                    }
                    onOpenFactory={openAutoRun}
                    onOpenBoard={() => goto('board')}
                    onOpenCard={openCardFromPalette}
                    onOpenRun={openRunFromPalette}
                  />
                )}
                {showSetup && (
                  <Onboarding
                    projectCount={projects.length}
                    stored={onboarding}
                    onStored={changeOnboarding}
                    onAddRepo={add}
                    onClose={() => setSetupOpen(false)}
                  />
                )}
                {projectsLoaded && <Dashboard
                  projects={projects}
                  onOpenSetup={() => setSetupOpen(true)}
                  onOpen={(p) => enterProject(p.path)}
                  onAdd={add}
                  addGate={addGate}
                  onRemove={remove}
                  onOpenAutoRun={openAutoRun}
                  factory={factoryStates}
                  localWorker={localWorkers}
                />}
              </div>
            </div>
          ) : (
            <NavGuardContext.Provider value={navGuard.current}>
              {projectPicker}
              <Inspector
                key={active.path}
                project={active.path}
                allRepos
                filter={filter}
                onFilter={changeFilter}
                projects={projects}
                teamId={scopeId}
                {...(team
                  ? {
                      teamScreen: {
                        team,
                        allProjects,
                        onTeam: updateTeam,
                        // Removing the open project's repository unmounts it: ask like any navigation.
                        confirmRemoveRepo: (path: string) => path !== activeProject || navGuard.current.confirm(),
                      },
                    }
                  : {})}
                screen={screen}
                settingsSection={settingsSection}
                onSettingsSection={setSettingsSection}
                focusRunning={focusRunning}
                focusRun={focusRun}
                openCard={openCard}
                clearNonce={clearNonce}
                newTaskNonce={newTaskNonce}
                onCrumb={setCrumb}
                onTaskCrumb={setTaskCrumb}
                onNewTask={() =>
                  navigate(() => {
                    setScreen('task');
                    setNewTaskNonce((n) => n + 1);
                  })
                }
                onOpenBoard={() => navigate(() => setScreen('board'))}
                onOpenRuns={() => setScreen('runs')}
                onOpenRunning={openRunning}
                onOpenSettings={() => navigate(() => setScreen('settings'))}
                onOpenSetup={() => navigate(() => {
                  setSetupOpen(true);
                  setScreen('home');
                })}
              />
            </NavGuardContext.Provider>
          )}
        </main>
      </div>
      </>
      )}
      {palette && (
        <CommandPalette
          projects={projects}
          {...paletteItems()}
          onOpenCard={openCardFromPalette}
          onOpenRun={openRunFromPalette}
          onOpenProject={(p) => enterProject(p.path)}
          onHome={() => goto('home')}
          {...(needsYou ? { onNeedsYou: () => goto('needs') } : {})}
          {...(active
            ? {
                projectName: active.name,
                // Board and Runs show the filter's repositories, not the open project.
                scopeName:
                  filter.repos.length === 0
                    ? 'All projects'
                    : filter.repos.length === 1
                      ? (projects.find((p) => p.path === filter.repos[0])?.name ?? filter.repos[0])
                      : `${filter.repos.length} projects`,
                onScreen: (s: 'board' | 'runs' | 'settings') => navigate(() => setScreen(s)),
                ...(caps?.project?.canCreateTask.allowed === false
                  ? {}
                  : {
                      onNewTask: () =>
                        navigate(() => {
                          setScreen('task');
                          setNewTaskNonce((n) => n + 1);
                        }),
                    }),
                ...(factoryGate?.allowed === false ? {} : { onAutoRun: () => openAutoRun(active) }),
              }
            : {})}
          {...(addGate?.allowed === false ? {} : { onAddProject: add })}
          onToggleTheme={toggleTheme}
          onClose={() => setPalette(false)}
        />
      )}
      {showRepoPicker && (
        <RepoPicker
          added={projects.map((p) => p.path)}
          onAdd={async (path) => {
            const list = await addProject(path);
            setProjects(list);
            await adoptProject(path);
            setShowRepoPicker(false);
            offerStarter(list.find((p) => p.path === path));
          }}
          onClone={async (url, parentDir, name) => {
            const project = await cloneProject(url, parentDir, name, team?.id);
            setProjects((prev) => [...prev, project]);
            await adoptProject(project.path);
            setShowRepoPicker(false);
            offerStarter(project);
          }}
          onClose={() => setShowRepoPicker(false)}
        />
      )}
      {starterFor && (
        <StarterTaskDialog
          project={starterFor}
          onCreated={() => {
            setStarterFor(null);
            enterProject(starterFor.path, 'board');
          }}
          onClose={() => setStarterFor(null)}
        />
      )}
      <TailwindDebugScreens />
    </div>
  );
}
