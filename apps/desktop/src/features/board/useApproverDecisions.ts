import { useAsync } from '../../hooks';
import { isHubMode } from '../../transport';
import { listRuns, readApproverDecisions } from '../../ipc';
import type { ApproverPrDecision, RunSummary } from '../../wire';

/** Hub only: the approver's per-PR decisions and the project's runs (the task → PR link). Empty elsewhere or on failure. */
export function useApproverDecisions(project: string, enabled = true): { runs: RunSummary[]; decisions: ApproverPrDecision[] } {
  const { data } = useAsync(
    async () => {
      if (!enabled || !isHubMode()) return { runs: [], decisions: [] };
      const [runs, d] = await Promise.all([listRuns(project), readApproverDecisions(project)]);
      return { runs, decisions: d.decisions };
    },
    [project, enabled],
  );
  return data ?? { runs: [], decisions: [] };
}
