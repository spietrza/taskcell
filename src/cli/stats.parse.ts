import { parseFeedbackAuthors, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { parseSince } from '../core/skill-stats.js';
import type { Command } from './args.js';

/** Parse `stats`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseStatsCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const statsRepo = values['github-repo'];
  // The slug lands in a `gh api repos/<slug>/...` path, so `..` segments or extra slashes are refused.
  if (typeof statsRepo === 'string' && (!/^[\w.-]+\/[\w.-]+$/.test(statsRepo) || statsRepo.split('/').some((p) => p === '.' || p === '..'))) {
    return fail(`stats --github-repo must be owner/repo, got '${statsRepo}'.`);
  }
  const statsFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
  if (values.skills === true && positionals.length > 1) return fail('stats --skills takes no value.');
  if (values.skills === true && (values.approver === true || statsRepo !== undefined || statsFeedbackAuthors !== undefined)) {
    return fail('stats --skills cannot be combined with --approver, --github-repo or --feedback-authors.');
  }
  if (values.skills === true && typeof values.since === 'string' && parseSince(values.since) === undefined) {
    return fail(`stats --since must look like 30d or 12h, got '${values.since}'.`);
  }
  return {
    kind: 'stats',
    repoPath,
    json: values.json === true,
    approver: values.approver === true,
    ...(values.skills === true ? { skills: true } : {}),
    // Without --skills, --since is accepted and ignored, as it always was on stats.
    ...(values.skills === true && typeof values.since === 'string' ? { since: values.since } : {}),
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    ...(typeof values['github-repo'] === 'string' ? { githubRepo: values['github-repo'] } : {}),
    ...(statsFeedbackAuthors !== undefined ? { feedbackAuthors: statsFeedbackAuthors } : {}),
  };
}
