import { useEffect, useRef } from 'react';
import { Button } from '@/ui';

/**
 * Confirmation for the app's first irreversible write.
 *
 * Creating a task is not undoable from inside the app, so the user sees exactly what will happen and to
 * WHERE before it happens: the transport, the title, and the body size. It deliberately does not offer
 * "create and run" — one irreversible action per button.
 */
export function CreateTaskDialog({
  source,
  title,
  bodyBytes,
  branches,
  baseBranch,
  onBaseBranch,
  busy,
  onConfirm,
  onCancel,
}: {
  source: string;
  title: string;
  bodyBytes: number;
  /** The repo's branches; empty ⇒ no choice is offered (the repo default applies). */
  branches: string[];
  /** The chosen target branch; '' ⇒ the repo default. */
  baseBranch: string;
  onBaseBranch: (branch: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus starts inside the dialog, so screen readers announce it and Tab stays near its buttons;
  // on close it goes back to whatever opened the dialog instead of falling to <body>.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-title"
        tabIndex={-1}
        className="w-[28rem] rounded-lg border border-border bg-background p-4 shadow-lg outline-none"
      >
        <h2 id="create-task-title" className="text-sm font-medium">Create a task on {source}?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This creates a real issue and <strong>cannot be undone from here</strong>. It does not start a run.
        </p>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Title</dt>
            <dd className="truncate font-medium">{title}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Body</dt>
            <dd className="tabular-nums text-muted-foreground">{bodyBytes} bytes</dd>
          </div>
          {branches.length > 0 && (
            <div className="flex items-center gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">Target</dt>
              <dd>
                <select
                  aria-label="Target branch"
                  className="rounded border border-border bg-background px-1 py-0.5 font-mono text-xs"
                  value={baseBranch}
                  onChange={(e) => onBaseBranch(e.target.value)}
                  disabled={busy}
                >
                  <option value="">repository default</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </dd>
            </div>
          )}
        </dl>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="text" color="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={busy}>
            Create task
          </Button>
        </div>
      </div>
    </div>
  );
}
