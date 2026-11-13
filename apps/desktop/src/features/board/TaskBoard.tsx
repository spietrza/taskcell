import { Button, Card, cn } from '@/ui';
import { FilePlus } from 'lucide-react';
import { listTasks, listTasksAll } from '../../ipc';
import { inRepos } from '../../repoFilter';
import { RepoFailures, RepoLabel } from '../../RepoViews';
import type { BoardTask, RepoReadFailure, RepoStamp } from '../../wire';
import { useAsync } from '../../hooks';
import { boardCountLabels } from './counts';
import { ExternalLink } from '../../components/ExternalLink';

const TRACKER_NAME = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear' } as const;

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
  pass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  changes: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

const COLUMNS: Column[] = [
  { key: 'queued', label: 'Queued', dot: 'bg-slate-400', pill: 'bg-slate-400/15 text-slate-600 dark:text-slate-300', cardHover: 'hover:border-slate-400' },
  { key: 'claimed', label: 'Claimed', dot: 'bg-amber-500', pill: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', cardHover: 'hover:border-amber-500' },
  { key: 'running', label: 'Running', dot: 'bg-blue-500', pill: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', cardHover: 'hover:border-blue-500', pulse: true },
  { key: 'verify-failed', label: 'Verify failed', dot: 'bg-rose-500', pill: 'bg-rose-500/15 text-rose-700 dark:text-rose-300', cardHover: 'hover:border-rose-500' },
  { key: 'review', label: 'Review', dot: 'bg-violet-500', pill: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', cardHover: 'hover:border-violet-500' },
  { key: 'done', label: 'Done', dot: 'bg-emerald-500', pill: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', cardHover: 'hover:border-emerald-500' },
];

/** One repository's board, or every repository's (cards stamped with their repository). */
type BoardList = { tasks: (BoardTask & Partial<RepoStamp>)[]; capped: boolean; failures: RepoReadFailure[] };

export function TaskBoard({
  project,
  allRepos = false,
  repos,
  teamId,
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
  onOpenTask: (taskId: string, repoPath?: string) => void;
  onNewTask: () => void;
}) {
  const { data, error, loading } = useAsync(
    (): Promise<BoardList> =>
      allRepos ? listTasksAll(teamId).then((l) => ({ ...l, tasks: inRepos(l.tasks, repos), failures: inRepos(l.failures, repos) })) : listTasks(project).then((r) => ({ ...r, failures: [] })),
    [project, allRepos, teamId, repos.join('\n')],
  );
  const tasks = data?.tasks;

  // Capped comes from the response now (S9) — no more synced literal; the core fetch cap decides.
  const capped = data?.capped === true;
  const counts = boardCountLabels(data);

  // The board is where work starts (S10): authoring a task lives one click away even when the
  // list itself failed to load.
  const header = (
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
  );

  if (loading) return <div className="text-sm text-muted-foreground">Loading tasks…</div>;
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          No task board. {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <RepoFailures failures={data?.failures ?? []} />
      {capped && (
        <div className="mb-2 shrink-0 text-xs text-muted-foreground">
          {allRepos
            ? 'At least one repository hit the task limit, so some cards are missing — pick that repository and narrow with a label filter in Settings.'
            : `Showing the first ${tasks?.length ?? 0} tasks — narrow with a label filter in Settings to see the rest.`}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => {
          const items = (tasks ?? []).filter((t) => t.column === col.key);
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
                    <button onClick={() => onOpenTask(t.id, t.repoPath)} className="block w-full text-left">
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
                              {t.chips.map((chip) => <span key={chip.key} className={cn('rounded px-1.5 py-0.5 text-[11px]', Object.hasOwn(CHIP_TONE, chip.tone) ? CHIP_TONE[chip.tone] : 'bg-slate-400/15 text-muted-foreground')}>{chip.label}</span>)}
                            </div>
                          )}
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
    </div>
  );
}
