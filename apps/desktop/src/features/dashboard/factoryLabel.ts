import type { FactoryState, FactoryStepId, LocalWorkerState } from '../../wire';

export const FACTORY_STEP_LABEL: Record<FactoryStepId, string> = {
  pr: 'Callers PR opened',
  secret: 'Secret set',
  merged: 'PR merged',
  doctor: 'Doctor passed',
};

/** A step's label in the code host's own word: a GitLab project has a merge request, not a PR. */
export const factoryStepLabel = (id: FactoryStepId, provider: 'github' | 'gitlab' | undefined): string =>
  provider === 'gitlab' ? FACTORY_STEP_LABEL[id].replace('PR', 'MR') : FACTORY_STEP_LABEL[id];

/** The project card's factory line: not enabled / setting up (current step) / ready / broken (reason). */
export function factoryLabel(f: FactoryState): string {
  switch (f.state) {
    case 'none':
      return 'Factory: not enabled';
    case 'setting-up':
      return `Factory: setting up — ${f.step ? factoryStepLabel(f.step, f.plan?.provider) : 'in progress'}`;
    case 'ready':
      return 'Factory: ready';
    case 'broken':
      return `Factory: broken — ${f.reason ?? 'unknown'}`;
  }
}

/** The project card's Local hub worker line: off / on with the last pick-up and the last error. */
export function localWorkerLabel(w: LocalWorkerState): string {
  const at = (iso: string): string => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : iso);
  const pick = w.lastPickupAt ? `last pick-up ${w.lastPickup ?? ''} ${at(w.lastPickupAt)}`.replace('  ', ' ') : undefined;
  if (!w.enabled) return pick ? `Local worker: off — ${pick}` : 'Local worker: off';
  return `Local worker: on — ${pick ?? 'no pick-up yet'}${w.lastError ? `; last error: ${w.lastError}` : ''}`;
}
