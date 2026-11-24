import { parseLimit, parseMaxDrop } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `eval`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseEvalCommand(ctx: ParseCtx): Command {
  const { values, repoPath } = ctx;
  const limit = parseLimit(values.limit);
  const maxDrop = parseMaxDrop(values['max-drop']);
  return {
    kind: 'eval',
    json: values.json === true,
    ...(typeof values['judge-model'] === 'string' ? { judgeModel: values['judge-model'] } : {}),
    ...(typeof values['produce-model'] === 'string' ? { produceModel: values['produce-model'] } : {}),
    suggest: values.suggest === true,
    repoPath,
    ...(limit !== undefined ? { limit } : {}),
    ...(typeof values.out === 'string' ? { out: values.out } : {}),
    ...(typeof values['github-repo'] === 'string' ? { githubRepo: values['github-repo'] } : {}),
    ...(typeof values.since === 'string' ? { since: values.since } : {}),
    ...(values.markdown === true ? { markdown: true } : {}),
    ...(typeof values.baseline === 'string' ? { baseline: values.baseline } : {}),
    ...(maxDrop !== undefined ? { maxDrop } : {}),
    allowCorpusChange: values['allow-corpus-change'] === true,
    saveBaseline: values['save-baseline'] === true,
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
  };
}
