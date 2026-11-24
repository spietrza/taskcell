import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `metrics`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseMetricsCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  if (positionals[1] !== 'push') return fail('metrics expects a subcommand: taskcell metrics push [--repo <path>] [--branch <name>].');
  return { kind: 'metrics', action: 'push', repoPath, ...(typeof values.branch === 'string' ? { branch: values.branch } : {}) };
}
