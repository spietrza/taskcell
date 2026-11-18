import { ChevronDown, Home as HomeIcon, List, Columns3, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { Menu, cn } from '@/ui';
import { SETTINGS_SECTIONS, type SettingsSection } from './features/settings/sections';

// 'task' (S10) is reached by intent — the New Task button on the board and Runs toolbars — so it
// has no NAV entry; the breadcrumb is its location anchor. Needs you lives on Home; Line, Runners
// and Audit live under Settings.
export type Screen = 'home' | 'runs' | 'board' | 'task' | 'settings';

export const NAV: { key: Exclude<Screen, 'task'>; label: string; icon: LucideIcon }[] = [
  { key: 'home', label: 'Home', icon: HomeIcon },
  { key: 'board', label: 'Board', icon: Columns3 },
  { key: 'runs', label: 'Runs', icon: List },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

const ITEM =
  'flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 max-md:flex-1 max-md:flex-col max-md:justify-center max-md:gap-0.5 max-md:px-1 max-md:text-[10px]';
const itemClass = (current: boolean): string =>
  cn(ITEM, current ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground');

/**
 * The one main navigation: inline in the top bar, a tab bar pinned to the bottom below `md`. Board, Runs and
 * Settings are a project's screens, so they are disabled with none; Settings opens a menu of its sections.
 */
export function MainNav({
  screen,
  needsCount = 0,
  hasProject,
  onScreen,
  onSettings,
}: {
  screen: Screen;
  /** What waits on the user (Home's Waiting for you section); badges Home. */
  needsCount?: number;
  hasProject: boolean;
  onScreen: (s: Exclude<Screen, 'task' | 'settings'>) => void;
  onSettings: (section: SettingsSection) => void;
}) {
  return (
    <nav
      aria-label="Main"
      className="flex items-center gap-1 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:gap-0 max-md:border-t max-md:border-border max-md:bg-background max-md:px-1 max-md:pb-[env(safe-area-inset-bottom)]"
    >
      {NAV.map(({ key, label, icon: Icon }) => {
        const body = (
          <>
            <Icon className="size-4 shrink-0" />
            <span>{label}</span>
            {key === 'home' && needsCount > 0 && (
              <span className="rounded-sm bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground max-md:absolute max-md:right-2 max-md:top-0.5">
                {needsCount}
              </span>
            )}
            {key === 'settings' && <ChevronDown className="size-3 shrink-0 max-md:hidden" />}
          </>
        );
        if (key === 'settings') {
          return (
            <Menu.Root key={key}>
              <Menu.Trigger disabled={!hasProject} aria-current={screen === 'settings' ? 'page' : undefined} className={itemClass(screen === 'settings')}>
                {body}
              </Menu.Trigger>
              <Menu.Content side="bottom" align="start">
                {SETTINGS_SECTIONS.map((s) => (
                  <Menu.Item key={s.key} onClick={() => onSettings(s.key)}>
                    {s.label}
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Root>
          );
        }
        return (
          <button
            key={key}
            type="button"
            onClick={() => onScreen(key)}
            disabled={key !== 'home' && !hasProject}
            aria-current={screen === key ? 'page' : undefined}
            aria-label={key === 'home' && needsCount > 0 ? `Home, ${needsCount} waiting` : undefined}
            className={cn(itemClass(screen === key), 'relative')}
          >
            {body}
          </button>
        );
      })}
    </nav>
  );
}
