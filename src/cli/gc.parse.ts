import { HOUR_MS, DEFAULT_MAX_AGE_HOURS } from './flags.js';
import type { Command } from './args.js';
import type { ParseCtx } from './flags.js';

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
