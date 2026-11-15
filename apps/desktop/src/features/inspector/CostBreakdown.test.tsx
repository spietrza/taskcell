import { test, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { CostBreakdown } from './CostBreakdown';
import { costKindNote, costLabel, EST_COST_NOTE, estTitle, rowCostLabel, totalCostLabel } from '../../cost';
import type { CostBreakdown as Breakdown } from '../../wire';

afterEach(() => {
  clearMocks();
  delete window.__TASKCELL_HUB__;
});

const ok = (period: string): Breakdown => ({
  status: 'ok', branch: 'taskcell-metrics', period: period as never, costKind: 'estimated', runs: 2, totalCostUsd: 3.5, unknownEntries: 1,
  byModel: [{ key: 'claude-sonnet-5-5', entries: 2, costUsd: 3.5, unknownEntries: 0 }, { key: 'claude-haiku-5-5', entries: 1, costUsd: 0, unknownEntries: 1 }],
  byStage: [{ key: 'implementer', entries: 3, costUsd: 3.5, unknownEntries: 1 }],
});

test('shows the breakdown by model and stage, says estimated, marks unpriced rows unknown, and re-reads on a period change', async () => {
  const periods: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== 'read_cost_breakdown') return undefined;
    periods.push((args as { period: string }).period);
    return ok((args as { period: string }).period);
  });
  render(<CostBreakdown project="/repo" />);
  expect(await screen.findByText('claude-sonnet-5-5')).toBeInTheDocument();
  expect(screen.getByText(/Estimated cost/)).toBeInTheDocument();
  expect(screen.getByText('unknown')).toBeInTheDocument();
  expect(screen.getByText('implementer')).toBeInTheDocument();
  expect(screen.getAllByText('$3.50').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  await screen.findByText('claude-sonnet-5-5');
  expect(periods).toEqual(['30d', '7d']);
});

test('a repo with no metrics branch gets a one-line explanation with the setup hint, not an error', async () => {
  mockIPC((cmd) => (cmd === 'read_cost_breakdown' ? { ...ok('all'), status: 'no-branch', byModel: [], byStage: [], hint: 'Run `taskcell metrics push` from CI.' } : undefined));
  render(<CostBreakdown project="/repo" />);
  expect(await screen.findByText(/No CI run metrics yet/)).toBeInTheDocument();
  expect(screen.getByText(/taskcell metrics push/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('cost helpers: unknown vs dollars, and a note per cost kind', () => {
  expect(costLabel({ totalCostUsd: 0, costUnknown: true })).toBe('unknown');
  expect(costLabel({ totalCostUsd: 0 })).toBe('$0.00');
  expect(costKindNote('billed')).toMatch(/Billed/);
  expect(costKindNote('unknown')).toMatch(/unknown/);
});

test('costLabel and totalCostLabel show an estimate marked ≈ instead of unknown', () => {
  expect(costLabel({ totalCostUsd: 0, costUnknown: true, estCostUsd: 1.234 })).toBe('≈$1.23');
  expect(costLabel({ totalCostUsd: 0, costUnknown: true })).toBe('unknown');
  expect(totalCostLabel({ totalCostUsd: 0, totalEstCostUsd: 2 })).toBe('≈$2.00');
  expect(totalCostLabel({ totalCostUsd: 1, totalEstCostUsd: 2 })).toBe('$1.00 + ≈$2.00');
});

test('a partly priced estimate says what is still unknown, and a run with reported and estimated stages shows both', () => {
  expect(costLabel({ totalCostUsd: 0, costUnknown: true, estCostUsd: 1.234, estPartial: true })).toBe('≈$1.23 + unknown');
  expect(costLabel({ totalCostUsd: 1.5, estCostUsd: 0.2 })).toBe('$1.50 + ≈$0.20');
  expect(costLabel({ totalCostUsd: 1.5, estCostUsd: 0.2, estPartial: true })).toBe('$1.50 + ≈$0.20 + unknown');
  expect(rowCostLabel({ costUsd: 0, entries: 2, unknownEntries: 2, estCostUsd: 0.4, estPartial: true })).toBe('≈$0.40 + unknown');
  expect(rowCostLabel({ costUsd: 1, entries: 3, unknownEntries: 2, estCostUsd: 0.4, estPartial: true })).toBe('$1.00 + ≈$0.40 + unknown');
  expect(totalCostLabel({ totalCostUsd: 0, totalEstCostUsd: 2, estPartial: true })).toBe('≈$2.00 + unknown');
  // Unchanged without an estimate.
  expect(rowCostLabel({ costUsd: 0, entries: 2, unknownEntries: 2 })).toBe('unknown');
  expect(rowCostLabel({ costUsd: 1, entries: 3, unknownEntries: 2 })).toBe('$1.00');
  expect(estTitle('≈$0.40')).toEqual({ title: EST_COST_NOTE });
  expect(estTitle('$0.40')).toEqual({});
});

test('the breakdown shows the estimate for an unknown-cost row, with the subscription note', async () => {
  mockIPC((cmd) =>
    cmd === 'read_cost_breakdown'
      ? { ...ok('30d'), costKind: 'unknown', totalCostUsd: 0, totalEstCostUsd: 0.4, byModel: [{ key: 'gpt-5', entries: 1, costUsd: 0, unknownEntries: 1, estCostUsd: 0.4 }], byStage: [] }
      : undefined,
  );
  render(<CostBreakdown project="/repo" />);
  expect(await screen.findByText('gpt-5')).toBeInTheDocument();
  expect(screen.getAllByText('≈$0.40').length).toBeGreaterThan(0);
  expect(screen.queryByText('unknown')).toBeNull();
  expect(screen.getByText(/not billed per token/)).toBeInTheDocument();
  expect(screen.queryByText(/their cost is unknown/)).toBeNull();
});
