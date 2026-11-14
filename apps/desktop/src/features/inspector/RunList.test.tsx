import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunList } from './RunList';
import type { ActiveRun, RunSummary } from '../../taskcell-output';

const noop = (): void => {};

test('renders a selectable row per run with task id and failure marker', () => {
  const runs: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement', 'review'], totalCostUsd: 0.17, anyFailed: true },
  ];
  render(<RunList runs={runs} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('task-7')).toBeInTheDocument();
  // "failed" appears on both the status chip and the filter button — assert at least one.
  expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
});

test('shows who started a run only when some run has startedBy', () => {
  const base: RunSummary = { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false };
  const { rerender } = render(<RunList runs={[base]} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.queryByText('Started by')).toBeNull();
  rerender(<RunList runs={[{ ...base, startedBy: 'alice' }]} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('Started by')).toBeInTheDocument();
  expect(screen.getByText('alice')).toBeInTheDocument();
});

test('renders in-flight runs as a running row', () => {
  const active: ActiveRun[] = [{ taskId: 'task-live', sessionFile: '/x.jsonl', lastActivityMs: Date.now() }];
  render(<RunList runs={[]} active={active} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('task-live')).toBeInTheDocument();
  expect(screen.getByText('running')).toBeInTheDocument();
});

test('renders an empty-state only when there are no runs and nothing in-flight', () => {
  render(<RunList runs={[]} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText(/No runs found/)).toBeInTheDocument();
});

test('names the repository on each row only under "All repositories"', () => {
  const runs = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false, repoPath: '/r/alpha', repoName: 'alpha' },
  ];
  const { rerender } = render(<RunList runs={runs} active={[]} showRepo onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('alpha')).toBeInTheDocument();
  rerender(<RunList runs={runs} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.queryByText('alpha')).not.toBeInTheDocument();
});

test('a CI run is marked, links its PR/MR, is not openable, and an unpriced one reads "unknown" not $0', () => {
  const onSelect = vi.fn();
  const ci: RunSummary = { taskId: 'ci-1', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implementer'], totalCostUsd: 0, anyFailed: false, source: 'ci', costUnknown: true, prUrl: 'https://github.com/o/r/pull/5' };
  const priced: RunSummary = { ...ci, taskId: 'ci-2', costUnknown: undefined, totalCostUsd: 1.5, prUrl: 'https://gitlab.com/o/r/-/merge_requests/9' } as RunSummary;
  render(<RunList runs={[ci, priced]} active={[]} onSelect={onSelect} onOpenActive={noop} />);
  expect(screen.getAllByText('run in CI')).toHaveLength(2);
  expect(screen.getByText('unknown')).toBeInTheDocument();
  expect(screen.queryByText('$0.00')).toBeNull();
  expect(screen.getByText('$1.50')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Open in GitHub/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/5');
  expect(screen.getByRole('link', { name: /Open in GitLab/ })).toHaveAttribute('href', 'https://gitlab.com/o/r/-/merge_requests/9');
  expect(screen.queryByText('CI run')).toBeNull();
  fireEvent.click(screen.getByText('ci-1'));
  expect(onSelect).not.toHaveBeenCalled();
});

test('a search that empties the list is named, with a button that clears it; the box says what it matches', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const onHub = vi.fn();
  const hub = { triage: 'all' as const, repos: [], sources: [], query: 'cart total', group: 'none' as const };
  render(<RunList runs={runs} active={[]} hub={hub} onHub={onHub} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByLabelText('Search task id')).toHaveValue('cart total');
  expect(screen.getByText('No runs match the search "cart total".')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(onHub).toHaveBeenCalledWith({ ...hub, query: '' });
});

test('a list emptied by another filter names the filters, with no Clear search that would bring nothing back', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const hub = { triage: 'all' as const, repos: [], sources: [], query: 'task', group: 'none' as const };
  render(<RunList runs={runs} active={[]} hub={hub} onHub={noop} onSelect={noop} onOpenActive={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'failed' }));
  expect(screen.getByText('No runs match the current filters.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
});

test('rows are keyboard stops: Enter opens a run, a CI-only row is not one', () => {
  const run: RunSummary = { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false };
  const onSelect = vi.fn();
  const onOpenActive = vi.fn();
  const active: ActiveRun[] = [{ taskId: 'task-live', sessionFile: '/x.jsonl', lastActivityMs: Date.now() }];
  render(<RunList runs={[run, { ...run, taskId: 'task-ci', source: 'ci' }]} active={active} onSelect={onSelect} onOpenActive={onOpenActive} />);
  const row = screen.getByText('task-7').closest('tr')!;
  expect(row).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(run);
  fireEvent.keyDown(screen.getByText('task-live').closest('tr')!, { key: ' ' });
  expect(onOpenActive).toHaveBeenCalledWith(active[0]);
  expect(screen.getByText('task-ci').closest('tr')).not.toHaveAttribute('tabindex');
});

test('the result pills say "All results", so Runs has one "All" (triage) beside the shared filter bar', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const hub = { triage: 'all' as const, repos: [], sources: [], query: '', group: 'none' as const };
  render(<RunList runs={runs} active={[]} hub={hub} onHub={noop} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getAllByRole('button', { name: 'All' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'All results' })).toBeInTheDocument();
});

test('a list emptied by filters names them; Clear filters resets search, source, triage and the result pill', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const onHub = vi.fn();
  const hub = { triage: 'needs' as const, repos: ['/a'], sources: ['gitlab' as const], query: 'task', group: 'project' as const };
  render(<RunList runs={runs} active={[]} hub={hub} onHub={onHub} onSelect={noop} onOpenActive={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'failed' }));
  expect(screen.getByText(/Active: Needs you, GitLab, Projects, search "task", Failed\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  // Projects and grouping are not filters this action owns.
  expect(onHub).toHaveBeenCalledWith({ ...hub, triage: 'all', sources: [], query: '' });
  expect(screen.getByRole('button', { name: 'All results' }).className).toContain('bg-primary');
});

test('the search box says it matches the task id only, here and on the Board that shares it', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const hub = { triage: 'all' as const, repos: [], sources: [], query: '', group: 'none' as const };
  render(<RunList runs={runs} active={[]} hub={hub} onHub={noop} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByLabelText('Search task id')).toHaveAttribute('title', expect.stringContaining('task id only'));
});
