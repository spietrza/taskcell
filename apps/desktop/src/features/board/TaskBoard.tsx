import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, ErrorNote, LINK_CLASS, cn } from '@/ui';
import { FilePlus } from 'lucide-react';
import { listTasksAll } from '../../ipc';
import { hub, RECONNECT_READ_MIN_MS } from '../../transport';
import { inRepos } from '../../repoFilter';
import { isNoTaskSource, RepoFailures, RepoLabel, TaskSourceHint } from '../../RepoViews';
import type { BoardTask, CardPlace, RepoReadFailure, RepoStamp } from '../../wire';
import { useAsync, usePhone } from '../../hooks';
import { setUrlParam, urlParam } from '../../screenUrl';
import { publishCards, type PaletteCard } from '../../paletteIndex';
import { ASKED_WORDS, NEEDS_YOU_CHIP } from '../../runLabels';
import { useApproverDecisions } from './useApproverDecisions';
import { decisionForTask, decisionWords } from './approverDecision';
import { CHIP_TONE, QuickView, TRACKER_NAME, type QuickTask } from './QuickView';
import { NewHubTask, ScheduleLines } from './Schedule';
import { FactoryLabelChips, isFactoryLabel } from './factoryLabels';
import { boardCountLabels } from './counts';
import { PausedBanner, PausedLine } from './paused';
import { ExternalLink } from '../../components/ExternalLink';
import { StationMark } from '../../components/StationMark';
import { STATION_SHORT, stationOf } from '../../stations';
import { FilterBar, NoMatch } from '../../FilterBar';
import { DEFAULT_FILTER, canClearFilters, cardKeys, cardSource, clearFilters, effectiveFilter, filterCards, filterNames, groupRows, inRepoScope, offeredSources, saveChange, type CardSource, type HubFilter } from '../../filterState';

// Each column owns a color identity used across its header dot, count pill and card
// hover border. Classes are spelled out (not interpolated) so Tailwind's JIT keeps them — a
// `bg-${accent}-500` template would get purged. Add a row here to add a column.
type Column = {
  key: string;
  label: string;
  dot: string;
  pill: string;
  cardHover: string;
  pulse?: boolean;
  /** Says what the header cannot: why a column holds two stations. */
  title?: string;
};


// The Board's columns are the line's stations (prototype v3): a card sits in the column of `stationOf`. Review and
// PR share one column, since a tracker card does not say whether its pull request exists yet; the card's mark does.
// Its header names both stations ("Review / PR") so it reads as the two that Home and the Line show.
const COLUMNS: Column[] = [
  { key: 'card', label: STATION_SHORT.card, dot: 'bg-muted-foreground', pill: 'bg-muted-foreground/15 text-muted-foreground', cardHover: 'hover:border-muted-foreground' },
  { key: 'spec', label: STATION_SHORT.spec, dot: 'bg-warning', pill: 'bg-warning/15 text-warning-text', cardHover: 'hover:border-warning' },
  { key: 'cell', label: STATION_SHORT.cell, dot: 'bg-foreground', pill: 'bg-foreground text-background', cardHover: 'hover:border-foreground', pulse: true },
  { key: 'gates', label: STATION_SHORT.gates, dot: 'bg-foreground/80', pill: 'bg-foreground/10 text-foreground', cardHover: 'hover:border-foreground' },
  { key: 'review', label: `${STATION_SHORT.review} / ${STATION_SHORT.pr}`, title: 'Two stations in one column: a tracker card does not say whether its pull request is open yet. Each card\'s stage mark shows which one it is at.', dot: 'bg-foreground/60', pill: 'bg-foreground/10 text-foreground', cardHover: 'hover:border-foreground/60' },
  { key: 'done', label: 'Done', dot: 'bg-success', pill: 'bg-success/15 text-success-text', cardHover: 'hover:border-success' },
];

