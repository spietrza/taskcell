import { runApprover } from '../approver/approve.js';
import { rerunOpenPrs } from '../approver/rerun.js';
import { repoNodeId } from '../approver/repo-id.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { Command } from './args.js';

type ApproveCommand = Extract<Command, { kind: 'approve' }>;

/** `taskcell approve --pr <n> --github-repo <slug>`: compute, publish, and record the decision; in `--mode act` (policy `act: true`) also update and merge. */
export async function approveCommand(cmd: ApproveCommand): Promise<void> {
  try {
    const repoId = cmd.dryRun ? undefined : await repoNodeId(cmd.repoSlug);
    if (cmd.rerunOpen === true && cmd.mode !== 'act') {
      const { judged, failed } = await rerunOpenPrs({
        repoPath: cmd.repoPath,
        repoSlug: cmd.repoSlug,
        ...(repoId !== undefined ? { repoId } : {}),
        mode: cmd.mode,
        dryRun: cmd.dryRun,
        ...(cmd.branch !== undefined ? { branch: cmd.branch } : {}),
      });
      if (cmd.json) console.log(JSON.stringify({ judged: judged.map((j) => j.result.record), failed }));
      else {
        for (const j of judged) console.log(`taskcell approve: #${j.prNumber} ${j.result.record.verdict}`);
        for (const f of failed) console.error(`taskcell approve: #${f.prNumber} failed: ${f.error}`);
        console.log(`taskcell approve: re-judged ${judged.length} open factory PR(s), ${failed.length} failed`);
      }
      if (failed.length > 0) process.exitCode = 1;
      return;
    }
    const result = await runApprover({
      repoPath: cmd.repoPath,
      repoSlug: cmd.repoSlug,
      ...(repoId !== undefined ? { repoId } : {}),
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
    // The workflow log is public to everyone who can read the repo: a gh error can carry a token URL.
    console.error(`taskcell approve: ${redactForPublish(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
