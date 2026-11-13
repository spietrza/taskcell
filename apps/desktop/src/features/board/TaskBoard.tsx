import { useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorNote, cn } from '@/ui';
import { FilePlus } from 'lucide-react';
import { listTasks, listTasksAll } from '../../ipc';
import { inRepos } from '../../repoFilter';
import { RepoFailures, RepoLabel } from '../../RepoViews';
import type { BoardTask, RepoReadFailure, RepoStamp } from '../../wire';
import { useAsync } from '../../hooks';
import { useApproverDecisions } from './useApproverDecisions';
import { decisionForTask, decisionWords } from './approverDecision';
import { QuickView, TRACKER_NAME, type QuickTask } from './QuickView';
import { boardCountLabels } from './counts';
import { ExternalLink } from '../../components/ExternalLink';
import { FilterBar } from '../../FilterBar';
import { DEFAULT_FILTER, cardKeys, filterCards, groupRows, type HubFilter } from '../../filterState';

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
};

const CHIP_TONE: Record<string, string> = {
  pass: 'bg-success/15 text-success-text',
  changes: 'bg-warning/15 text-warning-text',
  failed: 'bg-destructive/15 text-destructive-text',
};

const COLUMNS: Column[] = [
  { key: 'queued', label: 'Queued', dot: 'bg-muted-foreground', pill: 'bg-muted-foreground/15 text-muted-foreground', cardHover: 'hover:border-muted-foreground' },
  { key: 'claimed', label: 'Claimed', dot: 'bg-warning', pill: 'bg-warning/15 text-warning-text', cardHover: 'hover:border-warning' },
  { key: 'running', label: 'Running', dot: 'bg-foreground', pill: 'bg-foreground text-background', cardHover: 'hover:border-foreground', pulse: true },
  { key: 'verify-failed', label: 'Verify failed', dot: 'bg-destructive', pill: 'bg-destructive/15 text-destructive-text', cardHover: 'hover:border-destructive' },
  { key: 'review', label: 'Review', dot: 'bg-foreground/60', pill: 'bg-foreground/10 text-foreground', cardHover: 'hover:border-foreground/60' },
  { key: 'done', label: 'Done', dot: 'bg-success', pill: 'bg-success/15 text-success-text', cardHover: 'hover:border-success' },
];

/** One repository's board, or every repository's (cards stamped with their repository). */
type BoardList = { tasks: (BoardTask & Partial<RepoStamp>)[]; capped: boolean; failures: RepoReadFailure[] };

