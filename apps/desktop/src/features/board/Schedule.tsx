import { useState } from 'react';
import { Button, cn } from '@/ui';
import { hubTaskAccept, hubTaskArchive, hubTaskCreate, hubTaskDelete, hubTaskRetry, hubTaskSchedule } from '../../ipc';
import { errorMessage } from '../../errors';
import type { BoardTask } from '../../wire';

const FIELD = 'mt-0.5 block w-full rounded border border-border/60 bg-background px-2 py-1 text-sm';

/** What a card says about its dependencies and start date: the scheduler's label (hub board) or what the source reports. */
export function ScheduleLines({ task }: { task: Pick<BoardTask, 'blockedBy' | 'startDate' | 'schedule' | 'timeZone'> }) {
  const s = task.schedule;
  return (
    <>
      {s !== undefined && s.state !== 'done' && (
        <div data-schedule={s.state} className={cn('break-words text-[11px]', s.state === 'invalid' || s.state === 'failed' ? 'font-medium text-destructive-text' : 'text-muted-foreground')}>
          {s.label}
        </div>
      )}
      {/* What the run delivered (a pull request or `branch <name>`), labelled so it does not read as the heading's subtitle. */}
      {s?.result !== undefined && <div className="truncate text-[11px] text-muted-foreground" title={s.result}>Delivered: {s.result}</div>}
      {s === undefined && !!task.blockedBy?.length && <div className="text-[11px] text-muted-foreground">blocked by {task.blockedBy.join(', ')}</div>}
      {s === undefined && task.startDate !== undefined && <div className="text-[11px] text-muted-foreground">starts {task.startDate}</div>}
    </>
  );
}

/** Example ids for a "Blocked by" field: never the card's own id, which it cannot wait for. */
export const blockedByExample = (own?: string): string => ['hub-1', 'hub-2', 'hub-3'].filter((id) => id !== own).slice(0, 2).join(', ');

/** Edits a hub-board task's "blocked by" (comma-separated task ids of this project) and start date; retries a failed one. */
export function ScheduleEditor({ repoPath, task, onSaved }: { repoPath: string; task: BoardTask; onSaved: () => void }) {
  const [blockedBy, setBlockedBy] = useState((task.blockedBy ?? []).join(', '));
  const stored = task.startDate ?? '';
  const [date, setDate] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const done = (p: Promise<unknown>): void => {
    setError(null);
    p.then(onSaved, (e: unknown) => setError(errorMessage(e)));
  };
  const save = (): void => {
    const ids = blockedBy.split(/[\s,]+/).filter((x) => x !== '');
    // The start date goes only when it was edited: a stored instant is never rewritten by saving something else.
    done(hubTaskSchedule(repoPath, task.id, { blockedBy: ids, ...(date !== stored ? { startDate: date === '' ? null : date } : {}) }));
  };
  // A stored instant (not a plain day) is shown and edited as it is: a date picker would cut its time off.
  const instant = stored.length > 10;
  return (
    <section aria-label="Schedule" className="mt-3 space-y-2 border-t border-border/50 pt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Schedule</h4>
      <ScheduleLines task={task} />
      <label className="block text-xs">
        Blocked by
        <input className={FIELD} value={blockedBy} onChange={(e) => setBlockedBy(e.target.value)} placeholder={blockedByExample(task.id)} />
      </label>
      <label className="block text-xs">
        Start date{task.timeZone !== undefined ? ` (${instant ? 'hub time zone' : '00:00 in the hub time zone,'} ${task.timeZone})` : ''}
        <input type={instant ? 'text' : 'date'} className={cn(FIELD, !instant && 'w-auto')} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <p className="text-[11px] text-muted-foreground">Saving or retrying makes you the card's owner: it runs as you, on your credential.</p>
      {error !== null && <div role="alert" className="text-xs text-destructive-text">{error}</div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outlined" onClick={save}>Save schedule</Button>
        {task.schedule?.state === 'failed' && task.schedule.result !== undefined && <Button variant="outlined" onClick={() => done(hubTaskAccept(repoPath, task.id))}>Accept result</Button>}
        {task.schedule?.state === 'failed' && <Button variant="outlined" onClick={() => done(hubTaskRetry(repoPath, task.id))}>Retry</Button>}
        {task.schedule?.state === 'done' && <Button variant="outlined" onClick={() => done(hubTaskArchive(repoPath, task.id))}>Archive</Button>}
        {task.schedule?.state !== 'running' && <Button variant="text" color="destructive" className="ml-auto" onClick={() => done(hubTaskDelete(repoPath, task.id))}>Delete</Button>}
      </div>
    </section>
  );
}

/** Adds a task to a hub-board project. It runs as whoever adds it, once its dependencies and start date allow. */
export function NewHubTask({ repoPath, onCreated, onCancel }: { repoPath: string; onCreated: () => void; onCancel?: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [blockedBy, setBlockedBy] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    const ids = blockedBy.split(/[\s,]+/).filter((x) => x !== '');
    hubTaskCreate(repoPath, title, body, { ...(ids.length > 0 ? { blockedBy: ids } : {}), ...(date !== '' ? { startDate: date } : {}) }).then(
      () => {
        setTitle('');
        setBody('');
        setBlockedBy('');
        setDate('');
        onCreated();
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  };
  return (
    <form aria-label="New card" onSubmit={add} className="mb-3 flex shrink-0 flex-col gap-2 rounded-lg border border-border/60 p-3 sm:flex-row sm:flex-wrap sm:items-start">
      {/* Name the target: in the All view the form adds to the open project, which nothing else on screen shows. */}
      <p className="w-full text-xs text-muted-foreground">New card in <span className="font-medium text-foreground">{repoPath.split('/').filter(Boolean).pop()}</span> (Taskcell board)</p>
      <label className="block min-w-0 text-xs sm:w-64">
        Title
        <input className={FIELD} value={title} maxLength={300} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block min-w-0 flex-1 text-xs">
        What to do, with acceptance criteria
        <textarea className={FIELD} rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="block min-w-0 text-xs sm:w-32">
        Blocked by
        <input className={FIELD} value={blockedBy} onChange={(e) => setBlockedBy(e.target.value)} placeholder={blockedByExample()} />
      </label>
      <label className="block text-xs">
        Start date (00:00 in the hub time zone)
        <input type="date" className={cn(FIELD, 'w-auto')} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="sm:pt-4">
        <Button type="submit" disabled={title.trim() === ''}>Add card</Button>
        {onCancel && <Button variant="text" className="ml-2" onClick={onCancel}>Cancel</Button>}
        {error !== null && <div role="alert" className="mt-1 text-xs text-destructive-text">{error}</div>}
      </div>
    </form>
  );
}
