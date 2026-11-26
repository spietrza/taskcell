import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { approverPolicySchema } from './policy.js';

type Run = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;
export interface ApproverCheck {
  name: string;
  ok: boolean;
  reason?: string;
}

const fail = (name: string, reason: string): ApproverCheck => ({ name, ok: false, reason });

/** True when the repo carries an approver caller workflow (a repo that never adopted the approver gets no checks). */
async function hasApproverWorkflow(repoPath: string): Promise<boolean> {
  try {
    return (await readdir(join(repoPath, '.github', 'workflows'))).some((f) => /approver/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Approver readiness, only for a repo that uses it (an approver workflow, or a policy on the base branch): the policy is
 * readable on the base branch and passes the schema, and each `requiredChecks` entry is also a required status check in the
 * base branch's protection under the same app id. An unreadable protection (token without admin scope) is skipped, not failed.
 */
export async function approverDoctorChecks(run: Run, repoPath: string, repoSlug: string): Promise<ApproverCheck[]> {
  const gh = async (args: string[]): Promise<string | undefined> => {
    try {
      return (await run('gh', args, { cwd: repoPath })).stdout;
    } catch {
      return undefined;
    }
  };
  const baseRaw = await gh(['repo', 'view', repoSlug, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
  const base = baseRaw?.trim() ?? '';
  const workflow = await hasApproverWorkflow(repoPath);
  let raw: string | undefined;
  if (base !== '') {
    for (const dir of ['.taskcell', '.vanguard']) {
      try {
        raw = (await run('git', ['show', `origin/${base}:${dir}/approver.json`], { cwd: repoPath })).stdout;
        break;
      } catch {
        // try the legacy location
      }
    }
  }
  if (raw === undefined) return workflow ? [fail('approver policy', `.taskcell/approver.json is not readable on ${base === '' ? 'the default branch' : `origin/${base}`} (every PR would be ESCALATE policy-unreadable)`)] : [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [fail('approver policy', 'not valid JSON')];
  }
  const parsed = approverPolicySchema.safeParse(json);
  if (!parsed.success) return [fail('approver policy', `schema invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)];
  const checks: ApproverCheck[] = [{ name: 'approver policy', ok: true }];

  const protectionRaw = await gh(['api', `repos/${repoSlug}/branches/${base}/protection/required_status_checks`]);
  if (protectionRaw === undefined) return checks;
  let protection: { checks?: Array<{ context?: string; app_id?: number | null }> };
  try {
    protection = JSON.parse(protectionRaw) as typeof protection;
  } catch {
    return checks;
  }
  const required = protection.checks ?? [];
  const problems = parsed.data.requiredChecks.flatMap((rc) => {
    const match = required.find((c) => c.context === rc.name);
    if (match === undefined) return [`${rc.name} is not a required check on ${base}`];
    if (match.app_id !== rc.appId) return [`${rc.name}: policy app id ${rc.appId}, branch protection ${(match.app_id ?? -1) === -1 ? 'accepts any app' : match.app_id}`];
    return [];
  });
  checks.push(problems.length === 0 ? { name: 'approver requiredChecks', ok: true } : fail('approver requiredChecks', problems.join('; ')));
  return checks;
}
