// Hub commands: the cost of a project's CI factory runs, from its metrics branch. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { costBreakdown } from '../ci-metrics.js';
import type { CostBreakdown, CostPeriod } from '../../wire.js';
import { defineCommands, requireString, optionalString } from '../command-kit.js';

export interface CiCostCommands {
  /** HUB_ONLY, read-only: a project's cost by model and by stage for a period (default `all`), read from the metrics branch like `taskcell stats --branch`; cached, never a model call. A repo without the branch answers `status: 'no-branch'` with a setup hint. */
  read_cost_breakdown: { args: { repoPath: string; period?: CostPeriod }; result: CostBreakdown };
}

const PERIODS: readonly string[] = ['7d', '30d', 'all'];

export const commands = defineCommands<CiCostCommands>({
  read_cost_breakdown: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const period = optionalString(args, 'period') ?? 'all';
    if (!PERIODS.includes(period)) throw new BadRequestError("period must be '7d', '30d' or 'all'");
    return costBreakdown(real, period as CostPeriod);
  },
});
