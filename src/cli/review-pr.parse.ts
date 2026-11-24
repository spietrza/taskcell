import { parseFeedbackAuthors, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `review-pr`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseReviewPrCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, builtinProvider, maxTurns, proxyMode } = ctx;
  // Accept the PR ref as a positional, --github-pr <n>, or --github <ref> — the last for parity with
  // spec/run/research, which all take --github (a natural thing to reach for).
  const prRef =
    typeof values['github-pr'] === 'string'
      ? values['github-pr']
      : typeof values.github === 'string'
      ? values.github
      : positionals[1];
  if (prRef === undefined) {
    return fail('review-pr requires a PR reference: a URL, owner/repo#number, --github <ref>, or --github-pr <number>.');
  }
  const reviewFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  return {
    kind: 'review-pr',
    ...(reviewFeedbackAuthors !== undefined ? { feedbackAuthors: reviewFeedbackAuthors } : {}),
    prRef,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(typeof values.out === 'string' ? { out: values.out } : {}),
  };
}
