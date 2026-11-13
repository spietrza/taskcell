import { runApprover } from '../approver/approve.js';
import type { Command } from './args.js';

type ApproveCommand = Extract<Command, { kind: 'approve' }>;

/** `taskcell approve --pr <n> --github-repo <slug>`: compute, publish, and record the decision; in `--mode act` (policy `act: true`) also update and merge. */
export async function approveCommand(cmd: ApproveCommand): Promise<void> {
  try {
    const result = await runApprover({
      repoPath: cmd.repoPath,
      repoSlug: cmd.repoSlug,
      prNumber: cmd.prNumber,
      mode: cmd.mode,
      dryRun: cmd.dryRun,
      ...(cmd.branch !== undefined ? { branch: cmd.branch } : {}),
    });
    if (cmd.json) {
      console.log(JSON.stringify(result.record));
    } else {
      const rules = result.record.rulesFired.length > 0 ? ` (${result.record.rulesFired.join(', ')})` : '';
      console.log(`taskcell approve: ${result.record.verdict}${rules}`);
    }
  } catch (error) {
    console.error(`taskcell approve: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
