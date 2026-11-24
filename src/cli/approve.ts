import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { runApprover } from '../approver/approve.js';
import { repoNodeId } from '../approver/repo-id.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { Command } from './args.js';

type ApproveCommand = Extract<Command, { kind: 'approve' }>;

/** `taskcell approve --pr <n> --github-repo <slug>`: compute, publish, and record the decision; in `--mode act` (policy `act: true`) also update and merge. */
export async function approveCommand(cmd: ApproveCommand): Promise<void> {
  try {
    const repoId = cmd.dryRun ? undefined : await repoNodeId(cmd.repoSlug);
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

/** Parse `approve`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseApproveCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const prRaw = typeof values.pr === 'string' ? values.pr : positionals[1];
  const prNumber = prRaw !== undefined ? Number(prRaw) : NaN;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  if (repoSlug === undefined) return fail('approve requires --github-repo <owner/repo>.');
  if (!Number.isInteger(prNumber) || prNumber < 1) return fail(`approve requires a positive --pr <n>, got "${String(prRaw)}".`);
  const modeRaw = typeof values.mode === 'string' ? values.mode : 'shadow';
  if (modeRaw !== 'shadow' && modeRaw !== 'act') return fail(`approve: unknown --mode "${modeRaw}" (shadow or act).`);
  return {
    kind: 'approve',
    prNumber,
    repoSlug,
    repoPath,
    mode: modeRaw,
    json: values.json === true,
    dryRun: values['dry-run'] === true,
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
  };
}
