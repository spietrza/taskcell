import { HOUR_MS, DEFAULT_MAX_AGE_HOURS } from './flags.js';
import type { Command } from './args.js';
import type { ParseCtx } from './flags.js';
import {
  reapContainers,
  dockerContainerLister,
  dockerContainerRemover,
  reapEgressNetworks,
  dockerEgressNetworkLister,
  dockerEgressNetworkRemover,
  pruneWorktrees,
  reapRemoteBranches,
  gitRemoteBranchLister,
  ghMergedPrChecker,
  ghAbandonedPrChecker,
  gitRemoteBranchRemover,
} from '../core/gc.js';

export interface GcCliOptions {
  repoPath: string;
  maxAgeMs: number;
  remoteRepo?: string;
  dryRun: boolean;
  /** Also delete branches whose PR is closed-unmerged (not just merged). */
  abandoned: boolean;
}

export interface GcReport {
  containers: string[];
  networks: string[];
  branches: string[];
}

const noop = async (): Promise<void> => undefined;

/**
 * Reap stale sandbox containers, prune worktree admin entries, and (when remoteRepo is set) delete
 * merged remote chore/taskcell-* (or pre-rename chore/vanguard-*) branches. dryRun swaps in no-op removers, so the reapers still report what
 * they WOULD remove without touching anything. The entry point behind `taskcell gc`.
 */
export async function runGc(opts: GcCliOptions): Promise<GcReport> {
  const containers = await reapContainers(
    dockerContainerLister(),
    opts.dryRun ? noop : dockerContainerRemover(),
    opts.maxAgeMs,
  );
  const networks = await reapEgressNetworks(
    dockerEgressNetworkLister(),
    opts.dryRun ? noop : dockerEgressNetworkRemover(),
  );
  if (!opts.dryRun) await pruneWorktrees(opts.repoPath);

  let branches: string[] = [];
  if (opts.remoteRepo !== undefined) {
    branches = await reapRemoteBranches(
      gitRemoteBranchLister(opts.repoPath),
      ghMergedPrChecker(opts.repoPath, opts.remoteRepo),
      opts.dryRun ? noop : gitRemoteBranchRemover(opts.repoPath),
      opts.maxAgeMs,
      opts.abandoned ? { abandoned: true, isAbandoned: ghAbandonedPrChecker(opts.repoPath, opts.remoteRepo) } : undefined,
    );
  }
  return { containers, networks, branches };
}

/** Parse `gc`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseGcCommand(ctx: ParseCtx): Command {
  const { values, repoPath } = ctx;
  const hours = Number(values['max-age-hours']);
  const maxAgeMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MAX_AGE_HOURS) * HOUR_MS;
  return {
    kind: 'gc',
    repoPath,
    maxAgeMs,
    dryRun: values['dry-run'] === true,
    abandoned: values.abandoned === true,
    ...(typeof values.remote === 'string' ? { remoteRepo: values.remote } : {}),
  };
}
