// Hub commands: the approver's scorecard and auto-merge switch (project settings, task cards). One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { ACT_BLOCKING_ISSUES, approverPrDecisions, approverScorecard, openApproverModePr } from '../approver-card.js';
import type { ApproverModeChange, ApproverPeriod, ApproverPrDecision, ApproverScorecard } from '../../wire.js';
import { defineCommands, requireString, optionalString, repoTarget } from '../command-kit.js';

export interface ApproverCommands {
  /** HUB_ONLY, read-only: the approver's scorecard for a project over a period (default `90d`) — PRs judged, APPROVE/ESCALATE counts, right and wrong APPROVEs, the streak per risk class against the bar, the top escalation reasons — plus the current mode from `.taskcell/approver.json` on the base branch. Read from the metrics branch and GitHub PR state like `taskcell stats --approver`; never a model call. */
  read_approver_scorecard: { args: { repoPath: string; period?: ApproverPeriod }; result: ApproverScorecard };
  /** HUB_ONLY, read-only: what the approver decided for each PR on the metrics branch (merged, would merge, left for a human and why); no gh call. */
  read_approver_decisions: { args: { repoPath: string }; result: { decisions: ApproverPrDecision[] } };
  /** HUB_ONLY: open a pull request that sets `.taskcell/approver.json` to `mode` — never writes the setting itself. `act` is refused while the act switch is not offered, and below the bar unless `confirmBelowBar` is true; the PR body states the 90-day scorecard numbers at that moment. */
  set_approver_mode: { args: { repoPath: string; mode: 'off' | 'shadow' | 'act'; confirmBelowBar?: boolean }; result: ApproverModeChange };
}

const PERIODS: readonly string[] = ['30d', '90d', 'all'];
const MODES = ['off', 'shadow', 'act'] as const;

export const commands = defineCommands<ApproverCommands>({
  read_approver_scorecard: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const period = optionalString(args, 'period') ?? '90d';
    if (!PERIODS.includes(period)) throw new BadRequestError("period must be '30d', '90d' or 'all'");
    return approverScorecard(real, period as ApproverPeriod);
  },
  read_approver_decisions: async ({ args, allow }) => ({ decisions: await approverPrDecisions(await allow(requireString(args, 'repoPath'))) }),
  set_approver_mode: async ({ ctx, args, allow }) => {
    // Pushes a branch and opens a PR as the hub's `gh` identity — a mutation, like enable_factory_apply.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    const mode = requireString(args, 'mode');
    if (!(MODES as readonly string[]).includes(mode)) throw new BadRequestError("mode must be 'off', 'shadow' or 'act'");
    const target = mode as (typeof MODES)[number];
    // Always the server's own scorecard: the PR states the numbers as they are now, not what a client claims.
    const card = await approverScorecard(real, '90d');
    if (target === 'act') {
      if (ACT_BLOCKING_ISSUES.length > 0) throw new BadRequestError(`act mode is not available yet: waiting on ${ACT_BLOCKING_ISSUES.map((n) => `#${n}`).join(', ')}`);
      if (!card.barMet && args.confirmBelowBar !== true) {
        throw new BadRequestError('the approver has not met the bar (30 correct APPROVEs in a row in one risk class); confirm to open the PR anyway');
      }
    }
    return openApproverModePr({ repoPath: real, mode: target, card });
  },
}, {
  set_approver_mode: { action: 'approver-mode', target: repoTarget },
});
