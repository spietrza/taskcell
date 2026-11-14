import { useState } from 'react';
import { Button, cn } from '@/ui';
import { hubTaskSchedule } from '../../ipc';
import { errorMessage } from '../../errors';
import type { BoardTask } from '../../wire';

/** What a card says about its dependencies and start date: the scheduler's label (hub board) or what the source reports. */
export function ScheduleLines({ task }: { task: Pick<BoardTask, 'blockedBy' | 'startDate' | 'schedule' | 'timeZone'> }) {
  const s = task.schedule;
  return (
    <>
      {s !== undefined && s.state !== 'done' && (
        <div data-schedule={s.state} className={cn('text-[11px]', s.state === 'invalid' ? 'font-medium text-destructive-text' : 'text-muted-foreground')}>
          {s.label}
        </div>
      )}
      {s === undefined && !!task.blockedBy?.length && <div className="text-[11px] text-muted-foreground">blocked by {task.blockedBy.join(', ')}</div>}
      {s === undefined && task.startDate !== undefined && <div className="text-[11px] text-muted-foreground">starts {task.startDate}</div>}
    </>
  );
}

/** Edits a hub-board task's "blocked by" (comma-separated task ids of this project) and start date. */
export function ScheduleEditor({ repoPath, task, onSaved }: { repoPath: string; task: BoardTask; onSaved: () => void }) {
  const [blockedBy, setBlockedBy] = useState((task.blockedBy ?? []).join(', '));
  const [date, setDate] = useState(task.startDate?.slice(0, 10) ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setError(null);
    const ids = blockedBy.split(/[\s,]+/).filter((x) => x !== '');
    hubTaskSchedule(repoPath, task.id, { blockedBy: ids, startDate: date === '' ? null : date }).then(onSaved, (e: unknown) => setError(errorMessage(e)));
  };
  return (
    <section aria-label="Schedule" className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Schedule</h4>
      <ScheduleLines task={task} />
      <label className="block text-xs">
        Blocked by
        <input className="mt-0.5 block w-full rounded border border-border/60 bg-background px-2 py-1 text-sm" value={blockedBy} onChange={(e) => setBlockedBy(e.target.value)} placeholder="hub-1, hub-2" />
      </label>
      <label className="block text-xs">
        Start date{task.timeZone !== undefined ? ` (00:00 in the hub time zone, ${task.timeZone})` : ''}
        <input type="date" className="mt-0.5 block rounded border border-border/60 bg-background px-2 py-1 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {error !== null && <div role="alert" className="text-xs text-destructive-text">{error}</div>}
      <Button variant="outlined" onClick={save}>Save schedule</Button>
    </section>
  );
}
