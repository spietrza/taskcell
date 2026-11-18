import { Fragment, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Button, Chip, Empty, Input, LINK_CLASS, Timestamp, cn } from '@/ui';
import { Inbox, RefreshCw, Search } from 'lucide-react';
import { contrastColor } from '../../color';
import { FilterBar, NoMatch, pill } from '../../FilterBar';
import { DEFAULT_FILTER, canClearFilters, clearFilters, effectiveFilter, filterActive, filterNames, filterRuns, groupRows, offeredSources, runKeys, runSource, runTriage, supersededRuns, saveChange, searchText, type RunMeta, type CardSource, type HubFilter } from '../../filterState';
import { ExternalLink, hostName } from '../../components/ExternalLink';
import { costLabel, estTitle } from '../../cost';
import { RunsSplit } from './RunsSplit';
import { StationMark } from '../../components/StationMark';
import { runStationOf, stationOf } from '../../stations';
import { cardIdOf, repoInitials, runStateTone, runStateWord, titleKey } from '../../runLabels';
import type { ActiveRun, RunSummary } from '../../taskcell-output';
import type { RepoStamp } from '../../wire';

type Filter = 'all' | 'passed' | 'failed';
type Run = RunSummary & Partial<RepoStamp>;
type Active = ActiveRun & Partial<RepoStamp>;
/** The Passed / Failed pills read the row's own chip word: a failed verify is failed even when every stage completed. */
const isFailed = (r: RunSummary): boolean => runStateWord(r) === 'failed';
const isPassed = (r: RunSummary): boolean => runStateTone(runStateWord(r)) === 'success';

/** Row keys: what `selected` is compared with. */
export const runKey = (repoPath: string | undefined, taskId: string, timestamp: string): string => `${repoPath ?? ''}:${taskId}:${timestamp}`;
export const activeKey = (repoPath: string | undefined, taskId: string): string => `active:${repoPath ?? ''}:${taskId}`;

// A row of the list: a running run or a finished one, with what grouping needs.
type Item = ({ kind: 'active'; a: Active } | { kind: 'run'; r: Run }) & { taskId: string; repoPath?: string | undefined; repoName?: string | undefined };

