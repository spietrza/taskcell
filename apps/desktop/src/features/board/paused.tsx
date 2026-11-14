import { useState } from 'react';
import { Button } from '@/ui';
import { listTasks, listTasksAll, retryPausedTask } from '../../ipc';
import { inRepos } from '../../repoFilter';
import { useAsync } from '../../hooks';
import { canUseNeedsYou } from '../needs-you/NeedsYou';
import type { BoardTask, PausedState } from '../../wire';

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** When the scheduled resume retries, in local time: "after HH:MM", "soon" once that time has passed, nothing when the marker is missing. */
export function retryWords(paused: PausedState, now: number = Date.now()): string | undefined {
  const ms = paused.until === undefined ? NaN : Date.parse(paused.until);
  return Number.isNaN(ms) ? undefined : whenWords(ms, now);
}

const whenWords = (ms: number, now: number): string => (ms <= now ? 'soon' : `after ${clock(ms)}`);

/** "retries automatically after 18:30", or just "retries automatically" without a time. */
export function retryLine(paused: PausedState, now?: number): string {
  const when = retryWords(paused, now);
  return when === undefined ? 'retries automatically' : `retries automatically ${when}`;
}

/** The card's state line. */
export function PausedLine({ paused }: { paused: PausedState }) {
  return (
    <div className="text-[11px] text-warning-text" data-paused>
      <div className="font-medium">Paused: provider limit</div>
      <div>{retryLine(paused)}</div>
    </div>
  );
}

/** One banner for the paused tasks of the shown repositories; nothing when none is paused. */
export function PausedBanner({ tasks }: { tasks: Pick<BoardTask, 'paused'>[] }) {
  const paused = tasks.flatMap((t) => (t.paused === undefined ? [] : [t.paused]));
  if (paused.length === 0) return null;
  const times = paused.flatMap((p) => (p.until === undefined ? [] : [Date.parse(p.until)])).filter((n) => !Number.isNaN(n));
  const when = times.length > 0 ? whenWords(Math.max(...times), Date.now()) : undefined;
  return (
    <div role="status" data-paused-banner className="mb-3 shrink-0 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <div className="font-medium">
        {paused.length === 1 ? '1 task is' : `${paused.length} tasks are`} paused by a provider limit
        {when !== undefined && <span className="font-normal"> · latest retry {when}</span>}
      </div>
      <p className="mt-1 text-muted-foreground">They retry automatically; you can wait, or add credit or switch the model in Settings.</p>
    </div>
  );
}

/** Home's banner: reads the shown repositories' cards itself and says nothing when none is paused or the list cannot be read. */
export function HomePausedBanner({ project, allRepos, repos, teamId }: { project: string; allRepos: boolean; repos: string[]; teamId?: string }) {
  const { data } = useAsync(
    async (): Promise<Pick<BoardTask, 'paused'>[]> => {
      if (!canUseNeedsYou()) return [];
      try {
        return allRepos ? inRepos((await listTasksAll(teamId)).tasks, repos) : (await listTasks(project)).tasks;
      } catch {
        return [];
      }
    },
    [project, allRepos, teamId, repos.join('\n')],
  );
  return <PausedBanner tasks={data ?? []} />;
}

/** "Retry now": removes the limit hold and re-applies the recorded trigger, as `Start` would. A refusal shows inline. */
export function RetryNowButton({ repoPath, task, onRetried }: { repoPath: string; task: Pick<BoardTask, 'id'>; onRetried?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const number = /^gh-(\d+)$/.exec(task.id)?.[1];
  if (number === undefined || !canUseNeedsYou()) return null;
  const retry = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await retryPausedTask(repoPath, Number(number));
      setDone(true);
      onRetried?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outlined" disabled={busy || done} onClick={() => void retry()}>
        {busy ? 'Retrying…' : done ? 'Retry requested' : 'Retry now'}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive-text">
          Not retried: {error}
        </span>
      )}
    </div>
  );
}

/** The paused state with its retry time and the "Retry now" action (task detail and quick view). */
export function PausedPanel({ repoPath, task, onRetried }: { repoPath: string; task: Pick<BoardTask, 'id' | 'paused'>; onRetried?: () => void }) {
  if (task.paused === undefined) return null;
  return (
    <section aria-label="Paused" className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <div>
        <div className="font-medium">Paused: provider limit</div>
        <div className="text-muted-foreground">{retryLine(task.paused)}</div>
      </div>
      <RetryNowButton repoPath={repoPath} task={task} onRetried={onRetried} />
    </section>
  );
}

/** The full-page detail has only the task id: read its card to show the paused state. */
export function TaskDetailPaused({ project, taskId }: { project: string; taskId: string }) {
  const { data } = useAsync(async (): Promise<BoardTask | undefined> => (canUseNeedsYou() ? (await listTasks(project).catch(() => ({ tasks: [] as BoardTask[] }))).tasks.find((t) => t.id === taskId) : undefined), [project, taskId]);
  return data == null ? null : <PausedPanel repoPath={project} task={data} />;
}
