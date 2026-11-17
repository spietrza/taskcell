import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleCheck, CircleX, GitMerge, Info, MessageCircleQuestionMark, Play, Settings2, SquarePlus, type LucideIcon } from 'lucide-react';
import { Button, Skeleton, cn } from '@/ui';
import { listActive, listActivity, listRunsAll, listTasksAll, type RepoReadFailure } from '../../ipc';
import { onStreamReset, subscribe } from '../../transport';
import { inRepos } from '../../repoFilter';
import { RepoFailures, isNoTaskSource } from '../../RepoViews';
import { NeedsYou } from '../needs-you/NeedsYou';
import type { ActivityEvent, FactoryState, LocalWorkerState, Project } from '../../wire';
import { relTime } from '../../time';
import { Floor } from './Floor';
import { activityText, cantStart, floorRows, movingRows, stateCounts, thisWeek, type Card, type RunRow, type StampedActive, type StampedNeeds } from './homeModel';

const TASKS_POLL_MS = 60000;
const MOVING_SHOWN = 6;
const ACTIVITY_SHOWN = 6;

const ACTIVITY_ICON: Record<ActivityEvent['kind'], LucideIcon> = {
  'run-started': Play,
  'run-finished': CircleCheck,
  'run-failed': CircleX,
  'run-asked': MessageCircleQuestionMark,
  'card-created': SquarePlus,
  'pr-merged': GitMerge,
  'settings-changed': Settings2,
};

/**
 * Reads `read` on mount, whenever the hub reports a change in one of `repos` (and after a stream gap), and, with
 * `pollMs`, on a timer while the page is visible. One read at a time; a failed read keeps the last answer.
 */
function useHubRead<T>(read: () => Promise<T>, key: string, repos: string[], pollMs?: number): [data: T | null, settled: boolean] {
  const [data, setData] = useState<T | null>(null);
  // The first read has answered, either way: a failed one leaves `data` null but must not keep Home loading.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setData(null); // another scope: never show the old one's answer
    setSettled(false);
    let alive = true;
    let busy = false;
    let again = false; // a change arrived mid-read: one trailing read
    const load = (): void => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      read()
        .then((d) => {
          if (alive) setData(d);
        }, () => {})
        .finally(() => {
          busy = false;
          if (alive) setSettled(true);
          if (again && alive) {
            again = false;
            load();
          }
        });
    };
    load();
    const id = pollMs === undefined ? undefined : setInterval(() => !document.hidden && load(), pollMs);
    const changed = subscribe<string>('vanguard:changed', (e) => repos.includes(e.payload) && load());
    const reset = onStreamReset(load);
    return () => {
      alive = false;
      if (id !== undefined) clearInterval(id);
      void changed.then((f) => f());
      void reset.then((f) => f());
    };
    // `read` is rebuilt every render; `key` names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);
  return [data, settled];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The state sentence: what waits, and what moves. */
function StateSentence({ waiting, moving, paused }: { waiting: number; moving: number | null; paused: number }) {
  const second =
    moving === null
      ? null
      : [moving > 0 && `${moving} ${moving === 1 ? 'is' : 'are'} moving`, paused > 0 && `${paused} paused by a provider limit`].filter(Boolean).join(', ') || 'Nothing is moving';
  return (
    <h1 className="font-heading text-4xl font-bold leading-tight tracking-tight max-md:text-3xl">
      <span>{waiting === 0 ? 'Nothing waits for you.' : `${plural(waiting, 'card waits', 'cards wait')} for you.`}</span>
      {second !== null && <span className="block text-muted-foreground">{second}.</span>}
    </h1>
  );
}