/** The runs list: the left side of the Runs split view. A row is the landing's Runs window row: avatar, repository, title and issue, status, age. */
export function RunList({
  runs,
  active,
  showRepo = false,
  hub: savedHub = DEFAULT_FILTER,
  onHub,
  configured = [],
  projects = [],
  onSelect,
  onOpenActive,
  onNewTask,
  selected,
  titles,
  labels,
  pane,
  paneOpen = false,
  starting = false,
  identity,
}: {
  runs: Run[];
  /** In-flight runs discovered from `.taskcell` state, rendered as running rows at the top. */
  active: Active[];
  /** A run launched here is starting (its sealed cell is not up yet): an empty list says so instead of "No runs found". */
  starting?: boolean;
  /** "All repositories": each row names its repository. */
  showRepo?: boolean;
  /** The filter Board and Runs share; its bar shows (and the local search goes) when `onHub` is given. */
  hub?: HubFilter;
  onHub?: (f: HubFilter) => void;
  /** Card sources the projects in view are configured for; the Source filter offers these plus any a run has. */
  configured?: CardSource[];
  /** Repositories the Projects picker offers (hub: all of the team's). */
  projects?: { path: string; name: string }[];
  onSelect: (r: Run) => void;
  onOpenActive: (a: Active) => void;
  /** Where an empty list sends the user: authoring a task, whose runs show here. */
  onNewTask?: () => void;
  /** The open run's row key (`runKey` / `activeKey`): that row is highlighted. */
  selected?: string | undefined;
  /** Task titles by `titleKey`, from the board; a run has none of its own, so a missing one shows the task id. */
  titles?: Map<string, string> | undefined;
  /** Task labels by `titleKey`, from the board; the search matches them. */
  labels?: Map<string, string[]> | undefined;
  /** The open run, shown beside the rows (the Runs split view); `paneOpen` says a run is open (narrow screens then show the pane alone). */
  pane?: ReactNode;
  paneOpen?: boolean;
  /** A row's project, for its avatar: the project's name and colour (`projectColor`). Undefined: initials on a plain well. */
  identity?: ((repoPath: string | undefined) => { name: string; color: string; initials?: string } | undefined) | undefined;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const offered = useMemo(
    () => (runs.length + active.length === 0 ? undefined : offeredSources(configured, [...runs, ...active].map((r) => runSource(r.taskId)))),
    [runs, active, configured],
  );
  const hub = useMemo(() => effectiveFilter(savedHub, offered), [savedHub, offered]);

  // What the search also matches on a row: its board title and labels.
  const meta = useMemo<RunMeta>(
    () => (repoPath, taskId) => {
      const k = titleKey(repoPath, taskId);
      return [titles?.get(k) ?? '', ...(labels?.get(k) ?? [])];
    },
    [titles, labels],
  );
  const matches = (q: string, repoPath: string | undefined, taskId: string): boolean => q === '' || searchText(taskId, meta(repoPath, taskId)).some((s) => s.toLowerCase().includes(q));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return filterRuns(runs, hub, meta).filter((r) => {
      if (!matches(q, r.repoPath, r.taskId)) return false;
      if (filter === 'passed' && !isPassed(r)) return false;
      if (filter === 'failed' && !isFailed(r)) return false;
      return true;
    });
  }, [runs, query, filter, hub, meta]);

  // Running rows have no pass/fail verdict yet, so they only appear under the "all" filter.
  const shownActive = useMemo(() => {
    if (filter !== 'all') return [];
    const q = query.trim().toLowerCase();
    return filterActive(active, hub, meta).filter((a) => matches(q, a.repoPath, a.taskId));
  }, [active, query, filter, hub, meta]);

  // The open run, when the filters hide its row: named, as the Board names a hidden open card.
  const hiddenOpen = useMemo(() => {
    if (!paneOpen || selected === undefined) return undefined;
    if (shown.some((r) => runKey(r.repoPath, r.taskId, r.timestamp) === selected) || shownActive.some((a) => activeKey(a.repoPath, a.taskId) === selected)) return undefined;
    return runs.find((r) => runKey(r.repoPath, r.taskId, r.timestamp) === selected)?.taskId ?? active.find((a) => activeKey(a.repoPath, a.taskId) === selected)?.taskId;
  }, [paneOpen, selected, shown, shownActive, runs, active]);
  const clearAll = (): void => {
    setFilter('all');
    setQuery('');
    onHub?.(clearFilters(hub));
  };

  // Would clearing the search bring rows back, or is it the pill / hub filter that empties the list?
  const searchHides = useMemo(() => {
    const h = { ...hub, query: '' };
    return filterRuns(runs, h, meta).some((r) => filter === 'all' || (filter === 'failed' ? isFailed(r) : isPassed(r))) || (filter === 'all' && filterActive(active, h, meta).length > 0);
  }, [runs, active, filter, hub, meta]);

  const superseded = useMemo(() => supersededRuns(runs), [runs]);
  // Rows of both kinds share the lanes; a running row sorts first within its lane.
  const lanes = useMemo(
    () =>
      groupRows(
        [
          ...shownActive.map((a): Item => ({ kind: 'active', a, taskId: a.taskId, repoPath: a.repoPath, repoName: a.repoName })),
          ...shown.map((r): Item => ({ kind: 'run', r, taskId: r.taskId, repoPath: r.repoPath, repoName: r.repoName })),
        ],
        hub.group,
        { triage: (i) => (i.kind === 'active' ? 'running' : runTriage(i.r, superseded.has(i.r))), source: runKeys.source },
      ),
    [shownActive, shown, hub.group, superseded],
  );

  const row = (key: string, repoName: string | undefined, taskId: string, repoPath: string | undefined, station: { at: number; failed: boolean }, chip: ReactElement, age: ReactElement, open?: () => void, extra?: ReactElement): ReactElement => {
    const title = titles?.get(titleKey(repoPath, taskId));
    const who = identity?.(repoPath);
    const body = (
      <>
        <span
          className={cn('grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-bold', who === undefined && 'bg-muted')}
          style={who && { backgroundColor: who.color, color: contrastColor(who.color) }}
          aria-hidden
        >
          {who?.initials ?? repoInitials(who?.name ?? repoName ?? taskId)}
        </span>
        <span className="min-w-0 flex-1">
          {showRepo && repoName !== undefined && <span className="block truncate text-sm font-medium">{repoName}</span>}
          {/* The card's id first (as the Board and the breadcrumb show it: gh-27, hub-4), so a long title truncates without hiding it. */}
          <span className={cn('flex min-w-0 gap-1.5 text-sm', showRepo ? 'text-muted-foreground' : 'font-medium')}>
            {title !== undefined && <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{cardIdOf(taskId)}</span>}
            <span className="min-w-0 truncate">{title ?? cardIdOf(taskId)}</span>
          </span>
          <StationMark {...station} className="mt-0.5" />
          {extra}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {chip}
          <span className="text-xs tabular-nums text-muted-foreground">{age}</span>
        </span>
      </>
    );
    const rowClass = 'flex w-full items-center gap-3 px-3 py-2.5 text-left';
    return (
      <li key={key} data-testid="run-row" aria-current={selected === key ? 'true' : undefined} className={cn('border-b border-border/60', selected === key && 'bg-muted')}>
        {/* An openable row is a button (Tab, Enter, Space); a CI row holds its own link instead. */}
        {open ? (
          <button type="button" onClick={open} className={cn(rowClass, 'cursor-pointer hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2')}>
            {body}
          </button>
        ) : (
          <div className={rowClass}>{body}</div>
        )}
      </li>
    );
  };
  const activeRow = (a: Active): ReactElement =>
    row(
      activeKey(a.repoPath, a.taskId),
      a.repoName,
      a.taskId,
      a.repoPath,
      // A live run has no stage on its row; it is in the cell until its record says otherwise.
      stationOf({ column: 'running' }),
      // Neutral ink (live, spinning), not green, so a running row isn't mistaken for a "passed" one, and not orange,
      // which means "needs you".
      <Chip color="secondary" variant="outlined">
        <span className="inline-flex items-center gap-1">
          <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          running
        </span>
      </Chip>,
      <Timestamp ms={a.lastActivityMs} />,
      () => onOpenActive(a),
    );
  const runRow = (r: Run): ReactElement => {
    const ci = r.source === 'ci';
    return row(
      runKey(r.repoPath, r.taskId, r.timestamp),
      r.repoName,
      r.taskId,
      r.repoPath,
      runStationOf(r),
      <Chip color={runStateTone(runStateWord(r))} variant="outlined">
        {runStateWord(r)}
      </Chip>,
      <>
        {!ci && <span {...estTitle(costLabel(r))}>{costLabel(r)}</span>}
        {!ci && ' · '}
        <Timestamp ms={Date.parse(r.timestamp)} />
      </>,
      // A CI run has no local record to open: its PR/MR link is the way in.
      ci ? undefined : () => onSelect(r),
      ci ? (
        <span className="flex items-center gap-2 text-xs">
          <Chip color="secondary" variant="outlined">run in CI</Chip>
          <span className="tabular-nums text-muted-foreground" {...estTitle(costLabel(r))}>{costLabel(r)}</span>
          {r.prUrl !== undefined && <ExternalLink href={r.prUrl}>{`Open in ${hostName(r.prUrl)}`}</ExternalLink>}
        </span>
      ) : undefined,
    );
  };

  if (runs.length === 0 && active.length === 0 && starting) {
    return (
      <Empty.Root>
        <Empty.Media>
          <RefreshCw className="animate-spin motion-reduce:animate-none" />
        </Empty.Media>
        <Empty.Title>Starting the run…</Empty.Title>
        <Empty.Description>Taskcell is opening a sealed cell for it. The run shows up here in a moment.</Empty.Description>
      </Empty.Root>
    );
  }
  if (runs.length === 0 && active.length === 0) {
    return (
      <Empty.Root>
        <Empty.Media>
          <Inbox />
        </Empty.Media>
        <Empty.Title>No runs found</Empty.Title>
        <Empty.Description>
          No runs to show here. Create a card and the factory's runs show up on this page.
        </Empty.Description>
        {onNewTask && (
          <Empty.Actions>
            <Button onClick={onNewTask}>Create a card</Button>
          </Empty.Actions>
        )}
      </Empty.Root>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Narrow screens: with a run open the pane has the whole screen, so the filters step aside. */}
      <div className={cn('flex shrink-0 flex-col gap-3', paneOpen && 'max-md:hidden')}>
      {(() => {
        // The verdict pills and the count sit in the filter bar's row, so Runs has one row of filters.
        const results = (
          <>
            <div role="group" aria-label="Result" className="flex gap-1">
              {(['all', 'passed', 'failed'] as Filter[]).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn(pill(filter === f), 'first-letter:uppercase')}>
                  {f === 'all' ? 'All results' : f}
                </button>
              ))}
            </div>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {shown.length + shownActive.length} of {runs.length + (filter === 'all' ? active.length : 0)}{' '}
              {runs.length + (filter === 'all' ? active.length : 0) === 1 ? 'run' : 'runs'}
            </span>
          </>
        );
        return onHub ? (
          <FilterBar filter={hub} onChange={(f) => onHub(saveChange(f, hub, savedHub))} sources={offered ?? configured} searchHint="Matches the row's title, #issue, card id and labels. Board shares this search." repos={projects} withCards={[...new Set([...runs, ...active].flatMap((r) => (r.repoPath ? [r.repoPath] : [])))]}>
            {results}
          </FilterBar>
        ) : (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              startAdornment={<Search className="size-4" />}
              placeholder="Search title, #issue or id…"
              className="w-56"
            />
            {results}
          </div>
        );
      })()}
      {hiddenOpen !== undefined && (
        <p role="status" className="text-xs text-muted-foreground">
          {hiddenOpen} is hidden by your filters
          {' — '}
          {/* Also the project tab: it is what usually hides a run opened from Home or a link. */}
          <button type="button" className={LINK_CLASS} onClick={() => { setFilter('all'); setQuery(''); onHub?.({ ...clearFilters(hub), repos: [] }); }}>Clear</button>
        </p>
      )}
      </div>
      {(() => {
        const rows = (
          shown.length === 0 && shownActive.length === 0 ? (
          <NoMatch
            what="runs"
            query={searchHides ? (onHub ? hub.query : query) : ''}
            onClear={onHub ? () => onHub(saveChange({ ...hub, query: '' }, hub, savedHub)) : () => setQuery('')}
            names={[...filterNames(hub), ...(!onHub && query.trim() !== '' ? [`search "${query.trim()}"`] : []), ...(filter !== 'all' ? [filter === 'passed' ? 'Passed' : 'Failed'] : [])]}
            onClearFilters={
              filter !== 'all' || query.trim() !== '' || (onHub && canClearFilters(hub))
                ? clearAll
                : undefined
            }
          />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto border-t border-border/60" aria-label="Runs">
            {lanes.map((lane) => (
              <Fragment key={lane.key}>
                {hub.group !== 'none' && (
                  <li className="bg-muted/40 px-3 py-1.5 text-sm font-semibold">
                    {lane.label} <span className="font-normal tabular-nums text-muted-foreground">{lane.rows.length}</span>
                  </li>
                )}
                {lane.rows.map((r) => (r.kind === 'active' ? activeRow(r.a) : runRow(r.r)))}
              </Fragment>
            ))}
          </ul>
        )
        );
        return pane === undefined ? rows : <RunsSplit open={paneOpen} list={rows} pane={pane} />;
      })()}
    </div>
  );
}
