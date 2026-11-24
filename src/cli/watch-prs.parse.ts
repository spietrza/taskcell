import { parseFeedbackAuthors, DEFAULT_CONCURRENCY, DEFAULT_PR_REVIEWING_LABEL, DEFAULT_PR_REVIEWED_LABEL, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `watch-prs`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseWatchPrsCommand(ctx: ParseCtx): Command {
  const { values, repoPath, builtinProvider, maxTurns, proxyMode } = ctx;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (repoSlug === undefined || label === undefined) return fail('watch-prs requires --github-repo <owner/repo> and --label <name>.');
  const concurrency = Number(values.concurrency);
  const interval = Number(values.interval);
  const prNumber = typeof values.pr === 'string' ? Number(values.pr) : undefined;
  if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) {
    return fail('watch-prs --pr expects a positive PR number.');
  }
  const prFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  return {
    kind: 'watch-prs',
    ...(prFeedbackAuthors !== undefined ? { feedbackAuthors: prFeedbackAuthors } : {}),
    repoSlug,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    once: values.once === true,
    egress: values.egress === true,
    ...(typeof values.author === 'string' ? { author: values.author } : {}),
    ...(prNumber !== undefined ? { pr: prNumber } : {}),
    ...(values['pinned-only'] === true ? { pinnedOnly: true } : {}),
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
