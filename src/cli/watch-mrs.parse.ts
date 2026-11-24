import { DEFAULT_CONCURRENCY, DEFAULT_GITLAB_MR_REVIEWING_LABEL, DEFAULT_GITLAB_MR_REVIEWED_LABEL } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `watch-mrs`'s flags into its command; the generic checks (parseCli) have already run. */
export const parseWatchMrsCommand = (ctx: ParseCtx): Command => parseWatchMrsFlags(ctx, 'watch-mrs');

/** Parse `doctor-mrs`'s flags into its command. */
export const parseDoctorMrsCommand = (ctx: ParseCtx): Command => parseWatchMrsFlags(ctx, 'doctor-mrs');

function parseWatchMrsFlags(ctx: ParseCtx, commandKind: 'watch-mrs' | 'doctor-mrs'): Command {
  const { values, repoPath, builtinProvider, maxTurns } = ctx;
  const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (project === undefined || label === undefined) return { kind: 'help' };
  const concurrency = Number(values.concurrency);
  const interval = Number(values.interval);
  const shared = {
    project,
    repoPath,
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_GITLAB_MR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_GITLAB_MR_REVIEWED_LABEL,
    ...(typeof values.author === 'string' ? { author: values.author } : {}),
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
  };
  if (commandKind === 'doctor-mrs') return { kind: 'doctor-mrs', ...shared };
  return {
    kind: 'watch-mrs',
    ...shared,
    ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
    egress: values.egress === true,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    once: values.once === true,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
