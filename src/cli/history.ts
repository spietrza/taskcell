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
