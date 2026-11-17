import { Fragment, type ReactNode } from 'react';
import { Breadcrumb, InlineEdit, Logo, ThemeToggle, type Theme } from '@/ui';
import { Search } from 'lucide-react';

export interface Crumb {
  label: string;
  onClick?: () => void;
  /** Renders the crumb as a click-to-rename InlineEdit (task-page dogfood r3: the trailing
   * breadcrumb names the open conversation). Wins over onClick. */
  edit?: { placeholder: string; ariaLabel: string; onCommit: (value: string) => void };
}

export function TopBar({
  nav,
  team,
  switchers,
  crumbs,
  onHome,
  onCommandK,
  theme,
  onToggleTheme,
  onSignOut,
}: {
  /** The main navigation (MainNav): inline here, a tab bar at the bottom on a phone. */
  nav?: ReactNode;
  /** The workspace: the team, next to the brand. */
  team?: ReactNode;
  /** The server switcher, before the search button. */
  switchers?: ReactNode;
  crumbs: Crumb[];
  onHome: () => void;
  onCommandK: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Server mode only (a signed-in hub session): ends the session. */
  onSignOut?: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5 max-md:gap-2 max-md:px-3">
      {/* Logo + wordmark is the home affordance — clicking returns to the dashboard. */}
      <button
        onClick={onHome}
        className="flex items-center gap-2 rounded transition-colors hover:opacity-80"
        aria-label="Taskcell Hub — home"
        title="Back to dashboard"
      >
        <Logo className="size-5" />
        <span className="font-heading font-bold tracking-tight max-md:hidden">Taskcell Hub</span>
      </button>
      {team}
      {nav}
      {crumbs.length > 0 && (
        <>
          <span className="text-border max-md:hidden">|</span>
          <Breadcrumb.Root className="min-w-0">
            <Breadcrumb.List>
              {crumbs.map((c, i) => (
                <Fragment key={i}>
                  {i > 0 && <Breadcrumb.Separator />}
                  <Breadcrumb.Item>
                    {c.edit ? (
                      <Breadcrumb.Page>
                        <InlineEdit
                          value={c.label}
                          placeholder={c.edit.placeholder}
                          ariaLabel={c.edit.ariaLabel}
                          onCommit={c.edit.onCommit}
                        />
                      </Breadcrumb.Page>
                    ) : c.onClick && i < crumbs.length - 1 ? (
                      <Breadcrumb.Link onClick={c.onClick} className="cursor-pointer">
                        {c.label}
                      </Breadcrumb.Link>
                    ) : (
                      <Breadcrumb.Page>{c.label}</Breadcrumb.Page>
                    )}
                  </Breadcrumb.Item>
                </Fragment>
              ))}
            </Breadcrumb.List>
          </Breadcrumb.Root>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {switchers}
        <button
          // Not every browser focuses a clicked button; the palette returns focus to whatever had it.
          onClick={(e) => {
            e.currentTarget.focus();
            onCommandK();
          }}
          aria-label="Search / command palette"
          className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          <Search className="size-3.5" />
          <span className="font-mono max-md:hidden">⌘K</span>
        </button>
        <ThemeToggle theme={theme} onClick={onToggleTheme} />
        {onSignOut && (
          <button onClick={onSignOut} className="rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted">
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
