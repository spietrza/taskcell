import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Home, MessageCircleQuestionMark, FolderPlus, FolderGit2, SunMoon, Columns3, List, Settings as SettingsIcon, FilePlus, Factory } from 'lucide-react';
import { useFocusTrap } from '@/ui';
import type { Project } from './taskcell-output';

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
  onScreen,
  onNewTask,
  onEnableFactory,
  onAddProject,
  onToggleTheme,
  onClose,
}: {
  projects: Project[];
  onOpenProject: (p: { path: string; name: string }) => void;
  onHome: () => void;
  /** Hub only: opens Home at its Needs you section (the old Needs you screen). */
  onNeedsYou?: () => void;
  /** The open project, named in the commands that act on it. */
  projectName?: string;
  /** Screens of the open project (Board, Runs, Settings); omitted while none is open. */
  onScreen?: (s: 'board' | 'runs' | 'settings') => void;
  onNewTask?: () => void;
  /** Hub only: opens the Enable factory dialog for the open project. */
  onEnableFactory?: () => void;
  onAddProject: () => void;
  onToggleTheme: () => void;
  onClose: () => void;
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
      { id: 'home', label: 'All projects', icon: <Home className="size-4" />, run: onHome },
      ...(onNeedsYou ? [{ id: 'needs', label: 'Needs you', icon: <MessageCircleQuestionMark className="size-4" />, run: onNeedsYou }] : []),
      ...(onScreen
        ? [
            { id: 'board', label: `Board · ${projectName}`, icon: <Columns3 className="size-4" />, run: () => onScreen('board') },
            { id: 'runs', label: `Runs · ${projectName}`, icon: <List className="size-4" />, run: () => onScreen('runs') },
            { id: 'settings', label: `Settings · ${projectName}`, icon: <SettingsIcon className="size-4" />, run: () => onScreen('settings') },
          ]
        : []),
      ...(onNewTask ? [{ id: 'new-task', label: `New task · ${projectName}`, icon: <FilePlus className="size-4" />, run: onNewTask }] : []),
      ...(onEnableFactory ? [{ id: 'factory', label: `Enable factory · ${projectName}`, icon: <Factory className="size-4" />, run: onEnableFactory }] : []),
      { id: 'add', label: 'Add project', icon: <FolderPlus className="size-4" />, run: onAddProject },
      { id: 'theme', label: 'Toggle theme', icon: <SunMoon className="size-4" />, run: onToggleTheme },
      ...projects.map((p) => ({
        id: `p:${p.path}`,
        label: `Open ${p.name}`,
        hint: p.path,
        icon: <FolderGit2 className="size-4" />,
        run: () => onOpenProject({ path: p.path, name: p.name }),
      })),
    ],
    [projects, projectName, onHome, onNeedsYou, onScreen, onNewTask, onEnableFactory, onAddProject, onToggleTheme, onOpenProject],
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cmds;
    return cmds.filter((c) => c.label.toLowerCase().includes(s) || c.hint?.toLowerCase().includes(s));
  }, [cmds, q]);

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
          placeholder="Search projects & actions…"
          role="combobox"
          aria-label="Search projects and actions"
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
