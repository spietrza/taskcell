import type { CostBreakdown } from './wire';

/** Reported dollars, the `≈` estimate, and "unknown" for what has neither: whichever apply, joined with " + ". */
function parts(reported: string | undefined, estUsd: number | undefined, unknown: boolean): string {
  const est = estUsd !== undefined && estUsd > 0 ? `≈$${estUsd.toFixed(2)}` : undefined;
  const shown = [reported, est, unknown || (reported === undefined && est === undefined) ? 'unknown' : undefined];
  return shown.filter((p) => p !== undefined).join(' + ');
}

/** A run's cost for display: "unknown" when its metrics carry no cost data, never a made-up $0.00. */
export function costLabel(run: { totalCostUsd: number; costUnknown?: true; estCostUsd?: number; estPartial?: true }): string {
  return parts(run.costUnknown === true ? undefined : `$${run.totalCostUsd.toFixed(2)}`, run.estCostUsd, run.estPartial === true);
}

/** One-line explanation shown wherever a `≈` estimate stands in for a missing reported cost. */
export const EST_COST_NOTE = '≈ = estimate at API prices; a subscription run is not billed per token.';

/** Spread onto the element showing a cost label: the explanation as a tooltip when the label carries an estimate. */
export function estTitle(label: string): { title?: string } {
  return label.includes('≈') ? { title: EST_COST_NOTE } : {};
}

/** A breakdown row's cost: reported, estimate only, or both when some entries lack a reported cost. */
export function rowCostLabel(r: { costUsd: number; entries: number; unknownEntries: number; estCostUsd?: number; estPartial?: true }): string {
  return parts(r.unknownEntries === r.entries ? undefined : `$${r.costUsd.toFixed(2)}`, r.estCostUsd, r.estPartial === true);
}

/** The breakdown's headline: reported cost, plus the estimate when some entries lack one (just the estimate if nothing was reported). */
export function totalCostLabel(b: { totalCostUsd: number; totalEstCostUsd?: number; estPartial?: true }): string {
  if (b.totalEstCostUsd === undefined) return `$${b.totalCostUsd.toFixed(2)}`;
  return parts(b.totalCostUsd > 0 ? `$${b.totalCostUsd.toFixed(2)}` : undefined, b.totalEstCostUsd, b.estPartial === true);
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
