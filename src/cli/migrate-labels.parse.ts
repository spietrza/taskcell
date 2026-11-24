import { fail } from './flags.js';
import type { Command } from './args.js';
import type { ParseCtx } from './flags.js';

/** Parse `migrate-labels`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseMigrateLabelsCommand(ctx: ParseCtx): Command {
  const { values } = ctx;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  if (repoSlug === undefined) return fail('migrate-labels requires --github-repo <owner/repo>.');
  return { kind: 'migrate-labels', repoSlug, apply: values.apply === true };
}