export function TaskBoard({
  project,
  allRepos = false,
  repos,
  teamId,
  filter = DEFAULT_FILTER,
  onFilter,
  projects = [],
  onOpenTask,
  onNewTask,
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
  onOpenTask: (taskId: string, repoPath?: string) => void;
  onNewTask: () => void;
}) {
  const { data, error, loading } = useAsync(
    (): Promise<BoardList> =>
      allRepos ? listTasksAll(teamId).then((l) => ({ ...l, tasks: inRepos(l.tasks, repos), failures: inRepos(l.failures, repos) })) : listTasks(project).then((r) => ({ ...r, failures: [] })),
    [project, allRepos, teamId, repos.join('\n')],
  );
  const approver = useApproverDecisions(project, !allRepos);
  const allTasks = data?.tasks;
  const tasks = allTasks && filterCards(allTasks, filter);
  const lanes = groupRows(tasks ?? [], filter.group, cardKeys);

  // The quick view opens beside the Board; Escape or a click outside closes it and focus returns to the card.
  const [selected, setSelected] = useState<QuickTask | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const close = (): void => {
    setSelected(null);
    cardRef.current?.focus();
  };
  // A card of another repository must not linger when the project (or "all repositories") changes.
  useEffect(() => setSelected(null), [project, allRepos]);
  // Nor may a card the filter now hides.
  useEffect(() => {
    if (selected !== null && tasks && !tasks.some((t) => t.id === selected.id && t.repoPath === selected.repoPath)) setSelected(null);
  }, [tasks, selected]);
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
    <FilterBar filter={filter} onChange={onFilter} repos={allRepos ? projects : []} withCards={[...new Set((allTasks ?? []).flatMap((t) => (t.repoPath ? [t.repoPath] : [])))]} />
  );
  const header = (
    <>
    <div className="mb-2 flex shrink-0 items-center">
      {counts !== null && (
        // A capped list is one page, so both numbers are lower bounds — `Running 3+ · Waiting 12+`.
        <span className="text-xs tabular-nums text-muted-foreground">
          Running {counts.running} · Waiting {counts.waiting}
        </span>
      )}
      <Button className="ml-auto" onClick={onNewTask} startIcon={<FilePlus className="size-4" />}>
        New Task
      </Button>
    </div>
    {bar}
    </>
  );

  if (loading) return <div className="text-sm text-muted-foreground">Loading tasks…</div>;
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <ErrorNote
          title="Couldn't load the task board"
          next="This is usually a connection or setup problem: check the task source in Settings and that its credentials are valid, then reload."
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <RepoFailures failures={data?.failures ?? []} />
      {allTasks?.length === 0 && (data?.failures.length ?? 0) === 0 && (
        <div className="mb-3 shrink-0 rounded-lg border border-dashed border-border/60 p-4 text-sm">
          <div className="font-medium">No tasks yet</div>
          <p className="mt-1 text-muted-foreground">Create a task with acceptance criteria. The factory picks it up and its card moves across this board.</p>
          <Button className="mt-2" onClick={onNewTask}>Create a task</Button>
        </div>
      )}
      {capped && (
        <div className="mb-2 shrink-0 text-xs text-muted-foreground">
          {allRepos
            ? 'At least one repository hit the task limit, so some cards are missing — narrow the Projects filter to that repository and use a label filter in Settings.'
            : `Showing the first ${allTasks?.length ?? 0} tasks — narrow with a label filter in Settings to see the rest.`}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 pb-4">
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-4', filter.group !== 'none' && 'overflow-y-auto')}>
        {lanes.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No cards match.</div>}
        {lanes.map((lane) => (
        <section key={lane.key} aria-label={lane.label || undefined} className={cn('flex min-h-0 flex-col gap-2', filter.group === 'none' ? 'flex-1' : 'h-[28rem] shrink-0')}>
        {lane.label && (
          <h3 className="text-sm font-semibold">
            {lane.label} <span className="font-normal tabular-nums text-muted-foreground">{lane.rows.length}</span>
          </h3>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto">
        {COLUMNS.map((col) => {
          const items = lane.rows.filter((t) => t.column === col.key);
          return (
            <div
              key={col.key}
              className="flex h-full min-h-0 w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/20 p-2"
            >
              <div className="mb-2 flex shrink-0 items-center gap-2 px-1 py-0.5">
                <span className={cn('size-2 rounded-full', col.dot, col.pulse && items.length > 0 && 'animate-pulse')} />
                <span className="text-sm font-semibold text-foreground">{col.label}</span>
                <span className={cn('ml-auto rounded-full px-2 py-0.5 text-xs font-medium tabular-nums', col.pill)}>
                  {items.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-0.5 pb-0.5">
                {items.length === 0 ? (
                  <div className="mt-2 rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                    No tasks
                  </div>
                ) : (
                  items.map((t) => (
                    <div key={`${t.repoPath ?? ''}:${t.id}`}>
                    <button
                      data-board-card
                      aria-expanded={selected?.id === t.id && selected.repoPath === t.repoPath}
                      onClick={(e) => {
                        cardRef.current = e.currentTarget;
                        setSelected(t);
                      }}
                      className="block w-full text-left"
                    >
                      <Card.Root className={cn('bg-background/80 py-0 shadow-sm transition-all hover:shadow-md', col.cardHover)}>
                        <Card.Content className="space-y-1.5 p-3">
                          <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-muted-foreground">
                            {t.id}
                            {allRepos && <RepoLabel name={t.repoName} />}
                          </div>
                          <div className="text-sm leading-snug">{t.title}</div>
                          {t.column === 'running' && t.stage && <div className="font-mono text-[11px]">stage: {t.stage}</div>}
                          {(t.column === 'review' || t.column === 'done') && !!t.chips?.length && (
                            <div className="flex flex-wrap gap-1">
                              {t.chips.map((chip) => <span key={chip.key} className={cn('rounded px-1.5 py-0.5 text-[11px]', Object.hasOwn(CHIP_TONE, chip.tone) ? CHIP_TONE[chip.tone] : 'bg-muted text-muted-foreground')}>{chip.label}</span>)}
                            </div>
                          )}
                          {(() => {
                            const d = decisionForTask(t.id, approver.runs, approver.decisions);
                            return d !== undefined && <div className="text-[11px] text-muted-foreground" data-approver={d.outcome}>{decisionWords(d)}</div>;
                          })()}
                          {t.baseBranch && (
                            <div className="pt-0.5 font-mono text-[11px] text-muted-foreground">→ {t.baseBranch}</div>
                          )}
                          {t.state && t.state !== col.key && (
                            <div className="pt-0.5 text-[11px] text-muted-foreground">{t.state}</div>
                          )}
                        </Card.Content>
                      </Card.Root>
                    </button>
                    {t.source !== undefined && t.url !== undefined && (
                      <div className="px-3 pt-1">
                        <ExternalLink href={t.url}>{`Open in ${TRACKER_NAME[t.source]}`}</ExternalLink>
                      </div>
                    )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
        </div>
        </section>
        ))}
      </div>
      {selected !== null && (
        <QuickView
          ref={panelRef}
          task={selected}
          project={project}
          onClose={close}
          onFullPage={() => onOpenTask(selected.id, selected.repoPath)}
        />
      )}
      </div>
    </div>
  );
}
