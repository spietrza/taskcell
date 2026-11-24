import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `approve`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseApproveCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const prRaw = typeof values.pr === 'string' ? values.pr : positionals[1];
  const prNumber = prRaw !== undefined ? Number(prRaw) : NaN;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  if (repoSlug === undefined) return fail('approve requires --github-repo <owner/repo>.');
  if (!Number.isInteger(prNumber) || prNumber < 1) return fail(`approve requires a positive --pr <n>, got "${String(prRaw)}".`);
  const modeRaw = typeof values.mode === 'string' ? values.mode : 'shadow';
  if (modeRaw !== 'shadow' && modeRaw !== 'act') return fail(`approve: unknown --mode "${modeRaw}" (shadow or act).`);
  return {
    kind: 'approve',
    prNumber,
    repoSlug,
    repoPath,
    mode: modeRaw,
    json: values.json === true,
    dryRun: values['dry-run'] === true,
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
  };
}
