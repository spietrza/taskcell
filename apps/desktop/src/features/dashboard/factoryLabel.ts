import type { FactoryState, FactoryStepId } from '../../wire';

export const FACTORY_STEP_LABEL: Record<FactoryStepId, string> = {
  pr: 'Callers PR opened',
  secret: 'Secret set',
  merged: 'PR merged',
  doctor: 'Doctor passed',
};

/** The project card's factory line: not enabled / setting up (current step) / ready / broken (reason). */
export function factoryLabel(f: FactoryState): string {
  switch (f.state) {
    case 'none':
      return 'Factory: not enabled';
    case 'setting-up':
      return `Factory: setting up — ${f.step ? FACTORY_STEP_LABEL[f.step] : 'in progress'}`;
    case 'ready':
      return 'Factory: ready';
    case 'broken':
      return `Factory: broken — ${f.reason ?? 'unknown'}`;
  }
}
