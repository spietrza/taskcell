import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `review-mr`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseReviewMrCommand(ctx: ParseCtx): Command {
  const { values, repoPath, builtinProvider, maxTurns } = ctx;
  const iidRaw = typeof values.mr === 'string' ? Number(values.mr) : undefined;
  const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
  if (iidRaw === undefined || !Number.isInteger(iidRaw) || project === undefined) return { kind: 'help' };
  return {
    kind: 'review-mr',
    iid: iidRaw,
    project,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
