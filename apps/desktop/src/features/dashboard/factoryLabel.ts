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

/** A project's auto-run: on (where it runs) or off, with a short reason when it is broken or setting up. */
export interface AutoRun {
  on: boolean;
  text: string;
  /** `bad`: broken or erroring; colours the line red. */
  tone: 'on' | 'off' | 'bad';
}

/**
 * Auto-run, the one state a project tile shows. A hub-board project runs only while its worker switch is on (never
 * switched is off). A GitHub/GitLab project runs on this hub when the switch is on, else in CI once the factory is ready.
 */
export function autoRunLabel(taskSource: string | null | undefined, f: FactoryState | undefined, w: LocalWorkerState | undefined): AutoRun {
  if (w?.enabled === true) {
    return w.lastError ? { on: true, text: `Auto-run: on · this hub — last error: ${w.lastError}`, tone: 'bad' } : { on: true, text: 'Auto-run: on · this hub', tone: 'on' };
  }
  if (taskSource !== 'hub' && f) {
    if (f.state === 'ready') return { on: true, text: 'Auto-run: on · CI', tone: 'on' };
    if (f.state === 'broken') return { on: false, text: `Auto-run: off — CI broken: ${f.reason ?? 'unknown'}`, tone: 'bad' };
    if (f.state === 'setting-up') return { on: false, text: `Auto-run: off — setting up: ${f.step ? factoryStepLabel(f.step, f.plan?.provider) : 'in progress'}`, tone: 'off' };
  }
  return { on: false, text: 'Auto-run: off', tone: 'off' };
}

/** The project card's Local hub worker line: off / on with the last pick-up and the last error. */
export function localWorkerLabel(w: LocalWorkerState): string {
  const at = (iso: string): string => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : iso);
  const pick = w.lastPickupAt ? `last pick-up ${w.lastPickup ?? ''} ${at(w.lastPickupAt)}`.replace('  ', ' ') : undefined;
  if (!w.enabled) return pick ? `Local worker: off — ${pick}` : 'Local worker: off';
  return `Local worker: on — ${pick ?? 'no pick-up yet'}${w.lastError ? `; last error: ${w.lastError}` : ''}`;
}
