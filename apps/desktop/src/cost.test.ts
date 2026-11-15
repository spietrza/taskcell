import { describe, expect, it } from 'vitest';
import { costLabel } from './cost';

describe('costLabel', () => {
  it('marks a reported-cost run with an unpriced stage as partial', () => {
    expect(costLabel({ totalCostUsd: 1.5, estPartial: true })).toBe('$1.50 + unknown');
  });
  it('does not render a sub-half-cent estimate as ≈$0.00', () => {
    expect(costLabel({ totalCostUsd: 0, costUnknown: true, estCostUsd: 0.003 })).toBe('≈<$0.01');
    expect(costLabel({ totalCostUsd: 0, costUnknown: true, estCostUsd: 0.02 })).toBe('≈$0.02');
  });
});
