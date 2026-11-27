import { parseFeedbackAuthors, parseLimit } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `revise-pr`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseRevisePrCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, fallbackProvider, fallbackModel, builtinProvider, commitAuthor } = ctx;
  const prRef =
    typeof values['github-pr'] === 'string'
      ? values['github-pr']
      : typeof values.github === 'string'
      ? values.github
      : positionals[1];
  if (prRef === undefined) return { kind: 'help' };
  const maxRounds = parseLimit(values['max-rounds']);
  const feedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  return {
    kind: 'revise-pr',
    ...(feedbackAuthors !== undefined ? { feedbackAuthors } : {}),
    prRef,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(typeof values['gitlab-project'] === 'string' ? { gitlabProject: values['gitlab-project'] } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    ...(typeof values['provider-model'] === 'string' ? { providerModel: values['provider-model'] } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(commitAuthor !== undefined ? { commitAuthor } : {}),
    ...(typeof values.out === 'string' ? { out: values.out } : {}),
  };
}