/** The Board column of a station index (the card's `view.place.at`; 6 is past the line). */
const COLUMN_OF_STATION = ['card', 'spec', 'cell', 'gates', 'review', 'review', 'done'] as const;
/** The card's place: the hub's answer (every view places a card the same way), by its column alone when a hub sent none. */
const placeOf = (t: BoardTask): CardPlace => t.view?.place ?? stationOf(t);
export const boardColumn = (t: BoardTask): string => COLUMN_OF_STATION[placeOf(t).at] ?? 'done';

/** How often an open hub board re-reads its tasks: their statuses change in the hub's store, not here. */
const HUB_POLL_MS = 5000;
/** How often a tracker board (GitHub, GitLab, Linear) and the all-repositories view re-read theirs: slower, to spare the trackers' rate limits. */
const TRACKER_POLL_MS = 20000;

/** One repository's board, or every repository's (cards stamped with their repository). */
type BoardList = { tasks: (BoardTask & Partial<RepoStamp>)[]; capped: boolean; failures: RepoReadFailure[]; hubBoard?: true; hubBoards?: string[] };

/** A poll of every repository, keeping the shown cards (and hub-board flag) of each repository it could not read. */
function keepUnread(shown: BoardList | null, next: BoardList): BoardList {
  const unread = new Set(next.failures.map((f) => f.repoPath));
  if (shown === null || unread.size === 0) return next;
  const kept = (path: string | undefined): boolean => path !== undefined && unread.has(path);
  return {
    ...next,
    tasks: [...next.tasks, ...shown.tasks.filter((t) => kept(t.repoPath))],
    hubBoards: [...(next.hubBoards ?? []), ...(shown.hubBoards ?? []).filter(kept)],
  };
}

