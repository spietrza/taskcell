import { parseFeedbackAuthors, fail } from './flags.js';
import type { Command } from './args.js';
import type { ParseCtx } from './flags.js';

/** Parse `lessons`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseLessonsCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const branch = typeof values.branch === 'string' ? { branch: values.branch } : {};
  const action = positionals[1];
  if (action === 'list') return { kind: 'lessons', action, repoPath, json: values.json === true, ...branch };
  if (action === 'dismiss') {
    const id = positionals[2];
    if (id === undefined || !/^[0-9a-f]{12}$/.test(id)) return fail('lessons dismiss expects a lesson id (12 hex chars, see `taskcell lessons list`).');
    return { kind: 'lessons', action, repoPath, id, ...branch };
  }
  if (action === 'record') {
    const gitlabProject = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
    const numFlagName = gitlabProject !== undefined ? 'mr' : 'pr';
    const numFlag = values[numFlagName];
    const prRaw = typeof numFlag === 'string' ? numFlag : positionals[2];
    const prNumber = prRaw !== undefined ? Number(prRaw) : NaN;
    const repoSlug = gitlabProject ?? (typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined);
    if (repoSlug === undefined) return fail('lessons record requires --github-repo <owner/repo> or --gitlab-project <group/project>.');
    if (!Number.isInteger(prNumber) || prNumber < 1) {
      return fail(`lessons record requires a positive --${numFlagName} <n>, got "${String(prRaw)}".`);
    }
    const feedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    return {
      kind: 'lessons',
      action,
      repoPath,
      repoSlug,
      prNumber,
      ...(gitlabProject !== undefined ? { gitlab: true as const } : {}),
      dryRun: values['dry-run'] === true,
      ...(typeof values['provider-model'] === 'string' ? { model: values['provider-model'] } : {}),
      ...(feedbackAuthors !== undefined ? { feedbackAuthors } : {}),
      ...branch,
    };
  }
  return fail('lessons expects a subcommand: record --pr <n> --github-repo <o/r> (or --mr <n> --gitlab-project <g/p>) | list | dismiss <id>.');
}
