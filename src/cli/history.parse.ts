import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `history`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseHistoryCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const groups = /^(?<repo>[^\s#/]+\/[^\s#/]+)#(?<number>\d+)$/.exec(positionals[1] ?? '')?.groups;
  if (groups === undefined || Number(groups['number']) < 1) return fail('history expects an issue reference: taskcell history owner/repo#N [--json].');
  return {
    kind: 'history',
    repoPath,
    repoSlug: groups['repo']!,
    issue: Number(groups['number']),
    json: values.json === true,
    offline: values.offline === true,
    ...(typeof values['config-dir'] === 'string' ? { configDir: values['config-dir'] } : {}),
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
  };
}
