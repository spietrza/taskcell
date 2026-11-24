import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { readIssueHistory, formatHistoryText } from '../core/history.js';
import { defaultHubConfigDir } from '../hub/audit.js';
import type { Command } from './args.js';

type HistoryCommand = Extract<Command, { kind: 'history' }>;

/** `taskcell history owner/repo#N [--json]`: the issue's history over the audit streams. */
export async function historyCommand(cmd: HistoryCommand): Promise<void> {
  const history = await readIssueHistory({
    repoPath: cmd.repoPath,
    repo: cmd.repoSlug,
    issue: cmd.issue,
    hubConfigDir: cmd.configDir ?? defaultHubConfigDir(),
    ...(cmd.branch !== undefined ? { branch: cmd.branch } : {}),
    offline: cmd.offline,
  });
  process.stdout.write(cmd.json ? `${JSON.stringify(history, null, 2)}\n` : formatHistoryText(history));
  if (history.chains.some((c) => !c.ok)) process.exitCode = 1;
}

/** Parse `history`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseHistoryCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const groups = /^(?<repo>[^\s#/]+\/[^\s#/]+)#(?<number>\d+)$/.exec(positionals[1] ?? '')?.groups;
  if (groups === undefined || Number(groups['number']) < 1) return fail('history expects an issue reference: taskcell history owner/repo#N [--json].');
  return {
    kind: 'history',
    repoPath,
    repoSlug: groups['repo']!,
    issue: Number(groups['number']),
    json: values.json === true,
    offline: values.offline === true,
    ...(typeof values['config-dir'] === 'string' ? { configDir: values['config-dir'] } : {}),
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
  };
}
