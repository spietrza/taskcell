import type { CostBreakdown } from './wire';

/** A run's cost for display: "unknown" when its metrics carry no cost data, never a made-up $0.00. */
export function costLabel(run: { totalCostUsd: number; costUnknown?: true; estCostUsd?: number }): string {
  if (run.costUnknown === true) return run.estCostUsd !== undefined && run.estCostUsd > 0 ? `≈$${run.estCostUsd.toFixed(2)}` : 'unknown';
  return `$${run.totalCostUsd.toFixed(2)}`;
}

/** One-line explanation shown wherever a `≈` estimate stands in for a missing reported cost. */
export const EST_COST_NOTE = '≈ = estimate at API prices; a subscription run is not billed per token.';

/** A breakdown row's cost: reported, estimate only, or both when some entries lack a reported cost. */
export function rowCostLabel(r: { costUsd: number; entries: number; unknownEntries: number; estCostUsd?: number }): string {
  const est = r.estCostUsd !== undefined ? `≈$${r.estCostUsd.toFixed(2)}` : undefined;
  if (r.unknownEntries === r.entries) return est ?? 'unknown';
  const reported = `$${r.costUsd.toFixed(2)}`;
  return est === undefined ? reported : `${reported} + ${est}`;
}

/** The breakdown's headline: reported cost, plus the estimate when some entries lack one (just the estimate if nothing was reported). */
export function totalCostLabel(b: { totalCostUsd: number; totalEstCostUsd?: number }): string {
  if (b.totalEstCostUsd === undefined) return `$${b.totalCostUsd.toFixed(2)}`;
  const est = `≈$${b.totalEstCostUsd.toFixed(2)}`;
  return b.totalCostUsd > 0 ? `$${b.totalCostUsd.toFixed(2)} + ${est}` : est;
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
