import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `research`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseResearchCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, builtinProvider, commitAuthor } = ctx;
  const issueRef = typeof values.github === 'string' ? values.github : positionals[1];
  if (issueRef === undefined) return { kind: 'help' };
  return {
    kind: 'research',
    issueRef,
    repoPath,
    egress: values.egress === true,
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(values.web === true ? { webAccess: true } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['research-model'] === 'string' ? { researchModel: values['research-model'] } : {}),
    ...(commitAuthor !== undefined ? { commitAuthor } : {}),
  };
}
