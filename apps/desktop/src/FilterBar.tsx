import { useState } from 'react';
import { Button, Input, cn } from '@/ui';
import { ListFilter, Search, X } from 'lucide-react';
import { GROUPINGS, SOURCES, TRIAGES, type CardSource, type Grouping, type HubFilter, type Triage } from './filterState';

interface Repo {
  path: string;
  name: string;
}

const pill = (on: boolean): string =>
  cn('rounded px-2 py-1 text-xs transition-colors', on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted');

/** A searchable multi-select that stays usable with many repositories: the list scrolls and filters as you type. */
function ProjectPicker({ repos, withCards, selected, onChange }: { repos: Repo[]; withCards: string[]; selected: string[]; onChange: (paths: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const shown = repos.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (path: string): void => onChange(selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path]);
  const label = selected.length === 0 ? 'All projects' : selected.length === 1 ? (repos.find((r) => r.path === selected[0])?.name ?? '1 project') : `${selected.length} projects`;
  return (
    <div className="relative">
      <button type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)} className="rounded border border-border px-2 py-1 text-xs">
        Projects: {label}
      </button>
      {open && (
        <div role="group" aria-label="Projects" className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-background p-2 shadow-md max-md:static max-md:w-full max-md:shadow-none">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" aria-label="Search projects" startAdornment={<Search className="size-4" />} />
          <div className="mt-2 flex gap-2 text-xs">
            <button type="button" className="underline" onClick={() => onChange(repos.filter((r) => withCards.includes(r.path)).map((r) => r.path))}>
              Has cards
            </button>
            <button type="button" className="underline" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <ul className="mt-2 max-h-60 overflow-y-auto">
            {shown.map((r) => (
              <li key={r.path}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted">
                  <input type="checkbox" checked={selected.includes(r.path)} onChange={() => toggle(r.path)} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="px-1 py-1 text-sm text-muted-foreground">No projects</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Projects, card source and grouping: everything the phone folds into its Filters drawer. */
function SecondaryControls({ filter, onChange, repos, withCards }: Props) {
  const toggleSource = (s: CardSource): void =>
    onChange({ ...filter, sources: filter.sources.includes(s) ? filter.sources.filter((x) => x !== s) : [...filter.sources, s] });
  return (
    <>
      {repos.length > 0 && <ProjectPicker repos={repos} withCards={withCards} selected={filter.repos} onChange={(r) => onChange({ ...filter, repos: r })} />}
      <div role="group" aria-label="Card source" className="flex flex-wrap gap-1">
        {SOURCES.map((s) => (
          <button key={s.value} type="button" aria-pressed={filter.sources.includes(s.value)} onClick={() => toggleSource(s.value)} className={pill(filter.sources.includes(s.value))}>
            {s.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        Group by
        <select aria-label="Group by" value={filter.group} onChange={(e) => onChange({ ...filter, group: e.target.value as Grouping })} className="rounded border border-border bg-background px-1 py-1 text-xs text-foreground">
          {GROUPINGS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

interface Props {
  filter: HubFilter;
  onChange: (f: HubFilter) => void;
  /** Repositories the Projects picker offers; none hides the picker (single-repository mode). */
  repos: Repo[];
  /** Paths of repositories that have cards, for the "Has cards" shortcut. */
  withCards: string[];
  /** What the search box matches; Runs have no title, so its list says "Search task id". */
  searchLabel?: string;
}

/** A list filtered to empty: names the search that did it (it is shared by Board and Runs and survives a reload) with a way to clear it. */
export function NoMatch({ what, query, onClear }: { what: string; query: string; onClear?: (() => void) | undefined }) {
  const q = query.trim();
  return (
    <div className="py-8 text-center text-sm text-muted-foreground">
      {q === '' ? `No ${what} match.` : `No ${what} match the search "${q}".`}
      {q !== '' && onClear && (
        <Button variant="text" color="secondary" className="ml-2" onClick={onClear}>
          Clear search
        </Button>
      )}
    </div>
  );
}

/** The one filter bar Board and Runs share. On a phone only triage and search stay; the rest opens in a Filters drawer. */
export function FilterBar(props: Props) {
  const { filter, onChange, searchLabel = 'Search title or id' } = props;
  const [drawer, setDrawer] = useState(false);
  const active = (filter.repos.length > 0 ? 1 : 0) + (filter.sources.length > 0 ? 1 : 0) + (filter.group !== 'none' ? 1 : 0);
  return (
    <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2" role="search" aria-label="Filters">
      <div role="group" aria-label="Triage" className="flex gap-1">
        {TRIAGES.map((t) => (
          <button key={t.value} type="button" aria-pressed={filter.triage === t.value} onClick={() => onChange({ ...filter, triage: t.value as Triage })} className={pill(filter.triage === t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      <Input
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
        startAdornment={<Search className="size-4" />}
        placeholder={`${searchLabel}…`}
        aria-label={searchLabel}
        className="w-56 max-md:w-full"
      />
      <div className="flex flex-wrap items-center gap-2 max-md:hidden">
        <SecondaryControls {...props} />
      </div>
      <Button variant="outlined" className="md:hidden" onClick={() => setDrawer(true)} startIcon={<ListFilter className="size-4" />}>
        {`Filters${active > 0 ? ` (${active})` : ''}`}
      </Button>
      {drawer && (
        <div role="dialog" aria-label="Filters" className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col gap-3 overflow-y-auto rounded-t-xl border border-border bg-background p-4 shadow-lg md:hidden">
          <div className="flex items-center">
            <span className="text-sm font-semibold">Filters</span>
            <button type="button" aria-label="Close filters" className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => setDrawer(false)}>
              <X className="size-4" />
            </button>
          </div>
          <SecondaryControls {...props} />
        </div>
      )}
    </div>
  );
}
