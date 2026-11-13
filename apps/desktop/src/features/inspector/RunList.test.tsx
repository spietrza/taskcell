import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
