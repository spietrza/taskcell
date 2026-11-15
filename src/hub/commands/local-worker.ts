// Hub commands: Enable factory, "Local hub" — the per-project switch for the hub's built-in worker and its checklist. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { localWorkerState, runLocalDoctor, setLocalWorker } from '../local-worker.js';
import type { LocalWorkerState } from '../../wire.js';
import { defineCommands, repoTarget, requireString } from '../command-kit.js';

export interface LocalWorkerCommands {
  /** The Local hub checklist: the switch, whether a credential and a task source are there, the last doctor result, last pick-up and last error. No network. */
  local_worker_state: { args: { repoPath: string }; result: LocalWorkerState };
  /** HUB_ONLY: run the doctor's preflight checks on the hub's machine and keep the result in the checklist. */
  local_worker_doctor: { args: { repoPath: string }; result: LocalWorkerState };
  /** HUB_ONLY: turn the project's built-in worker on or off. On is refused, with the reason, for a project with no servable task source or no credential. Off stops new pick-ups and leaves a running task alone. */
  local_worker_set: { args: { repoPath: string; enabled: boolean }; result: LocalWorkerState };
}

export const commands = defineCommands<LocalWorkerCommands>({
  local_worker_state: async ({ ctx, args, allow }) => localWorkerState(ctx.configDir, await allow(requireString(args, 'repoPath')), ctx.userCredentials),
  local_worker_doctor: async ({ ctx, args, allow }) => {
    return runLocalDoctor(ctx.configDir, await allow(requireString(args, 'repoPath')), ctx.userCredentials);
  },
  local_worker_set: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    if (typeof args.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean');
    return setLocalWorker(ctx.configDir, real, args.enabled, ctx.userCredentials);
  },
}, {
  local_worker_state: { write: false, repo: 'repoPath' },
  local_worker_doctor: { write: true, remote: true, repo: 'repoPath', unaudited: 'writes only the doctor result into the hub\'s own store' },
  local_worker_set: { write: true, remote: true, repo: 'repoPath' },
}, {
  local_worker_set: { action: 'settings-change', target: repoTarget },
});
