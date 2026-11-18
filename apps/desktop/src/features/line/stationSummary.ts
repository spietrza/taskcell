import type { Station } from '../../stations';
import { runLocationLabel, effectiveRunLocation, resolveTaskSource, taskSourceLabel } from '../../platform';
import type { AppConfig } from '../../taskcell-output';

/** The lines a station card shows: the saved values it owns, with what an unset value means. */
export function stationSummary(station: Station, cfg: AppConfig): string[] {
  switch (station) {
    case 'card': {
      const source = resolveTaskSource(cfg);
      // A Taskcell board card needs no trigger label: Start run (or auto-run) picks it up.
      const label = source === 'hub' ? [] : [`label "${cfg.label || 'ready for agent'}"`];
      return [...label, source === undefined ? 'no card source' : taskSourceLabel(source)];
    }
    case 'spec':
      return [cfg.flow ? `flow ${cfg.flow}` : 'standard flow (no custom flow)'];
    case 'cell':
      return [
        `engine ${cfg.provider || 'default'}`,
        cfg.budgetUsd ? `budget $${cfg.budgetUsd}` : 'no budget cap',
        `runner ${runLocationLabel(effectiveRunLocation(resolveTaskSource(cfg), cfg.runLocation))}`,
      ];
    case 'gates':
      return [cfg.verifyCmd || 'default verify', 'secret scan'];
    case 'review':
      return [cfg.reviewProvider ? `engine ${cfg.reviewProvider}` : 'same engine'];
    case 'pr':
      return [`target ${cfg.baseBranch || 'main'}`];
  }
}
