import { DEFAULT_PR_REVIEWING_LABEL, DEFAULT_PR_REVIEWED_LABEL, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `doctor-prs`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseDoctorPrsCommand(ctx: ParseCtx): Command {
  const { values, repoPath, builtinProvider, proxyMode } = ctx;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (repoSlug === undefined || label === undefined) return fail('doctor-prs requires --github-repo <owner/repo> and --label <name>.');
  return {
    kind: 'doctor-prs',
    repoSlug,
    repoPath,
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
  };
}
