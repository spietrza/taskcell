import { parseDependencyRepos, fail } from './flags.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { Command } from './args.js';
import type { ParseCtx } from './flags.js';

/** Parse `resume-rate-limited`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseResumeRateLimitedCommand(ctx: ParseCtx): Command {
  const { values } = ctx;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  if (repoSlug === undefined) return fail('resume-rate-limited requires --github-repo <owner/repo>.');
  const raw = values['trigger-labels'];
  const triggerLabels = typeof raw === 'string' ? raw.split(',').map((l) => l.trim()).filter((l) => l !== '') : [];
  // A waiting issue carrying one of these already started; custom names must match the watch's.
  const started = [
    [values['claimed-state'], GITHUB_CLAIMED_LABEL],
    [values['review-state'], GITHUB_REVIEW_LABEL],
    [values['spec-claimed-label'], GITHUB_SPEC_CLAIMED_LABEL],
  ] as const;
  const startedLabels = started.some(([v]) => typeof v === 'string')
    ? started.map(([v, fallback]) => (typeof v === 'string' ? v : fallback))
    : undefined;
  return {
    kind: 'resume-rate-limited',
    repoSlug,
    dryRun: values['dry-run'] === true,
    ...(values['no-ci-watch'] === true ? { ciWatch: false } : {}),
    ...(triggerLabels.length > 0 ? { triggerLabels } : {}),
    ...parseDependencyRepos(values['dependency-repos']),
    ...(startedLabels !== undefined ? { startedLabels } : {}),
  };
}
