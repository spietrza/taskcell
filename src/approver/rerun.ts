import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { runApprover } from './approve.js';
import type { RunApproverInput, RunApproverResult } from './approve.js';
import { collectPrFacts, isFactoryPr } from './facts.js';
import { FACTORY_BRANCH_PREFIXES } from '../worktree/manager.js';
import { loadPolicy } from './policy.js';
import { redactForPublish } from '../core/secret-scan.js';

export interface RerunOpenInput extends Omit<RunApproverInput, 'prNumber' | 'mode'> {
  mode: 'shadow' | 'enforce';
}

export interface RerunOpenResult {
  judged: Array<{ prNumber: number; result: RunApproverResult }>;
  failed: Array<{ prNumber: number; error: string }>;
}

/**
 * Re-judge every open factory PR into the default branch (the PRs the approver workflow judges), e.g. after a policy
 * change or a switch to enforce. Each PR goes through the normal `runApprover`: the check run is updated in place and a
 * decision is appended only where (PR, head, policy hash) is new, so an unchanged policy appends nothing. One PR failing
 * does not stop the rest.
 */
export async function rerunOpenPrs(input: RerunOpenInput): Promise<RerunOpenResult> {
  const gh: GhRunner = input.gh ?? defaultGhRunner;
  const defaultBranch = (await gh(['repo', 'view', input.repoSlug, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim();
  const listed = JSON.parse(await gh(['pr', 'list', '--repo', input.repoSlug, '--state', 'open', '--limit', '200', '--json', 'number,baseRefName'])) as Array<{ number: number; baseRefName: string }>;
  const result: RerunOpenResult = { judged: [], failed: [] };
  for (const { number, baseRefName } of listed) {
    if (baseRefName !== defaultBranch) continue;
    try {
      const pr = await collectPrFacts(gh, input.repoSlug, number);
      const loaded = await loadPolicy(input.repoPath, baseRefName);
      // Without a readable policy the configured prefix is unknown: fall back to the two factory prefixes, so a human's PR is never judged.
      const factory = loaded !== undefined ? isFactoryPr(pr, input.repoSlug, loaded.policy) : pr.headRepo === input.repoSlug && FACTORY_BRANCH_PREFIXES.some((p) => pr.headRefName.startsWith(p));
      if (!factory) continue;
      result.judged.push({ prNumber: number, result: await runApprover({ ...input, gh, prNumber: number }) });
    } catch (err) {
      result.failed.push({ prNumber: number, error: redactForPublish(err instanceof Error ? err.message : String(err)) });
    }
  }
  return result;
}
