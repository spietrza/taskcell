import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `spec`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseSpecCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, builtinProvider, commitAuthor, maxTurns } = ctx;
  const issueRef = typeof values.github === 'string' ? values.github : positionals[1];
  if (issueRef === undefined) return { kind: 'help' };
  return {
    kind: 'spec',
    issueRef,
    repoPath,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(typeof values.base === 'string' ? { baseBranch: values.base } : {}),
    ...(typeof values.out === 'string' ? { out: values.out } : {}),
    ...(commitAuthor !== undefined ? { commitAuthor } : {}),
  };
}
