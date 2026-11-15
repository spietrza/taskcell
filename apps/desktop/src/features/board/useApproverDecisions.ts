import { useAsync } from '../../hooks';
import { isHubMode } from '../../transport';
import { listRuns, readApproverDecisions } from '../../ipc';
import type { ApproverMode, ApproverPrDecision, RunSummary } from '../../wire';

type ApproverDecisions = { runs: RunSummary[]; decisions: ApproverPrDecision[]; mode: ApproverMode };
const EMPTY: ApproverDecisions = { runs: [], decisions: [], mode: 'shadow' };

/** Hub only: the approver's per-PR decisions and the project's runs (the task → PR link). Empty elsewhere or on failure. */
export function useApproverDecisions(project: string, enabled = true): ApproverDecisions {
  const { data } = useAsync(
    async () => {
      if (!enabled || !isHubMode()) return EMPTY;
      const [runs, d] = await Promise.all([listRuns(project), readApproverDecisions(project)]);
      return { runs, decisions: d.decisions, mode: d.mode };
    },
    [project, enabled],
  );
  return data ?? EMPTY;
}
