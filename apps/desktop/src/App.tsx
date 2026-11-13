import { useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { type Theme } from '@/ui';
import { TopBar, type Crumb } from './TopBar';
import { Rail, resolveScreen, type Screen } from './Rail';
import { CommandPalette } from './CommandPalette';
import { RepoPicker } from './RepoPicker';
import { TailwindDebugScreens } from './components/TailwindDebugScreens';
import { Dashboard } from './features/dashboard/Dashboard';
import { NeedsYou, canUseNeedsYou } from './features/needs-you/NeedsYou';
import { Inspector } from './features/inspector/Inspector';
import { EnableFactoryDialog } from './features/dashboard/EnableFactoryDialog';
import { listProjects, addProject, cloneProject, removeProject, listActive, listNeedsYou, listNeedsYouAll, listTeams, teamAddRepository } from './ipc';
import { loadTeamId, resolveTeam, saveTeamId, teamProjects } from './teams';
import type { Team } from './wire';
import { projectColor, contrastColor } from './color';
import { createNavGuardRegistry, NavGuardContext } from './navGuard';
import { ProjectCombobox } from './ProjectCombobox';
import { ALL_REPOS, canUseAllRepos, inRepos, loadRepoFilter, saveRepoFilter } from './repoFilter';
import { hubSignedIn, hubSignOut, onHubRestart, onHubConnectionIssue } from './transport';
import { applyTheme, initialTheme, saveTheme } from './theme';
import type { Project, ActiveRun } from './taskcell-output';

export default function App() {
  const [allProjects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(loadTeamId);
  // Nothing is picked (active project, repository filter) before the first teams answer, or the unscoped list would win.
  const [teamsLoaded, setTeamsLoaded] = useState(false);
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
  // The repository filter Home, Board and Runs share (persisted): ALL_REPOS or the active project's path.
  const [repoFilter, setRepoFilter] = useState<string>(loadRepoFilter);
  const [screen, setScreen] = useState<Screen>('home');
  // How many items wait on the user (Home's Needs you section); badges Home in the rail.
  const [needsCount, setNeedsCount] = useState(0);
  const [railRunning, setRailRunning] = useState<ActiveRun[]>([]);
  const [focusRunning, setFocusRunning] = useState<ActiveRun | null>(null);
  const [crumb, setCrumb] = useState<string | null>(null);
  // The task screen's trailing breadcrumb: the open conversation's name, click-to-rename
  // (dogfood r3). Published by TaskDraftScreen, cleared on its unmount.
  const [taskCrumb, setTaskCrumb] = useState<{ name: string; onRename: (v: string) => void } | null>(null);
  const [clearNonce, setClearNonce] = useState(0);
  // Bumped on every New Task click (S10): the task screen resets to a fresh draft only on an
  // unconsumed nonce, so returning to the screen by other paths restores the last-open draft.
  const [newTaskNonce, setNewTaskNonce] = useState(0);
  const [palette, setPalette] = useState(false);
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
          if (alive) setProjects(p);
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
    if (activeProject && projects.length && !projects.some((p) => p.path === activeProject)) setActiveProject(null);
    else if (!activeProject && projects.length) {
      setActiveProject(projects.find((p) => p.path === repoFilter)?.path ?? projects[0].path);
    }
  }, [teamsLoaded, projects, activeProject, repoFilter]);

  // A persisted filter naming a repository that is gone falls back to every repository.
  useEffect(() => {
    if (teamsLoaded && repoFilter !== ALL_REPOS && projects.length && !projects.some((p) => p.path === repoFilter)) {
      setRepoFilter(ALL_REPOS);
      saveRepoFilter(ALL_REPOS);
    }
  }, [teamsLoaded, projects, repoFilter]);

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
      setTeamId(id);
      saveTeamId(id);
    });

  const chooseRepo = (value: string): void => {
    if (value !== ALL_REPOS) setActiveProject(value);
    setRepoFilter(value);
    saveRepoFilter(value);
  };

  // Poll the current project's in-flight runs for the rail's Running section.
  useEffect(() => {
    if (!activeProject) {
      setRailRunning([]);
      return;
    }
    let alive = true;
    const tick = (): void => {
      listActive(activeProject)
        .then((a) => {
          if (alive) setRailRunning(a);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeProject]);

  // Window close is the third discard path. Tauri/WKWebView does not reliably fire beforeunload
  // on native close, so onCloseRequested is the primary hook (beforeunload kept as a belt) — and
  // the only hook at all in hub mode, where there is no Tauri window to close.
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
  const [factoryProject, setFactoryProject] = useState<{ path: string; name: string } | null>(null);

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
  const goto = (s: Screen | 'needs'): void => navigate(() => setScreen(resolveScreen(s).screen));

  const enterProject = (path: string): void => {
    navigate(() => {
      chooseRepo(path);
      setScreen('runs');
    });
  };

  const active = projects.find((p) => p.path === activeProject) ?? null;
  const showHome = screen === 'home' || !active;
  const titleBar = !showHome && active ? projectColor(active) : null;
  const allowAll = canUseAllRepos();
  const allRepos = allowAll && repoFilter === ALL_REPOS;
  const needsYou = canUseNeedsYou() && active !== null;
  // The selected team's repositories: Home's section and the badge poll read "All repositories" for them only.
  const repoPaths = projects.map((p) => p.path);
  const repoKey = repoPaths.join('\n');

  // Keep the rail badge current: Home's section reports its own changes, this catches new items elsewhere.
  useEffect(() => {
    if (!needsYou || !activeProject) {
      setNeedsCount(0);
      return;
    }
    let alive = true;
    const repos = repoKey.split('\n');
    const tick = (): void => {
      (allRepos ? listNeedsYouAll(scopeId).then((l) => inRepos(l.items, repos)) : listNeedsYou(activeProject).then((r) => r.items))
        .then((items) => {
          if (alive) setNeedsCount(items.length);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [needsYou, activeProject, allRepos, scopeId, repoKey]);

  const SCREEN_LABEL: Record<Screen, string> = {
    home: 'Home',
    runs: 'Runs',
    board: 'Board',
    task: 'New Task',
    settings: 'Settings',
  };
  // Home lives on the logo now; the project lives in the switcher — so the breadcrumb is just the screen.
  const crumbs: Crumb[] = [];
  if (active && screen === 'task' && taskCrumb) {
    crumbs.push({ label: SCREEN_LABEL[screen] });
    crumbs.push({
      label: taskCrumb.name,
      edit: { placeholder: 'Name this conversation…', ariaLabel: 'rename conversation', onCommit: taskCrumb.onRename },
    });
  } else if (active && screen !== 'home') {
    if (crumb) {
      crumbs.push({ label: SCREEN_LABEL[screen], onClick: () => setClearNonce((n) => n + 1) });
      crumbs.push({ label: crumb });
    } else {
      crumbs.push({ label: SCREEN_LABEL[screen] });
    }
  }
  // Home, Board and Runs offer "All repositories" in the one switcher; other screens list repositories only.
  const filtered = screen === 'home' || screen === 'board' || screen === 'runs';
  const projectSwitcher =
    active ? (
      <ProjectCombobox
        projects={projects}
        active={active}
        allOption={filtered && allowAll}
        all={allRepos}
        onSelect={(v) => navigate(() => chooseRepo(v))}
      />
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
          This tab has no valid hub token (the hub restarted, or the page was opened without its launch
          URL) — open the URL `taskcell hub` printed to reconnect.
        </div>
      )}
      {!hubRestarted && hubConnectionIssue && (
        <div role="alert" className="shrink-0 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
          Lost connection to the hub — check your network and reload if it doesn't come back.
        </div>
      )}
      <TopBar
        crumbs={crumbs}
        projectSwitcher={projectSwitcher}
        onHome={() => goto('home')}
        onCommandK={() => setPalette(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        {...(signedIn ? { onSignOut: () => void hubSignOut() } : {})}
      />
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        {/* Always shown: the server and team switchers live here, even when the selected team has no project yet. */}
        <Rail
          projects={projects}
          activePath={activeProject}
          screen={showHome ? 'home' : screen}
          running={railRunning}
          needsCount={needsCount}
          teams={teams}
          team={team}
          onTeam={chooseTeam}
          onScreen={(sc) => navigate(() => setScreen(sc))}
          onOpenRunning={(r) => {
            // The sixth navigation path (review round 1) — also discards a dirty editor.
            navigate(() => {
              setScreen('runs');
              setFocusRunning(r);
            });
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {showHome ? (
            <div className="h-full overflow-y-auto">
              {/* Home starts with what needs the user; with nothing waiting it says so in one line. */}
              {needsYou && (
                <div className="px-6 pt-6 max-md:px-3 max-md:pt-3">
                  <NeedsYou project={active.path} allRepos={allRepos} repos={repoPaths} teamId={scopeId} onCount={setNeedsCount} />
                </div>
              )}
              <Dashboard
                projects={projects}
                onOpen={(p) => enterProject(p.path)}
                onAdd={add}
                onRemove={remove}
                onEnableFactory={setFactoryProject}
              />
            </div>
          ) : (
            <NavGuardContext.Provider value={navGuard.current}>
              <Inspector
                key={active.path}
                project={active.path}
                allRepos={allRepos}
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
                focusRunning={focusRunning}
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
              />
            </NavGuardContext.Provider>
          )}
        </main>
      </div>
      {palette && (
        <CommandPalette
          projects={projects}
          onOpenProject={(p) => enterProject(p.path)}
          onHome={() => goto('home')}
          {...(needsYou ? { onNeedsYou: () => goto('needs') } : {})}
          onAddProject={add}
          onToggleTheme={toggleTheme}
          onClose={() => setPalette(false)}
        />
      )}
      {showRepoPicker && (
        <RepoPicker
          onAdd={async (path) => {
            setProjects(await addProject(path));
            await adoptProject(path);
            setShowRepoPicker(false);
          }}
          onClone={async (url, parentDir, name) => {
            const project = await cloneProject(url, parentDir, name);
            setProjects((prev) => [...prev, project]);
            await adoptProject(project.path);
            setShowRepoPicker(false);
          }}
          onClose={() => setShowRepoPicker(false)}
        />
      )}
      {factoryProject && <EnableFactoryDialog project={factoryProject} onClose={() => setFactoryProject(null)} />}
      <TailwindDebugScreens />
    </div>
  );
}
