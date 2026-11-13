import type { CostBreakdown } from './wire';

/** A run's cost for display: "unknown" when its metrics carry no cost data, never a made-up $0.00. */
export function costLabel(run: { totalCostUsd: number; costUnknown?: true }): string {
  return run.costUnknown === true ? 'unknown' : `$${run.totalCostUsd.toFixed(2)}`;
}

/** What kind of number a breakdown's cost is, in plain words. */
export function costKindNote(kind: CostBreakdown['costKind']): string {
  switch (kind) {
    case 'billed':
      return 'Billed cost: what the provider charged for these runs.';
    case 'estimated':
      return 'Estimated cost: token usage priced at API rates. On a subscription nothing is billed per token, so this is what the usage would cost.';
    case 'mixed':
      return 'A mix of billed and estimated cost (estimated = token usage priced at API rates; on a subscription nothing is billed per token).';
    case 'unknown':
      return 'These runs carry no cost data, so their cost is unknown.';
  }
}
