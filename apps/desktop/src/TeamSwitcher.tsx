import type { ReactElement } from 'react';
import type { Team } from './wire';

/**
 * The team at the top of the rail: a menu with more than one team, the plain name with one. Collapsed
 * (icon-only rail) it is the team's initial, which expands the rail.
 */
export function TeamSwitcher({
  teams,
  active,
  onSelect,
  collapsed,
  onExpand,
}: {
  teams: Team[];
  active: Team | undefined;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onExpand: () => void;
}): ReactElement | null {
  if (!active) return null;
  if (collapsed) {
    return (
      <button
        type="button"
        aria-label={`Team ${active.name}`}
        title={active.name}
        onClick={onExpand}
        className="flex h-9 w-full items-center justify-center rounded text-sm font-semibold hover:bg-muted/60"
      >
        {active.name.charAt(0).toUpperCase()}
      </button>
    );
  }
  if (teams.length < 2) {
    return (
      <div className="truncate px-2 py-1 text-sm font-semibold" title={active.name}>
        {active.name}
      </div>
    );
  }
  return (
    <select
      aria-label="Team"
      value={active.id}
      onChange={(e) => onSelect(e.target.value)}
      className="h-9 w-full min-w-0 rounded border border-border bg-background px-2 text-sm font-semibold"
    >
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
