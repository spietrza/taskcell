import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Home, MessageCircleQuestionMark, FolderPlus, FolderGit2, SunMoon, Columns3, List, Settings as SettingsIcon, FilePlus, Factory, SquareKanban, Play } from 'lucide-react';
import { useFocusTrap } from '@/ui';
import type { Project } from './taskcell-output';
import type { PaletteCard, PaletteRun } from './paletteIndex';

/** Cards and runs shown per kind for a query: the palette is a jump list, not a search page. */
const MAX_ITEMS = 20;

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({
  projects,
  onOpenProject,
  onHome,
  onNeedsYou,
  projectName,
  scopeName,
  onScreen,
  onNewTask,
  onAutoRun,
  onAddProject,
  onToggleTheme,
  onClose,
  cards = [],
  runs = [],
  onOpenCard,
  onOpenRun,
}: {
  projects: Project[];
  onOpenProject: (p: { path: string; name: string }) => void;
  onHome: () => void;
  /** Hub only: opens Home at its Needs you section (the old Needs you screen). */
  onNeedsYou?: () => void;
  /** The open project, named in the commands that act on it (Settings, New card, Auto-run). */
  projectName?: string;
  /** What Board and Runs show: "All repositories", one project's name, or a count. Defaults to `projectName`. */
  scopeName?: string;
  /** Screens of the open project (Board, Runs, Settings); omitted while none is open. */
  onScreen?: (s: 'board' | 'runs' | 'settings') => void;
  onNewTask?: () => void;
  /** Opens the open project's auto-run setup (Settings → Line, station Card); omitted when the hub refuses it. */
  onAutoRun?: () => void;
  /** Omitted when the hub refuses it (`caller_capabilities`). */
  onAddProject?: () => void;
  onToggleTheme: () => void;
  onClose: () => void;
  /** Cards and runs the app last loaded; searched by id and title within `projects`. */
  cards?: readonly PaletteCard[];
  runs?: readonly PaletteRun[];
  onOpenCard?: (c: PaletteCard) => void;
  onOpenRun?: (r: PaletteRun) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const cmds = useMemo<Cmd[]>(
    () => [
      { id: 'home', label: 'Home', icon: <Home className="size-4" />, run: onHome },
      ...(onNeedsYou ? [{ id: 'needs', label: 'Waiting for you', hint: 'Home', icon: <MessageCircleQuestionMark className="size-4" />, run: onNeedsYou }] : []),
      ...(onScreen
        ? [
            { id: 'board', label: `Board · ${scopeName ?? projectName}`, icon: <Columns3 className="size-4" />, run: () => onScreen('board') },
            { id: 'runs', label: `Runs · ${scopeName ?? projectName}`, icon: <List className="size-4" />, run: () => onScreen('runs') },
            { id: 'settings', label: `Settings · ${projectName}`, icon: <SettingsIcon className="size-4" />, run: () => onScreen('settings') },
          ]
        : []),
      ...(onNewTask ? [{ id: 'new-task', label: `New card · ${projectName}`, icon: <FilePlus className="size-4" />, run: onNewTask }] : []),
      ...(onAutoRun ? [{ id: 'auto-run', label: `Set up auto-run · ${projectName}`, hint: 'Settings → Line', icon: <Factory className="size-4" />, run: onAutoRun }] : []),
      ...(onAddProject ?[{ id: 'add', label: 'Add project', icon: <FolderPlus className="size-4" />, run: onAddProject }] : []),
      { id: 'theme', label: 'Toggle theme', icon: <SunMoon className="size-4" />, run: onToggleTheme },
      ...projects.map((p) => ({
        id: `p:${p.path}`,
        label: `Open ${p.name}`,
        hint: p.path,
        icon: <FolderGit2 className="size-4" />,
        run: () => onOpenProject({ path: p.path, name: p.name }),
      })),
    ],
    [projects, projectName, scopeName, onHome, onNeedsYou, onScreen, onNewTask, onAutoRun, onAddProject, onToggleTheme, onOpenProject],
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cmds;
    const hit = (...texts: (string | undefined)[]): boolean => texts.some((t) => t?.toLowerCase().includes(s));
    const names = new Map(projects.map((p) => [p.path, p.name]));
    // An item that names no repository cannot be placed in the team, so it is not offered.
    const shown = (repo: string | undefined): boolean => repo !== undefined && names.has(repo);
    const titles = new Map(cards.map((c) => [`${c.repoPath ?? ''}\n${c.id}`, c.title]));
    const found: Cmd[] = [
      ...cards
        .filter((c) => shown(c.repoPath) && hit(c.id, c.title))
        .slice(0, MAX_ITEMS)
        .flatMap((c) => (onOpenCard ? [{ id: `c:${c.repoPath}:${c.id}`, label: `${c.id} · ${c.title}`, hint: names.get(c.repoPath ?? ''), icon: <SquareKanban className="size-4" />, run: () => onOpenCard(c) }] : [])),
      ...runs
        .filter((r) => r.source !== 'ci' && shown(r.repoPath))
        .map((r) => ({ r, title: titles.get(`${r.repoPath ?? ''}\n${r.taskId}`) }))
        .filter(({ r, title }) => hit(r.taskId, title))
        .slice(0, MAX_ITEMS)
        .flatMap(({ r, title }) =>
          onOpenRun
            ? [{ id: `r:${r.repoPath}:${r.taskId}:${r.timestamp}`, label: `Run · ${r.taskId}${title ? ` · ${title}` : ''}`, hint: [names.get(r.repoPath ?? ''), r.timestamp.slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · '), icon: <Play className="size-4" />, run: () => onOpenRun(r) }]
            : [],
        ),
    ];
    return [...cmds.filter((c) => hit(c.label, c.hint)), ...found];
  }, [cmds, q, cards, runs, projects, onOpenCard, onOpenRun]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  const exec = (c?: Cmd): void => {
    if (c) {
      c.run();
      onClose();
    }
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      exec(filtered[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // this layer took the key: a popup open underneath stays
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search projects, cards, runs & actions…"
          role="combobox"
          aria-label="Search projects, cards, runs and actions"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={filtered[sel] ? `cmd-${sel}` : undefined}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        <div id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-80 overflow-auto p-1">
          {filtered.length === 0 ? (
            <div role="option" aria-disabled="true" aria-selected="false" className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                id={`cmd-${i}`}
                role="option"
                aria-selected={i === sel}
                tabIndex={-1}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(c)}
                className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${
                  i === sel ? 'bg-muted' : 'hover:bg-muted/60'
                }`}
              >
                <span className="text-muted-foreground">{c.icon}</span>
                <span>{c.label}</span>
                {c.hint && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
