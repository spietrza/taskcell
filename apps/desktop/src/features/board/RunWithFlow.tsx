import { useEffect, useState } from 'react';
import { Button } from '@/ui';
import { apiCapabilitiesCached, hubTaskRetry, hubTaskStart } from '../../ipc';
import { hub } from '../../transport';
import { errorMessage } from '../../errors';
import { useCallerCapabilities } from '../../hooks';
import { flowOptionsFrom } from '../inspector/NewRunForm';

/**
 * "Run with flow…" on a hub-board card: lists the repo's flows (built-ins and valid repo flows) and starts (a to-do card)
 * or retries (a failed one) the card with the chosen one. Hidden without `canStartTask`.
 */
export function RunWithFlow({ repoPath, taskId, mode, onDone }: { repoPath: string; taskId: string; mode: 'start' | 'retry'; onDone: () => void }) {
  const gate = useCallerCapabilities(repoPath)?.project?.canStartTask;
  const [open, setOpen] = useState(false);
  const [flows, setFlows] = useState<{ value: string; label: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The card this component started: its picker stays closed until the board shows the card moved on (no second start).
  const [startedId, setStartedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    // Fresh on every open: a flow saved in the editor is runnable at once. A failed repo read still offers the built-ins.
    Promise.all([apiCapabilitiesCached(), hub().call('api_list_flows', { repoPath }).then((r) => r.flows, () => 'error' as const)])
      .then(([caps, repoFlows]) => live && setFlows(flowOptionsFrom(caps, repoFlows)))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, repoPath]);
  if (gate?.allowed === false || startedId === taskId) return null;

  const run = (flow: string): void => {
    setBusy(true);
    setError(null);
    (mode === 'start' ? hubTaskStart(repoPath, taskId, flow) : hubTaskRetry(repoPath, taskId, flow)).then(() => {
      setBusy(false);
      setOpen(false);
      if (mode === 'start') setStartedId(taskId);
      onDone();
    }, (e: unknown) => {
      setError(errorMessage(e));
      setBusy(false);
    });
  };
  return (
    <>
      <Button variant="outlined" disabled={busy} onClick={() => setOpen((o) => !o)}>Run with flow…</Button>
      {open && flows !== null && (
        <ul aria-label="Flows" className="flex w-full flex-wrap gap-2">
          {flows.map((f) => (
            <li key={f.value}>
              <Button variant="text" disabled={busy} onClick={() => run(f.value)}>{f.label}</Button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <div role="alert" className="w-full break-words text-xs text-destructive-text">{error}</div>}
    </>
  );
}
