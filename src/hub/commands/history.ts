// Hub commands: per-issue history. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { readIssueHistory } from '../../core/history.js';
import type { IssueHistory } from '../../wire.js';
import { defineCommands, requireString, optionalNumber, actorOf, githubSlug } from '../command-kit.js';

export interface HistoryCommands {
  /** HUB_ONLY, read-only: one issue's history over the audit streams, run records and Git host events
   *  (docs/audit.md § Issue history). The hub's own audit lines are included for an admin only. */
  read_issue_history: { args: { repoPath: string; issue: number }; result: IssueHistory };
}

export const commands = defineCommands<HistoryCommands>({
  read_issue_history: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const issue = optionalNumber(args, 'issue');
    if (issue === undefined || !Number.isInteger(issue) || issue < 1) throw new BadRequestError('issue is required and must be a positive integer');
    const repo = await githubSlug(real);
    if (repo === undefined) throw new BadRequestError('the project has no GitHub origin to read the issue history from');
    return readIssueHistory({ repoPath: real, repo, localRepo: repo, issue, ...(actorOf(ctx).admin ? { hubConfigDir: ctx.configDir } : {}) });
  },
});
