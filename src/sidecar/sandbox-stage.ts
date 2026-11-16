import type { RunEvent } from '../pipeline/events.js';

/** The container start, shown as the first stage of a hub run. */
export const SANDBOX_STAGE = 'sandbox';

/**
 * Wrap a run's event sink so the sandbox is the run's first stage: `run-start` lists it first and the
 * pipeline's stage events shift by one to stay aligned with that list. The sandbox's own start/end
 * events are emitted by the caller on the raw sink, before the run (and so `run-start`) exists.
 */
export function withSandboxStage(onEvent: (e: RunEvent) => void): (e: RunEvent) => void {
  return (e) => {
    if (e.type === 'run-start') onEvent({ ...e, stages: [SANDBOX_STAGE, ...e.stages] });
    else if (e.type === 'stage-start' || e.type === 'stage-end') onEvent({ ...e, index: e.index + 1, of: e.of + 1 });
    else onEvent(e);
  };
}
