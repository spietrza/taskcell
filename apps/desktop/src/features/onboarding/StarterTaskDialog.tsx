import { useEffect, useRef, useState } from 'react';
import { Button, useFocusTrap } from '@/ui';
import { apiCreateTask } from '../../ipc';
import { errorMessage } from '../../errors';
import { STARTER_TASK } from './steps';

/** Offered after the first project is added: a small task with acceptance criteria the factory can deliver quickly. */
export function StarterTaskDialog({ project, onCreated, onClose }: { project: { path: string; name: string }; onCreated: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiCreateTask(project.path, STARTER_TASK.title, STARTER_TASK.body);
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="starter-task-title" tabIndex={-1} className="w-[32rem] max-w-[95vw] space-y-3 rounded-lg border border-border bg-background p-4 shadow-lg outline-none">
        <h2 id="starter-task-title" className="text-sm font-medium">Try a first task on {project.name}?</h2>
        <p className="text-sm text-muted-foreground">A small starter task the factory can deliver quickly. Creating it adds one task to the repository's task source.</p>
        <div className="space-y-1 rounded bg-muted/40 p-3 text-sm">
          <div className="font-medium">{STARTER_TASK.title}</div>
          <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground">{STARTER_TASK.body}</pre>
        </div>
        {error && <p role="alert" className="text-xs text-destructive-text">Task not created: {error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="text" color="secondary" disabled={busy} onClick={onClose}>Not now</Button>
          <Button disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create this task'}</Button>
        </div>
      </div>
    </div>
  );
}
