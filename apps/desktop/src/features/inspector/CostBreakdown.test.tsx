import { test, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { CostBreakdown } from './CostBreakdown';
import { costKindNote, costLabel } from '../../cost';
import type { CostBreakdown as Breakdown } from '../../wire';

afterEach(() => {
  clearMocks();
  delete window.__VANGUARD_HUB__;
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