/** Home's first paint: the headline's two lines, the inbox and the floor as quiet blocks at their own heights. */
export function HomeSkeleton() {
  return (
    <div role="status" aria-label="Loading Home" className="min-w-0 space-y-6">
      <div className="space-y-2 py-1">
        <Skeleton className="h-9 w-3/4 max-md:h-8" />
        <Skeleton className="h-9 w-1/2 max-md:h-8" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="space-y-3">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
      {/* The week and activity block: reserved, so the Projects list below does not jump when Home's data lands. */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Home's command center: what waits for the user, what is moving, the factory floor and the week. The app puts the
 * projects (Onboarding and the project cards) below it. Everything is read from commands the app already uses.
 */
export function Home({
  project,
  projects,
  repoPaths,
  teamId,
  needs,
  needsError,
  onReloadNeeds,
  factoryStates,
  localWorkers,
  onOpenRunning,
  onEnterProject,
  onSeeAllMoving,
  onOpenFactory,
  onOpenBoard,
}: {
  /** The active project: where a waiting item without its own repository is answered. */
  project: string;
  projects: Project[];
  /** The repositories shown: the team's, narrowed by the shared filter. */
  repoPaths: string[];
  teamId?: string | undefined;
  /** The app's poll of what waits for the user (null = not loaded yet). */
  needs: { items: StampedNeeds[]; failures: RepoReadFailure[] } | null;
  needsError: string | null;
  onReloadNeeds: () => void;
  factoryStates: Record<string, FactoryState>;
  localWorkers: Record<string, LocalWorkerState>;
  onOpenRunning: (run: StampedActive) => void;
  onEnterProject: (path: string) => void;
  onSeeAllMoving: () => void;
  onOpenFactory: (p: { path: string; name: string }) => void;
  onOpenBoard: () => void;
}) {
  const repoKey = repoPaths.join('\n');
  const shown = useMemo(() => projects.filter((p) => repoPaths.includes(p.path)), [projects, repoKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tasks, tasksSettled] = useHubRead(
    () => listTasksAll(teamId).then((l) => ({ tasks: inRepos(l.tasks, repoPaths) as Card[], failures: inRepos(l.failures, repoPaths) })),
    `${teamId ?? ''}|${repoKey}`,
    repoPaths,
    TASKS_POLL_MS,
  );
  const [runs, runsSettled] = useHubRead(() => listRunsAll(teamId).then((l) => inRepos(l.runs, repoPaths) as RunRow[]), `${teamId ?? ''}|${repoKey}`, repoPaths);
  // Live local runs come from the project poll the app already runs: only a project with a run in flight is asked.
  const runningKey = shown.filter((p) => p.runningCount > 0).map((p) => `${p.path}:${p.runningCount}`).join('\n');
  const [active] = useHubRead(
    () =>
      Promise.all(
        runningKey === '' ? [] : runningKey.split('\n').map((l) => l.slice(0, l.lastIndexOf(':'))).map((path) => {
          const name = shown.find((p) => p.path === path)?.name ?? path;
          return listActive(path).then((a) => a.map((r): StampedActive => ({ ...r, repoPath: path, repoName: name })), () => []);
        }),
      ).then((l) => l.flat()),
    `${runningKey}|${repoKey}`,
    repoPaths,
  );

  // Run records and hub actions only (no tracker read): on mount and on a hub change, no timer.
  const [activity] = useHubRead(() => listActivity(teamId).then((l) => inRepos(l, repoPaths)), `${teamId ?? ''}|${repoKey}`, repoPaths);

  const cards = tasks?.tasks ?? [];
  const counts = stateCounts(cards);
  const moving = useMemo(() => movingRows(cards, active ?? []), [tasks, active]); // eslint-disable-line react-hooks/exhaustive-deps
  const floor = useMemo(() => floorRows(shown, cards, runs ?? [], needs?.items ?? []), [shown, tasks, runs, needs]); // eslint-disable-line react-hooks/exhaustive-deps
  const week = thisWeek(runs ?? []);
  const stuck = tasks === null ? [] : cantStart(shown, cards, factoryStates, localWorkers);
  const anyPaused = moving.some((m) => m.paused);
  const readFailures = (tasks?.failures ?? []).filter((f) => !isNoTaskSource(f.error));
  const projectCount = new Set(moving.map((m) => m.repoPath)).size;

  // First paint: one skeleton until the headline, the inbox and the floor can all be drawn, so none of them pops in.
  const loading = (needs === null && needsError === null) || !tasksSettled || !runsSettled;

  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {loading ? <HomeSkeleton /> : (
      <div className="min-w-0 space-y-6">
        {needs !== null && <StateSentence waiting={needs.items.length} moving={tasks === null ? null : counts.moving} paused={counts.paused} />}
        <RepoFailures failures={readFailures} total={repoPaths.length} />
        <NeedsYou
          project={project}
          items={needs?.items ?? null}
          failures={needs?.failures ?? []}
          error={needsError}
          repoCount={repoPaths.length}
          onReload={onReloadNeeds}
          onOpenBoard={onOpenBoard}
        />
        {stuck.length > 0 && (
          <div role="alert" data-cant-start className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {stuck.slice(0, 3).map((s) => (
              <div key={s.path} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  <strong className="font-semibold text-destructive-text">{plural(s.count, "card can't start.", "cards can't start.")}</strong> {s.reason}
                </span>
                <Button variant="text" color="destructive" className="ml-auto h-7 px-2 text-xs" onClick={() => onOpenFactory({ path: s.path, name: s.name })}>
                  Open auto-run
                </Button>
              </div>
            ))}
            {stuck.length > 3 && <div className="text-xs text-muted-foreground">and {stuck.length - 3} more projects</div>}
          </div>
        )}
        {moving.length > 0 && (
          <section aria-label="Moving" className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-xl font-semibold">Moving</h2>
              <span className="caption">{plural(moving.length, 'card', 'cards')} in {plural(projectCount, 'project', 'projects')}</span>
            </div>
            {anyPaused && <p className="text-xs text-muted-foreground">Paused cards retry automatically; you can wait, or add credit or switch the model in Settings.</p>}
            <ul className="divide-y divide-border rounded-lg border border-border">
              {moving.slice(0, MOVING_SHOWN).map((m) => (
                <li key={m.key}>
                  <button
                    type="button"
                    onClick={() => (m.run ? onOpenRunning(m.run) : onEnterProject(m.repoPath))}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-4 text-left transition-colors hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 max-md:basis-full">
                      <span className="block break-words font-medium">{m.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        <span className="font-mono">{m.repoName}</span> · {m.status}
                      </span>
                    </span>
                    <span className={cn('caption flex shrink-0 items-center gap-1.5', m.paused && 'text-warning-text')}>
                      {!m.paused && <span className="size-2 animate-pulse rounded-full bg-success" aria-hidden />}
                      {m.paused ? `Paused${m.retry ? ` · retries ${m.retry}` : ''}` : 'Running'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Button variant="text" color="secondary" onClick={onSeeAllMoving} endIcon={<ArrowRight className="size-4" />}>
              See all {moving.length} on the Board
            </Button>
          </section>
        )}
        <Floor rows={floor.rows} idle={floor.idle} onOpen={onEnterProject} />
      </div>
      )}
      <aside aria-label="This week" className="min-w-0 space-y-4 lg:pt-2">
        <div>
          <div className="caption">Last 7 days</div>
          <p className="mt-2 text-sm leading-relaxed">
            {runs === null ? (
              'Loading…'
            ) : week.merged > 0 ? (
              <>
                <strong className="font-semibold tabular-nums">{week.merged}</strong> {week.merged === 1 ? 'pull request' : 'pull requests'} merged
                {week.failed > 0 && <>, <strong className="font-semibold tabular-nums">{week.failed}</strong> failed</>}
                {week.retried > 0 && <>, <strong className="font-semibold tabular-nums">{week.retried}</strong> passed after extra attempts</>}. Spend so far{' '}
                <strong className="font-semibold tabular-nums">${week.spend.toFixed(2)}</strong>.
              </>
            ) : (
              `No pull request merged yet; ${[plural(week.runs, 'run', 'runs'), week.failed > 0 && `${week.failed} failed`, week.retried > 0 && `${week.retried} passed after extra attempts`].filter(Boolean).join(', ')}, $${week.spend.toFixed(2)}.`
            )}
          </p>
        </div>
        <div role="note" className="flex gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>Review and merge in Taskcell, or open the pull request in GitHub and work there as usual. Taskcell sees the merge either way.</span>
        </div>
        {activity !== null && activity.length > 0 && (
          <section aria-label="Team and factory">
            <div className="caption">Team and factory</div>
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {activity.slice(0, ACTIVITY_SHOWN).map((e, i) => {
                const Icon = ACTIVITY_ICON[e.kind];
                return (
                  <li key={`${e.time}-${e.kind}-${i}`} className="flex gap-2 px-3 py-2 text-sm">
                    <Icon className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground', e.kind === 'run-failed' && 'text-destructive-text')} aria-hidden />
                    <span className="min-w-0">
                      <span className="block break-words">{activityText(e)}</span>
                      <span className="block text-xs text-muted-foreground">
                        <span className="font-mono">{e.repoName}</span> · {relTime(Date.parse(e.time))}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
