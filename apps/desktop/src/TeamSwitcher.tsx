import type { ReactElement } from 'react';
import type { Team } from './wire';

/** The team in the top bar: a menu with more than one team, the plain name with one. */
export function TeamSwitcher({
  teams,
  active,
  onSelect,
}: {
  teams: Team[];
  active: Team | undefined;
  onSelect: (id: string) => void;
}): ReactElement | null {
  if (!active) return null;
  if (teams.length < 2) {
    return (
      <div className="max-w-40 truncate px-2 py-1 text-sm font-semibold max-md:max-w-24" title={active.name}>
        {active.name}
      </div>
    );
  }
  return (
    <select
      aria-label="Team"
      value={active.id}
      onChange={(e) => onSelect(e.target.value)}
      className="h-8 w-full min-w-0 max-w-40 rounded border border-border bg-background px-2 text-sm font-semibold max-md:max-w-24"
    >
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
