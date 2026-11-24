import { useEffect, useState } from 'react';
import { Button } from '@/ui';
import { hub } from '../../transport';
import { factoryGateOf, gateProps, useCallerCapabilities } from '../../hooks';
import type { FactoryState, LocalWorkerState } from '../../wire';
import { autoRunLabel } from '../dashboard/factoryLabel';
import { EnableFactoryDialog } from '../dashboard/EnableFactoryDialog';

/**
 * Station 01's Auto-run: whether cards that reach the line start by themselves, and the setup behind it (the local
 * worker switch with its checks, the CI factory checklist, the self-hosted snippet), all in the existing dialog.
 */
export function AutoRun({ project, taskSource }: { project: string; taskSource: string | undefined }) {
  const gate = factoryGateOf(useCallerCapabilities(project));
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ f?: FactoryState; w?: LocalWorkerState } | null>(null);
  // Read on mount and again when the dialog closes: it may have switched the worker or advanced the checklist.
  useEffect(() => {
    if (open) return;
    let alive = true;
    void Promise.all([hub().call('factory_state', { repoPath: project }).catch(() => undefined), hub().call('local_worker_state', { repoPath: project }).catch(() => undefined)]).then(([f, w]) => {
      if (alive) setState({ ...(f ? { f } : {}), ...(w ? { w } : {}) });
    });
    return () => {
      alive = false;
    };
  }, [project, open]);
  const run = state === null ? null : autoRunLabel(taskSource, state.f, state.w);
  return (
    <div className="space-y-2">
      <div className="caption">Auto-run</div>
      <p data-testid="line-auto-run" className={`text-sm ${run?.tone === 'bad' ? 'text-destructive-text' : run?.tone === 'on' ? 'text-success-text' : ''}`}>
        {run?.text ?? 'Reading…'}
      </p>
      <p className="text-xs text-muted-foreground">
        {taskSource === 'hub'
          ? 'On: this hub starts the board’s cards by itself. Off: a card starts only when you press Start run.'
          : 'On: labelled issues start by themselves, on this hub (the local worker) or in CI (the factory checklist). Off: start runs by hand.'}
      </p>
      <Button variant="outlined" color="secondary" className="h-8 px-2 text-xs" {...gateProps(gate)} onClick={() => setOpen(true)}>
        Set up auto-run
      </Button>
      {open && <EnableFactoryDialog project={{ path: project, name: project.split('/').pop() || project }} onClose={() => setOpen(false)} startLocal={taskSource === 'hub'} />}
    </div>
  );
}
