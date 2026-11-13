import type { ApproverPrDecision, RunSummary } from '../../wire';
import { taskRefKey } from './taskref';

/** The PR number a run's https PR URL names, or undefined. */
export function prNumberOf(prUrl: string | undefined): number | undefined {
  const m = prUrl?.match(/\/(?:pull|pull-requests|merge_requests)\/(\d+)(?:[/?#].*)?$/);
  return m ? Number(m[1]) : undefined;
}

/** The approver's decision for a task: via the newest run of the task that opened a PR. */
export function decisionForTask(taskId: string, runs: RunSummary[], decisions: ApproverPrDecision[]): ApproverPrDecision | undefined {
  const key = taskRefKey(taskId);
  const pr = runs
    .filter((r) => taskRefKey(r.taskId) === key)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((r) => prNumberOf(r.prUrl))
    .find((n) => n !== undefined);
  return decisions.find((d) => d.prNumber === pr);
}

export function decisionWords(d: ApproverPrDecision): string {
  if (d.outcome === 'merged') return 'Merged automatically';
  if (d.outcome === 'would-merge') return 'Approver approved it (shadow mode: left for you to merge)';
  return `Left for you: ${d.reasons.length > 0 ? d.reasons.join(', ') : 'no reason recorded'}`;
}
