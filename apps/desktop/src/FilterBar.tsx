import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input, cn } from '@/ui';
import { ListFilter, Search, X } from 'lucide-react';
import { GROUPINGS, SOURCES, TRIAGES, type CardSource, type Grouping, type HubFilter, type Triage } from './filterState';

interface Repo {
  path: string;
  name: string;
}

/** A filter toggle. On is ink on a well, never orange: orange means "needs you". */
export const pill = (on: boolean): string =>
  cn('rounded px-2 py-1 text-xs transition-colors', on ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted');

/** Up to this many projects, each is a tab; past it, the rest are behind "More…". */
export const MAX_PROJECT_TABS = 6;

/** A searchable multi-select that stays usable with many repositories: the list scrolls and filters as you type.
 * `lit` marks the trigger as the selection when no tab is. */
function ProjectPicker({ repos, withCards, selected, onChange, triggerLabel, lit }: { repos: Repo[]; withCards: string[]; selected: string[]; onChange: (paths: string[]) => void; triggerLabel: string; lit: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Escape closes the popup and hands focus back to its button. One Escape closes one layer: a layer above that
  // took the key (defaultPrevented) keeps it, and this one stops it before an enclosing layer's listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    // A press outside the picker (a card, the board) closes it, as any popover does.
    const onDown = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  const shown = repos.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  // An empty selection means every project (all boxes show checked). Picking every project, or unpicking the
  // last one, goes back to that, so the board is never filtered down to nothing.
  const all = selected.length === 0;
  const isOn = (path: string): boolean => all || selected.includes(path);
  const set = (paths: string[]): void => onChange(paths.length === 0 || repos.every((r) => paths.includes(r.path)) ? [] : paths);
  const toggle = (path: string): void => {
    const on = all ? repos.map((r) => r.path) : selected;
    set(on.includes(path) ? on.filter((p) => p !== path) : [...on, path]);
  };
  return (
    <div ref={box} className="relative shrink-0">
      <button ref={trigger} type="button" aria-expanded={open} aria-label={`Projects: ${triggerLabel}`} onClick={() => setOpen(!open)} className={cn('-mb-px border-b-2 px-2 py-1 text-xs transition-colors', lit ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
        {triggerLabel}
      </button>
      {open && (
        <div role="group" aria-label="Projects" className="absolute right-0 top-full z-50 mt-1 w-64 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-background p-2 shadow-md">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" aria-label="Search projects" startAdornment={<Search className="size-4" />} />
          <div className="mt-2 flex gap-2 text-xs">
            <button type="button" className="underline" onClick={() => set(repos.filter((r) => withCards.includes(r.path)).map((r) => r.path))}>
              Has cards
            </button>
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-2 border-b border-border px-1 pb-1.5 text-sm font-medium">
            <input type="checkbox" checked={all} disabled={all} onChange={() => onChange([])} />
            All projects
          </label>
          <ul className="mt-1 max-h-60 overflow-y-auto">
            {shown.map((r) => (
              <li key={r.path} className="group flex items-center rounded hover:bg-muted">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 py-0.5 text-sm">
                  <input type="checkbox" checked={isOn(r.path)} onChange={() => toggle(r.path)} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </label>
                {/* "Only": the one-click way to narrow to a single project (Datadog/Grafana pattern). */}
                <button
                  type="button"
                  aria-label={`Only ${r.name}`}
                  onClick={() => set([r.path])}
                  className="px-1 text-xs text-foreground underline-offset-2 opacity-0 hover:underline focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
                >
                  Only
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-1 py-1 text-sm text-muted-foreground">{q.trim() === '' ? 'No projects' : 'No projects match.'}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "All · alpha · beta": the one project control, as tabs over the Projects filter (`filter.repos`, no second source
 * of truth). A tab is the filter narrowed to that one project. Up to MAX_PROJECT_TABS projects each get a tab; past
 * that, the picked and busy ones do, and "More…" opens the searchable multi-select over all of them, so 70
 * repositories do not make 70 tabs. Several picked light no tab: the chip or the More trigger says what is.
 */
function ProjectTabs({ repos, withCards, selected, onChange }: { repos: Repo[]; withCards: string[]; selected: string[]; onChange: (paths: string[]) => void }) {
  const overflow = repos.length > MAX_PROJECT_TABS;
  const tabs = overflow
    ? [...repos.filter((r) => selected.includes(r.path)), ...repos.filter((r) => !selected.includes(r.path) && withCards.includes(r.path))].slice(0, MAX_PROJECT_TABS)
    : repos;
  const tab = (key: string, label: string, on: boolean, paths: string[]) => (
    <button key={key} type="button" role="tab" aria-selected={on} onClick={() => onChange(paths)} className={cn('-mb-px shrink-0 border-b-2 px-2 py-1 text-xs transition-colors', on ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
      {label}
    </button>
  );
  // Several picked in Projects: no tab is the selection, and the chip says what is (the same filter, read back).
  const several = selected.length > 1;
  return (
    <div className="flex basis-full items-end gap-2 border-b border-border">
      <div role="tablist" aria-label="Project tabs" className="flex min-w-0 gap-1 overflow-x-auto">
        {tab('all', 'All', selected.length === 0, [])}
        {tabs.map((r) => tab(r.path, r.name, selected.length === 1 && selected[0] === r.path, [r.path]))}
      </div>
      {several && !overflow && (
        <span data-testid="tabs-several" title="Picked in Projects. A tab narrows to one project; All shows every one." className="mb-1 shrink-0 rounded border border-foreground px-1.5 py-0.5 text-xs font-medium">
          {selected.length} projects
        </span>
      )}
      {overflow && (() => {
        // The trigger is the selection when no tab is: several picked, or one that has no tab.
        const lit = several || (selected.length === 1 && !tabs.some((r) => r.path === selected[0]));
        const label = several ? `${selected.length} projects` : lit ? (repos.find((r) => r.path === selected[0])?.name ?? '1 project') : 'More…';
        return <ProjectPicker repos={repos} withCards={withCards} selected={selected} onChange={onChange} triggerLabel={label} lit={lit} />;
      })()}
    </div>
  );
}

/** Card source and grouping: everything the phone folds into its Filters drawer. Projects are the tabs above. */
function SecondaryControls({ filter, onChange, sources }: Props) {
  const toggleSource = (s: CardSource): void =>
    onChange({ ...filter, sources: filter.sources.includes(s) ? filter.sources.filter((x) => x !== s) : [...filter.sources, s] });
  return (
    <>
      {sources.length === 1 && <span className="text-xs text-muted-foreground">Source: {SOURCES.find((s) => s.value === sources[0])?.label}</span>}
      {sources.length > 1 && (
      <div role="group" aria-label="Card source" className="flex flex-wrap gap-1">
        {SOURCES.filter((s) => sources.includes(s.value)).map((s) => (
          <button key={s.value} type="button" aria-pressed={filter.sources.includes(s.value)} onClick={() => toggleSource(s.value)} className={pill(filter.sources.includes(s.value))}>
            {s.label}
          </button>
        ))}
      </div>
      )}
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        Group by
        <select aria-label="Group by" value={filter.group} onChange={(e) => onChange({ ...filter, group: e.target.value as Grouping })} className="rounded border border-border bg-background px-1 py-1 text-xs text-foreground">
          {GROUPINGS.filter((g) => g.value !== 'source' || sources.length > 1).map((g) => (
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
  /** Card sources on offer here (see `offeredSources`): chips only when there is a choice, a plain label for one. */
  sources: CardSource[];
  /** What the search box is called (its label and placeholder). */
  searchLabel?: string;
  /** The search box's tooltip: what it matches here and on the other screen that shares it. */
  searchHint?: string;
  /** The screen's own controls, in the same row after search (Runs: All results / Passed / Failed). */
  children?: ReactNode;
}

/** A list filtered to empty: names the search that did it (it is shared by Board and Runs and survives a reload) with a way to clear it.
 * `query` is the search only when clearing it would bring rows back; empty when another filter empties the list:
 * then `names` says which filters are on, and `onClearFilters` (given when it would change something) resets them. */
export function NoMatch({
  what,
  query,
  onClear,
  names = [],
  onClearFilters,
}: {
  what: string;
  query: string;
  onClear?: (() => void) | undefined;
  names?: string[];
  onClearFilters?: (() => void) | undefined;
}) {
  const q = query.trim();
  return (
    <div className="py-8 text-center text-sm text-muted-foreground">
      {q === '' ? `No ${what} match the current filters.` : `No ${what} match the search "${q}".`}
      {q === '' && names.length > 0 && <span> Active: {names.join(', ')}.</span>}
      {q !== '' && onClear && (
        <Button variant="text" color="secondary" className="ml-2" onClick={onClear}>
          Clear search
        </Button>
      )}
      {q === '' && onClearFilters && (
        <Button variant="text" color="secondary" className="ml-2" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/** The one filter bar Board and Runs share. On a phone only triage and search stay; the rest opens in a Filters drawer. */
export function FilterBar(props: Props) {
  const { filter, onChange, searchLabel = 'Search title, #issue or id', searchHint = 'Matches a title, #issue, id or label. Runs shares this search.' } = props;
  const [drawer, setDrawer] = useState(false);
  // Escape closes the sheet. On `window`, after the Projects popup's `document` listener: an open popup takes the key first.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);
  const active = (filter.sources.length > 0 ? 1 : 0) + (filter.group !== 'none' ? 1 : 0);
  return (
    <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2" role="search" aria-label="Filters">
      {props.repos.length > 1 && <ProjectTabs repos={props.repos} withCards={props.withCards} selected={filter.repos} onChange={(r) => onChange({ ...filter, repos: r })} />}
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
        title={searchHint}
        className="w-56 max-md:w-full"
      />
      <div className="flex flex-wrap items-center gap-2 max-md:hidden">
        <SecondaryControls {...props} />
      </div>
      {props.children}
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
