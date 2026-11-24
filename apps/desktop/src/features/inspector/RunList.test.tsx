import { withOutcome, withOutcomeLoose } from '../../dev/fixtureOutcome';
import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunList } from './RunList';
import { titleKey } from '../../runLabels';
import type { ActiveRun, RunSummary } from '../../taskcell-output';

const noop = (): void => {};

test('renders a selectable row per run with task id and failure marker', () => {
  const runs: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement', 'review'], totalCostUsd: 0.17, anyFailed: true },
  ];
  render(<RunList runs={runs.map(withOutcome)} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('task-7')).toBeInTheDocument();
  // "failed" appears on both the status chip and the filter button — assert at least one.
  expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
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
  const { rerender } = render(<RunList runs={runs.map(withOutcome)} active={[]} showRepo onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('alpha')).toBeInTheDocument();
  rerender(<RunList runs={runs.map(withOutcome)} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.queryByText('alpha')).not.toBeInTheDocument();
});

test('a CI run is marked, links its PR/MR, is not openable, and an unpriced one reads "unknown" not $0', () => {
  const onSelect = vi.fn();
  const ci: RunSummary = { taskId: 'ci-1', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implementer'], totalCostUsd: 0, anyFailed: false, source: 'ci', costUnknown: true, prUrl: 'https://github.com/o/r/pull/5' };
  const priced: RunSummary = { ...ci, taskId: 'ci-2', costUnknown: undefined, totalCostUsd: 1.5, prUrl: 'https://gitlab.com/o/r/-/merge_requests/9' } as RunSummary;
  render(<RunList runs={[ci, priced].map(withOutcome)} active={[]} onSelect={onSelect} onOpenActive={noop} />);
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

test('a run row shows the estimate next to the reported cost, with the explanation on the cell', () => {
  const base: RunSummary = { taskId: 'local-1', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implementer', 'reviewer'], totalCostUsd: 1.5, anyFailed: false };
  const codexOnly: RunSummary = { ...base, taskId: 'local-2', totalCostUsd: 0, costUnknown: true, estCostUsd: 0.4 };
  render(<RunList runs={[{ ...base, estCostUsd: 0.2 }, codexOnly, { ...base, taskId: 'local-3' }].map(withOutcome)} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('$1.50 + ≈$0.20')).toHaveAttribute('title', expect.stringMatching(/not billed per token/));
  expect(screen.getByText('≈$0.40')).toHaveAttribute('title', expect.stringMatching(/estimate at API prices/));
  expect(screen.getByText('$1.50')).not.toHaveAttribute('title');
});

test('a search that empties the list is named, with a button that clears it; the box says what it matches', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const onHub = vi.fn();
  const hub = { triage: 'all' as const, repos: [], sources: [], query: 'cart total', group: 'none' as const };
  render(<RunList runs={runs.map(withOutcome)} active={[]} hub={hub} onHub={onHub} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByLabelText('Search title, #issue or id')).toHaveValue('cart total');
  expect(screen.getByText('No runs match the search "cart total".')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(onHub).toHaveBeenCalledWith({ ...hub, query: '' });
});

test('a list emptied by another filter names the filters, with no Clear search that would bring nothing back', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const hub = { triage: 'all' as const, repos: [], sources: [], query: 'task', group: 'none' as const };
  render(<RunList runs={runs.map(withOutcome)} active={[]} hub={hub} onHub={noop} onSelect={noop} onOpenActive={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'failed' }));
  expect(screen.getByText('No runs match the current filters.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
});

test('an openable row is a button: Enter or a click opens it; a CI-only row is not one', () => {
  const run: RunSummary = { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false };
  const onSelect = vi.fn();
  const onOpenActive = vi.fn();
  const active: ActiveRun[] = [{ taskId: 'task-live', sessionFile: '/x.jsonl', lastActivityMs: Date.now() }];
  render(<RunList runs={[run, { ...run, taskId: 'task-ci', source: 'ci' }].map(withOutcomeLoose)} active={active} onSelect={onSelect} onOpenActive={onOpenActive} />);
  fireEvent.click(screen.getByText('task-7').closest('button')!);
  expect(onSelect).toHaveBeenCalledWith(withOutcome(run));
  fireEvent.click(screen.getByText('task-live').closest('button')!);
  expect(onOpenActive).toHaveBeenCalledWith(active[0]);
  expect(screen.getByText('task-ci').closest('button')).toBeNull();
});

test('the Passed and Failed pills follow the row\'s chip: a failed verify with every stage completed is failed', () => {
  const base = { timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0, anyFailed: false };
  const runs: RunSummary[] = [{ ...base, taskId: 'task-ok' }, { ...base, taskId: 'task-red', verifyFailed: true }];
  render(<RunList runs={runs.map(withOutcome)} active={[]} onSelect={noop} onOpenActive={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'passed' }));
  expect(screen.getAllByTestId('run-row').map((r) => r.textContent)).toEqual([expect.stringContaining('task-ok')]);
  fireEvent.click(screen.getByRole('button', { name: 'failed' }));
  expect(screen.getAllByTestId('run-row').map((r) => r.textContent)).toEqual([expect.stringContaining('task-red')]);
});

test('the result pills say "All results", so Runs has one "All" (triage) beside the shared filter bar', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const hub = { triage: 'all' as const, repos: [], sources: [], query: '', group: 'none' as const };
  render(<RunList runs={runs.map(withOutcome)} active={[]} hub={hub} onHub={noop} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getAllByRole('button', { name: 'All' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'All results' })).toBeInTheDocument();
});

test('the count names its unit: "1 of 2 runs"', () => {
  const base = { timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0, anyFailed: false };
  render(<RunList runs={[{ ...base, taskId: 'task-ok' }, { ...base, taskId: 'task-red', verifyFailed: true }].map(withOutcomeLoose)} active={[]} onSelect={noop} onOpenActive={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'passed' }));
  expect(screen.getByText('1 of 2 runs')).toBeInTheDocument();
});

test('a list emptied by filters names them; Clear filters resets search, source, triage and the result pill', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const onHub = vi.fn();
  const hub = { triage: 'needs' as const, repos: ['/a'], sources: ['gitlab' as const], query: 'task', group: 'project' as const };
  render(<RunList runs={runs.map(withOutcome)} active={[]} hub={hub} onHub={onHub} configured={['github', 'gitlab']} onSelect={noop} onOpenActive={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'failed' }));
  expect(screen.getByText(/Active: Waiting for you, GitLab, Projects, search "task", Failed\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  // Projects and grouping are not filters this action owns.
  expect(onHub).toHaveBeenCalledWith({ ...hub, triage: 'all', sources: [], query: '' });
  expect(screen.getByRole('button', { name: 'All results' })).toHaveAttribute('aria-pressed', 'true');
});

test('the search matches a run by the board title, #issue and labels, not only the task id', () => {
  const runs: RunSummary[] = [{ taskId: 'gh-o-r-904', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const titles = new Map([[titleKey(undefined, 'gh-o-r-904'), 'Fix the cart total']]);
  const labels = new Map([[titleKey(undefined, 'gh-o-r-904'), ['billing']]]);
  const at = (query: string) => ({ triage: 'all' as const, repos: [], sources: [], query, group: 'none' as const });
  for (const [q, shown] of [['cart total', true], ['#904', true], ['billing', true], ['nothing', false]] as const) {
    const { unmount } = render(<RunList runs={runs.map(withOutcome)} active={[]} hub={at(q)} onHub={noop} titles={titles} labels={labels} onSelect={noop} onOpenActive={noop} />);
    expect(screen.queryAllByTestId('run-row')).toHaveLength(shown ? 1 : 0);
    unmount();
  }
});

test('the search box tooltip names what it matches and that Board shares it', () => {
  const runs: RunSummary[] = [{ taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false }];
  const hub = { triage: 'all' as const, repos: [], sources: [], query: '', group: 'none' as const };
  render(<RunList runs={runs.map(withOutcome)} active={[]} hub={hub} onHub={noop} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByLabelText('Search title, #issue or id')).toHaveAttribute('title', expect.stringContaining('Board shares this search'));
});

test('a run stopped by a provider limit is labelled as such, not as a plain failure', () => {
  const runs: RunSummary[] = [{ taskId: 'task-9', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: true, stoppedBy: 'provider-limit' }];
  render(<RunList runs={runs.map(withOutcome)} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('stopped: provider limit')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'failed' }));
  expect(screen.queryByText('task-9')).toBeNull();
});

test('an open run the filters hide is named, with Clear', () => {
  const base = { stages: ['implement'], totalCostUsd: 0, anyFailed: false };
  const runs = [
    { ...base, taskId: 'hub-2', timestamp: '2026-07-06T19:12:02.123Z', repoPath: '/b', repoName: 'b' },
    { ...base, taskId: 'gh-7', timestamp: '2026-07-06T19:12:03.123Z', repoPath: '/a', repoName: 'a' },
  ] as (RunSummary & { repoPath: string; repoName: string })[];
  const onHub = vi.fn();
  const hub = { triage: 'all' as const, repos: ['/a'], sources: [], query: '', group: 'none' as const };
  render(<RunList runs={runs.map(withOutcome)} active={[]} hub={hub} onHub={onHub} onSelect={noop} onOpenActive={noop} selected={`/b:hub-2:${runs[0]!.timestamp}`} paneOpen pane={<div />} />);
  expect(screen.getByRole('status')).toHaveTextContent('hub-2 is hidden by your filters — Clear');
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onHub).toHaveBeenCalledWith(expect.objectContaining({ repos: [] }));
});
