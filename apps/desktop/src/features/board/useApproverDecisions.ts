import { useAsync } from '../../hooks';
import { hub } from '../../transport';
import type { ApproverMode, ApproverPrDecision, RunSummary } from '../../wire';

type ApproverDecisions = { runs: RunSummary[]; decisions: ApproverPrDecision[]; mode: ApproverMode };
const EMPTY: ApproverDecisions = { runs: [], decisions: [], mode: 'shadow' };

/** Hub only: the approver's per-PR decisions and the project's runs (the task → PR link). Empty elsewhere or on failure. */
export function useApproverDecisions(project: string, enabled = true): ApproverDecisions {
  const { data } = useAsync(
    async () => {
      if (!enabled) return EMPTY;
      const [runs, d] = await Promise.all([hub().call('list_runs', { repoPath: project }), hub().call('read_approver_decisions', { repoPath: project })]);
      return { runs, decisions: d.decisions, mode: d.mode };
    },
    [project, enabled],
  );
  return data ?? EMPTY;
}
