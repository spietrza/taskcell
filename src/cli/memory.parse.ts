import { parseLimit } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `memory`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseMemoryCommand(ctx: ParseCtx): Command {
  const { values, repoPath } = ctx;
  const limit = parseLimit(values.limit);
  return {
    kind: 'memory',
    repoPath,
    ...(limit !== undefined ? { limit } : {}),
    json: values.json === true,
  };
}