export function TaskBoard({
  project,
  allRepos = false,
  repos,
  teamId,
  filter: savedFilter = DEFAULT_FILTER,
  onFilter,
  projects = [],
  configured = [],
  onOpenTask,
  onNewTask,
  onOpenSettings,
  onStartRun,
  onOpenRun,
  onOpenSkills,
  openCard,
}: {
  project: string;
  /** "All repositories": list every repository's cards, each naming its repository. */
  allRepos?: boolean;
  /** The selected team's repositories: "All repositories" lists only these. */
  repos: string[];
  /** The selected team (hub): "All repositories" is read for it. */
  teamId?: string;
  /** The filter Board and Runs share; the bar shows when `onFilter` is given. */
  filter?: HubFilter;
  onFilter?: (f: HubFilter) => void;
  /** Repositories the Projects picker offers (hub: all of the team's). */
  projects?: { path: string; name: string }[];
  /** Card sources the projects in view are configured for; the Source filter offers these plus any a card has. */
  configured?: CardSource[];
  onOpenTask: (taskId: string, repoPath?: string, skills?: string[]) => void;
  onNewTask: () => void;
  /** Opens `project`'s Settings, for the "no task source yet" hint. */
  onOpenSettings?: () => void;
  /** Opens the run form for a card of `project` (the quick view's Start run). */
  onStartRun?: (taskId: string, skills?: string[]) => void;
  /** Opens a running or claimed card's live run (the quick view's Open the run). */
  onOpenRun?: (taskId: string, repoPath: string | undefined) => void;
  /** Opens Settings → Skills. */
  onOpenSkills?: () => void;
  /** A card ⌘K picked while the Board is open (a fresh object per pick); on mount the address names it instead. */
  openCard?: PaletteCard;
}) {
  const [reloads, setReloads] = useState(0);
  const reposKey = repos.join('\n');
  const read = (): Promise<BoardList> =>
    allRepos ? listTasksAll(teamId).then((l) => ({ ...l, tasks: inRepos(l.tasks, repos), failures: inRepos(l.failures, repos) })) : hub().call('list_tasks', { repoPath: project }).then((r) => ({ ...r, failures: [] }));
  const { data: loaded, error, loading } = useAsync(read, [project, allRepos, teamId, reposKey, reloads]);
  // Every board is live-read quietly, one read at a time, polling while the window is visible, so a card follows its task without
  // a reload: a hub board fast, a tracker board and the all-repositories view slower. A fresh load supersedes the last
  // poll. A failed poll keeps the cards on screen (nothing unmounts, a typed draft survives), marks them stale and is
  // tried again on the next interval. So is a repository the all-repositories poll could not read: its last good cards
  // stay until a user action or a successful read of it drops them.
  const [polled, setPolled] = useState<BoardList | null>(null);
  const [stale, setStale] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => { setPolled(null); setStale(false); }, [loaded]);
  const data = polled ?? loaded;
  const shownRef = useRef(data);
  shownRef.current = data;
  const polling = data !== null;
  const pollMs = !allRepos && data?.hubBoard === true ? HUB_POLL_MS : TRACKER_POLL_MS;
  useEffect(() => {
    if (!polling) return;
    // The first read is the load's own; a stream gap or a reconnect re-reads at once.
    return hub().liveRead(read, {
      initial: false,
      pollMs,
      // A tracker board and the all-repositories view read a forge: a flapping stream must not repeat that at once.
      reconnectMinMs: allRepos || data?.hubBoard !== true ? RECONNECT_READ_MIN_MS : undefined,
      shouldPoll: () => !document.hidden,
      // Only a hub board follows file changes; a tracker board and the all-repositories view keep their slower poll (they read a forge).
      changed: (path) => !allRepos && shownRef.current?.hubBoard === true && path === project,
      onData: (r) => {
        setPolled(keepUnread(shownRef.current, r));
        setStale(r.failures.some((f) => !isNoTaskSource(f.error)));
      },
      onError: () => setStale(true),
    }).stop;
    // `read` changes only with these deps, as for the load above.
  }, [polling, pollMs, project, allRepos, teamId, reposKey, reloads]);
  const approver = useApproverDecisions(project, !allRepos);
  // Skills saved from a card's quick view, shown at once: the tracker is not re-read for it.
  const [savedSkills, setSavedSkills] = useState<Record<string, string[]>>({});
  const cardKey = (t: Pick<QuickTask, 'id' | 'repoPath'>): string => `${t.repoPath ?? ''}:${t.id}`;
  const allTasks = data?.tasks.map((t): BoardList['tasks'][number] => {
    const saved = savedSkills[cardKey(t)];
    if (saved === undefined) return t;
    const { skills: _old, ...rest } = t;
    return saved.length > 0 ? { ...rest, skills: saved } : rest;
  });
  const offered = allTasks && offeredSources(configured, inRepoScope(allTasks, savedFilter.repos).map(cardSource));
  const filter = effectiveFilter(savedFilter, offered);
  const tasks = allTasks && filterCards(allTasks, filter);
  const lanes = groupRows(tasks ?? [], filter.group, cardKeys);
  // A hub-board project's cards are made here, not in a tracker.
  const hubBoard = allRepos ? data?.hubBoards?.includes(project) === true : data?.hubBoard === true;
  // A reload re-reads the tracker, so the locally shown skills are dropped with it.
  const reload = (): void => { setSavedSkills({}); setReloads((n) => n + 1); };

  const phone = usePhone();
  const [stage, setStage] = useState('all');
  const stageRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stageRowRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [stage, phone]);

  // The quick view opens beside the Board; Escape or a click outside closes it and focus returns to the card.
  const [selected, setSelected] = useState<QuickTask | null>(null);
  // The open quick view follows a reload: it shows the card as the board now has it, not the snapshot that was clicked.
  const shown = selected === null ? null : (allTasks?.find((t) => t.id === selected.id && t.repoPath === selected.repoPath) ?? selected);
  const panelRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const close = (): void => {
    setSelected(null);
    cardRef.current?.focus();
  };
  // A card of another repository must not linger when the project (or "all repositories") changes.
  useEffect(() => setSelected(null), [project, allRepos]);
  // `?screen=board&card=<id>` opens that card once the board has it; from then on the address follows the open card.
  const linkedId = urlParam('card');
  // The card a link (or ⌘K) opened: it stays open though the filter hides it, with a note that says so.
  const linkedOpen = useRef<QuickTask | null>(null);
  const linked = useRef<{ id: string; repoPath?: string } | null>(linkedId === null ? null : { id: linkedId });
  const [linkNonce, setLinkNonce] = useState(0);
  const seenOpenCard = useRef(openCard);
  useEffect(() => {
    if (openCard === undefined || openCard === seenOpenCard.current) return;
    seenOpenCard.current = openCard;
    linked.current = openCard;
    setLinkNonce((n) => n + 1);
  }, [openCard]);
  useEffect(() => {
    const want = linked.current;
    if (want === null || !allTasks) return;
    const t = allTasks.find((x) => x.id === want.id && (want.repoPath === undefined || (x.repoPath ?? project) === want.repoPath));
    linked.current = null;
    if (!t) return;
    // The panel does not need the filter: a linked card opens even when a saved filter hides it on the board.
    linkedOpen.current = t;
    setSelected(t);
  }, [allTasks, linkNonce]);
  // ⌘K searches the cards this board last loaded.
  useEffect(() => {
    if (data) publishCards(data.tasks.map((t) => ({ id: t.id, title: t.title, repoPath: t.repoPath ?? project })));
  }, [data, project]);
  useEffect(() => {
    if (linked.current === null) setUrlParam('card', selected?.id ?? null);
  }, [selected]);
  // Leaving the Board (a card's full page, another screen) leaves its card behind: coming back shows the board.
  useEffect(() => () => setUrlParam('card', null), []);
  // Nor may a card the filter now hides (unless a link opened it).
  const hiddenOpen = selected !== null && tasks !== undefined && !tasks.some((t) => t.id === selected.id && t.repoPath === selected.repoPath);
  useEffect(() => {
    if (hiddenOpen && selected !== linkedOpen.current) setSelected(null);
  }, [hiddenOpen, selected]);
  useEffect(() => {
    if (selected === null) return;
    panelRef.current?.focus();
    // A reply being typed is not thrown away by a stray Escape or click.
    const typing = (): boolean => (panelRef.current?.querySelector('textarea')?.value ?? '') !== '';
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !typing()) close();
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || typing()) return;
      // Another card re-targets the panel; its own click handler opens it.
      if (target instanceof Element && target.closest('[data-board-card]')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [selected]);

  // Capped comes from the response now (S9) — no more synced literal; the core fetch cap decides.
  const capped = data?.capped === true;
  const counts = boardCountLabels(data);

  // The board is where work starts (S10): authoring a task lives one click away even when the
  // list itself failed to load.
  const bar = onFilter && (
    <FilterBar filter={filter} onChange={(f) => onFilter(saveChange(f, filter, savedFilter))} sources={offered ?? configured} repos={allRepos ? projects : []} withCards={[...new Set((allTasks ?? []).flatMap((t) => (t.repoPath ? [t.repoPath] : [])))]} />
  );
  const header = (
    <>
    <div className="mb-2 flex shrink-0 items-center">
      {stale && (
        <span role="status" className="mr-3 text-xs text-muted-foreground" title="The last refresh failed; the board retries on its own.">
          Not refreshed — retrying
        </span>
      )}
      {counts !== null && (
        // A capped list is one page, so the numbers are lower bounds — `Running 3+ · Queued 12+`.
        <span className="text-xs tabular-nums text-muted-foreground">
          {`Running ${counts.running} · Queued ${counts.queued} · Waiting for you ${counts.needsYou}`}
        </span>
      )}
      <Button className="ml-auto" onClick={hubBoard ? () => setAdding((a) => !a) : onNewTask} startIcon={<FilePlus className="size-4" />} aria-expanded={hubBoard ? adding : undefined}>
        New card
      </Button>
    </div>
    {/* A hub board authors cards inline, but only on demand: an always-open form pushed the board down. */}
    {hubBoard && adding && <NewHubTask repoPath={project} onCreated={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />}
    {bar}
    {hiddenOpen && selected !== null && (
      <p role="status" className="text-xs text-muted-foreground">
        {selected.id} is hidden by your filters
        {/* The project tab counts: it is what usually hides a card opened from Home or a link (as on Runs). */}
        {onFilter && (canClearFilters(filter) || filter.repos.length > 0) && (
          <>
            {' — '}
            <button type="button" className={LINK_CLASS} onClick={() => onFilter({ ...clearFilters(filter), repos: [] })}>Clear</button>
          </>
        )}
      </p>
    )}
    </>
  );

  if (loading) return <div className="text-sm text-muted-foreground">Loading cards…</div>;
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {isNoTaskSource(error) ? <TaskSourceHint repoNames={[]} onOpenSettings={onOpenSettings} /> : <ErrorNote
          title="Couldn't load the Board"
          next="This is usually a connection or setup problem: check the card source in Settings and that its credentials are valid, then reload."
          error={error}
        />}
      </div>
    );
  }
  // A repository with no task source chosen is a setup step, not a read failure.
  const unset = (data?.failures ?? []).filter((f) => isNoTaskSource(f.error));
  // Hint only about the repositories in view: those the Projects filter selects, or else the open project.
  // An empty Projects filter means every repository (filterState.ts), so all of them are in view.
  const inView = filter.repos.length > 0 ? filter.repos : allRepos ? repos : [project];
  const hinted = unset.filter((f) => inView.includes(f.repoPath));
  const failed = (data?.failures ?? []).filter((f) => !isNoTaskSource(f.error));

  const boardCard = (t: BoardList['tasks'][number], hover: string): ReactNode => (
                    <Card.Root key={cardKey(t)} className={cn('gap-0 bg-background/80 py-0 shadow-sm transition-all hover:shadow-md', hover)}>
                    <button
                      data-board-card
                      aria-expanded={selected?.id === t.id && selected.repoPath === t.repoPath}
                      onClick={(e) => {
                        cardRef.current = e.currentTarget;
                        setSelected(t);
                      }}
                      className="block w-full rounded-[inherit] text-left focus-visible:-outline-offset-2"
                    >
                        <Card.Content className="space-y-1.5 p-3">
                          <div className="flex min-w-0 items-center gap-x-1.5 font-mono text-[11px] font-medium text-muted-foreground">
                            <span className="shrink-0">{t.id}</span>
                            {allRepos && <RepoLabel name={t.repoName} />}
                          </div>
                          <div className="text-sm leading-snug">{t.title}</div>
                          <StationMark {...placeOf(t)} />
                          <FactoryLabelChips labels={t.factoryLabels} />
                          {t.column === 'running' && t.stage && <div className="font-mono text-[11px]">stage: {t.stage}</div>}
                          {(t.column === 'review' || t.column === 'done') && !!t.chips?.length && (
                            <div className="flex flex-wrap gap-1">
                              {t.chips.map((chip) => <span key={chip.key} className={cn('rounded px-1.5 py-0.5 text-[11px]', Object.hasOwn(CHIP_TONE, chip.tone) ? CHIP_TONE[chip.tone] : 'bg-muted text-muted-foreground')}>{chip.label}</span>)}
                            </div>
                          )}
                          {(() => {
                            const d = decisionForTask(t.id, approver.runs, approver.decisions);
                            return d !== undefined && <div className="text-[11px] text-muted-foreground" data-approver={d.outcome}>{decisionWords(d, approver.mode)}</div>;
                          })()}
                          {t.paused && <PausedLine paused={t.paused} />}
                          {t.skills && (
                            <div className="break-words pt-0.5 text-[11px] text-muted-foreground">skills: {t.skills.join(', ')}</div>
                          )}
                          {t.asked === true ? <div className={cn('inline-block text-[11px]', NEEDS_YOU_CHIP)}>{ASKED_WORDS}</div> : <ScheduleLines task={t} />}
                          {t.baseBranch && (
                            <div className="pt-0.5 font-mono text-[11px] text-muted-foreground">→ {t.baseBranch}</div>
                          )}
                          {/* The tracker's bare open/closed adds nothing the column does not say. */}
                          {t.state && t.state !== t.column && !/^(open|opened|closed)$/i.test(t.state) && !isFactoryLabel(t.state) && t.schedule === undefined && (
                            <div className="pt-0.5 text-[11px] text-muted-foreground">{t.state}</div>
                          )}
                        </Card.Content>
                    </button>
                    {t.source !== undefined && t.url !== undefined && (
                      <div className="px-3 pb-2.5">
                        <ExternalLink href={t.url} label={`Open ${t.id} ${t.title} in ${TRACKER_NAME[t.source]}`}>{`Open in ${TRACKER_NAME[t.source]}`}</ExternalLink>
                      </div>
                    )}
                    </Card.Root>
  );
  // Phone (prototype v3): pick a stage, and the cards stack inside each lane instead of six columns scrolling sideways.
  // The chips scroll sideways under an edge fade (`scroll-cue-x`); the picked one is kept in view.
  const stageRow = phone && (
    <div ref={stageRowRef} role="group" aria-label="Stage" className="scroll-cue-x flex shrink-0 gap-1 overflow-x-auto">
      {[{ key: 'all', label: 'All stages' }, ...COLUMNS].map((c) => {
        const n = c.key === 'all' ? (tasks?.length ?? 0) : (tasks ?? []).filter((t) => boardColumn(t) === c.key).length;
        return (
          <button key={c.key} type="button" aria-pressed={stage === c.key} title={'title' in c ? c.title : undefined} onClick={() => setStage(c.key)} className={cn('shrink-0 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors', stage === c.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {c.label} <span className="tabular-nums opacity-70">{n}</span>
          </button>
        );
      })}
    </div>
  );
  const COLUMN_ORDER = COLUMNS.map((c) => c.key);
  // The desktop's order, left to right: Card first, Done last.
  const phoneRows = (rows: BoardList['tasks']): BoardList['tasks'] =>
    rows.filter((t) => stage === 'all' || boardColumn(t) === stage).sort((x, y) => COLUMN_ORDER.indexOf(boardColumn(x)) - COLUMN_ORDER.indexOf(boardColumn(y)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {hinted.length > 0 && (
        <TaskSourceHint repoNames={hinted.map((f) => f.repoName)} onOpenSettings={hinted.some((f) => f.repoPath === project) ? onOpenSettings : undefined} />
      )}
      <RepoFailures failures={failed} total={repos.length - unset.length} />
      {allTasks?.length === 0 && (data?.failures.length ?? 0) === 0 && !hubBoard && (
        <div className="mb-3 shrink-0 rounded-lg border border-dashed border-border/60 p-4 text-sm">
          <div className="font-medium">No cards yet</div>
          <p className="mt-1 text-muted-foreground">Create a card with acceptance criteria. The factory picks it up and its card moves across this board.</p>
          <Button className="mt-2" onClick={onNewTask}>Create a card</Button>
        </div>
      )}
      <PausedBanner tasks={allTasks ?? []} />
      {capped && (
        <div className="mb-2 shrink-0 text-xs text-muted-foreground">
          {allRepos
            ? 'At least one repository hit the card limit, so some cards are missing — narrow the Projects filter to that repository and use a label filter in Settings.'
            : `Showing the first ${allTasks?.length ?? 0} cards — narrow with a label filter in Settings to see the rest.`}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 gap-3 pb-4">
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-4', (phone || filter.group !== 'none') && 'overflow-y-auto')}>
        {stageRow}
        {/* Ungrouped, the one lane stays (its columns render empty), so "nothing matches" is asked of the cards. */}
        {(allTasks?.length ?? 0) > 0 && tasks?.length === 0 && (
          <NoMatch what="cards" query={filterCards(allTasks ?? [], { ...filter, query: '' }).length > 0 ? filter.query : ''} onClear={onFilter && (() => onFilter(saveChange({ ...filter, query: '' }, filter, savedFilter)))} names={filterNames(filter)} onClearFilters={onFilter && canClearFilters(filter) ? () => onFilter(clearFilters(filter)) : undefined} />
        )}
        {phone ? lanes.map((lane) => {
          const rows = phoneRows(lane.rows);
          return (
            <section key={lane.key} aria-label={lane.label || undefined} className="space-y-2">
              {lane.label && (
                <h3 className="text-sm font-semibold">
                  {lane.label} <span className="font-normal tabular-nums text-muted-foreground">{rows.length}</span>
                </h3>
              )}
              {rows.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">No cards</div>
              ) : (
                rows.map((t) => boardCard(t, COLUMNS.find((c) => c.key === boardColumn(t))?.cardHover ?? ''))
              )}
            </section>
          );
        }) : lanes.map((lane) => (
        <section key={lane.key} aria-label={lane.label || undefined} className={cn('flex min-h-0 flex-col gap-2', filter.group === 'none' ? 'flex-1' : 'h-[28rem] shrink-0')}>
        {lane.label && (
          <h3 className="text-sm font-semibold">
            {lane.label} <span className="font-normal tabular-nums text-muted-foreground">{lane.rows.length}</span>
          </h3>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto">
        {COLUMNS.map((col) => {
          const items = lane.rows.filter((t) => boardColumn(t) === col.key);
          return (
            <div
              key={col.key}
              role="group"
              aria-label={col.label}
              // From xl the six columns share the row (narrowing to 11rem) so all fit at 1440; below it they keep their width and scroll.
              className="flex h-full min-h-0 w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/20 p-2 xl:w-auto xl:min-w-44 xl:max-w-72 xl:flex-1"
            >
              <div className="mb-2 flex shrink-0 items-center gap-2 px-1 py-0.5">
                <span className={cn('size-2 rounded-full', col.dot, col.pulse && items.length > 0 && 'animate-pulse')} />
                <span className="text-sm font-semibold text-foreground" title={col.title}>{col.label}</span>
                <span className={cn('ml-auto rounded-full px-2 py-0.5 text-xs font-medium tabular-nums', items.length > 0 ? col.pill : 'bg-muted-foreground/10 text-muted-foreground')}>
                  {items.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-0.5 pb-0.5">
                {items.length === 0 ? (
                  <div className="mt-2 rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                    No cards
                  </div>
                ) : (
                  items.map((t) => boardCard(t, col.cardHover))
                )}
              </div>
            </div>
          );
        })}
        </div>
        </section>
        ))}
      </div>
      {shown !== null && (
        <QuickView
          ref={panelRef}
          task={shown}
          project={project}
          onClose={close}
          onFullPage={() => onOpenTask(shown.id, shown.repoPath, savedSkills[cardKey(shown)] ?? shown.skills)}
          onSkillsSaved={(skills) => setSavedSkills((m) => ({ ...m, [cardKey(shown)]: skills }))}
          onChanged={reload}
          {...(onStartRun && (shown.repoPath === undefined || shown.repoPath === project) ? { onStartRun: () => { onStartRun(shown.id, savedSkills[cardKey(shown)] ?? shown.skills); close(); } } : {})}
          {...(onOpenRun ? { onOpenRuns: () => onOpenRun(shown.id, shown.repoPath) } : {})}
          {...(onOpenSkills ? { onOpenSkills } : {})}
        />
      )}
      </div>
    </div>
  );
}
