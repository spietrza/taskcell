import { useState } from 'react';
import {
  Home as HomeIcon,
  List,
  Columns3,
  Settings as SettingsIcon,
  PanelLeft,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, Tooltip, cn } from '@/ui';
import type { Project, ActiveRun } from './taskcell-output';
import type { Team } from './wire';
import { TeamSwitcher } from './TeamSwitcher';
import { relTime } from './time';
import { RailTip } from './RailTip';
import { ServerSwitcher } from './ServerSwitcher';

// 'task' (S10) is reached by intent — the New Task button on the board and Runs toolbars — so it
// has no NAV entry; the breadcrumb is its location anchor. Needs you lives on Home; Line, Runners
// and Audit live under Settings.
export type Screen = 'home' | 'runs' | 'board' | 'task' | 'settings';

/** Old entries (links, ⌘K) that now land elsewhere: the separate Needs you screen opens Home at that section. */
export function resolveScreen(s: Screen | 'needs'): { screen: Screen; section?: 'needs' } {
  return s === 'needs' ? { screen: 'home', section: 'needs' } : { screen: s };
}

export const NAV: { key: Screen; label: string; icon: LucideIcon }[] = [
  { key: 'home', label: 'Home', icon: HomeIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'runs', label: 'Runs', icon: List },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function Rail({
  projects,
  activePath,
  screen,
  running,
  needsCount = 0,
  onScreen,
  onOpenRunning,
  teams,
  team,
  onTeam,
}: {
  projects: Project[];
  activePath: string | null;
  screen: Screen;
  running: ActiveRun[];
  /** What waits on the user (Home's Needs you section); badges Home. */
  needsCount?: number;
  onScreen: (s: Screen) => void;
  onOpenRunning: (r: ActiveRun) => void;
  teams: Team[];
  team: Team | undefined;
  onTeam: (id: string) => void;
}) {
  const active = projects.find((p) => p.path === activePath);
  // Base UI Collapsible owns the open/closed state (the trigger gets aria-expanded for free); we persist
  // it and drive the icon-only width off it rather than hiding a panel.
  const [open, setOpen] = useState(() => localStorage.getItem('vg-rail-collapsed') !== '1');
  const collapsed = !open;
  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    localStorage.setItem('vg-rail-collapsed', next ? '0' : '1');
  };

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      render={<aside />}
      className={cn(
        'flex shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20 pt-2 transition-[width] duration-200',
        // Below md the rail becomes a bottom tab bar (rendered last), full width, scrolling inside itself.
        'max-md:order-last max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-r-0 max-md:border-t max-md:pt-0',
        collapsed ? 'w-14' : 'w-36',
      )}
    >
      <Tooltip.Provider delay={200}>
        <ServerSwitcher collapsed={collapsed} />
        {team && (
          <div className="mb-2 px-2">
            <TeamSwitcher teams={teams} active={team} onSelect={onTeam} collapsed={collapsed} onExpand={() => onOpenChange(true)} />
          </div>
        )}
        <nav className="space-y-0.5 px-2 max-md:flex max-md:gap-1 max-md:space-y-0 max-md:py-1">
          {NAV.map((n) => {
            const count = n.key === 'runs' ? active?.runCount : n.key === 'home' && needsCount > 0 ? needsCount : undefined;
            const Icon = n.icon;
            const btn = (
              <button
                type="button"
                onClick={() => onScreen(n.key)}
                aria-current={screen === n.key ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center rounded py-1.5 text-sm transition-colors max-md:min-h-11 max-md:min-w-16 max-md:flex-col max-md:justify-center max-md:gap-0.5 max-md:px-2 max-md:text-[10px]',
                  collapsed ? 'justify-center px-0' : 'gap-2 px-2',
                  screen === n.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className={cn('truncate', collapsed && 'md:hidden')}>{n.label}</span>
                {!collapsed && count != null && (
                  <span className="ml-auto text-xs tabular-nums max-md:hidden">{count}</span>
                )}
              </button>
            );
            return (
              <RailTip key={n.key} collapsed={collapsed} label={count != null ? `${n.label} · ${count}` : n.label}>
                {btn}
              </RailTip>
            );
          })}
        </nav>

        {running.length > 0 && (
          <div className={cn(collapsed ? 'mt-4 px-2' : 'mt-5 px-2', 'max-md:hidden')}>
            {!collapsed && (
              <div className="px-2 caption">Running</div>
            )}
            <div className={collapsed ? 'flex flex-col items-center gap-1' : 'mt-1 space-y-1'}>
              {running.map((r) => {
                const btn = (
                  <button
                    type="button"
                    onClick={() => onOpenRunning(r)}
                    className={cn(
                      'rounded transition-colors hover:bg-muted/60',
                      collapsed ? 'flex justify-center p-2' : 'block w-full px-2 py-1.5 text-left',
                    )}
                  >
                    {collapsed ? (
                      <span className="size-2 animate-pulse rounded-full bg-success" />
                    ) : (
                      // Time on its own line: beside the id it left the narrow rail room for ~4 characters.
                      <div className="flex items-center gap-2" title={r.taskId}>
                        <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-mono text-xs font-medium">{r.taskId}</span>
                          <span className="text-[11px] tabular-nums text-muted-foreground">{relTime(r.lastActivityMs)}</span>
                        </span>
                      </div>
                    )}
                  </button>
                );
                return (
                  <RailTip key={r.taskId} collapsed={collapsed} label={`${r.taskId} · ${relTime(r.lastActivityMs)}`}>
                    {btn}
                  </RailTip>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-auto p-2 pt-3 max-md:hidden">
          <RailTip collapsed={collapsed} label="Expand sidebar">
            <Collapsible.Trigger
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn(
                'flex w-full items-center rounded py-1.5 text-sm font-normal text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                collapsed ? 'justify-center px-0' : 'justify-start gap-2 px-2',
              )}
            >
              <PanelLeft className="size-4 shrink-0" />
              {!collapsed && <span>Collapse</span>}
            </Collapsible.Trigger>
          </RailTip>
        </div>
      </Tooltip.Provider>
    </Collapsible.Root>
  );
}
