import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunList, runKey } from './RunList';
import type { ActiveRun } from '../../taskcell-output';

const noop = (): void => {};

test('a row shows the repository, the board title with the issue number, a PR chip and the age; the open run\'s row is marked', () => {
  const run = { taskId: 'gh-acme-shop-214', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implementer'], totalCostUsd: 0.1, anyFailed: false, prUrl: 'https://github.com/o/r/pull/5', repoPath: '/r/shop', repoName: 'shop' };
  const titles = new Map([['/r/shop|gh-214', 'CSV export skips corrections']]);
  render(<RunList runs={[run]} active={[]} showRepo titles={titles} selected={runKey('/r/shop', run.taskId, run.timestamp)} onSelect={noop} onOpenActive={noop} />);
  const row = screen.getByTestId('run-row');
  expect(row).toHaveTextContent('shop');
  expect(row).toHaveTextContent('#214CSV export skips corrections');
  expect(row).toHaveTextContent('PR open');
  expect(row).toHaveAttribute('aria-current', 'true');
});

test('without a board title the row shows the task id; a running row opens its pane, shown beside the rows', () => {
  const onOpenActive = vi.fn();
  const active: ActiveRun[] = [{ taskId: 'task-live', sessionFile: '/x.jsonl', lastActivityMs: Date.now() }];
  render(<RunList runs={[]} active={active} onSelect={noop} onOpenActive={onOpenActive} pane={<p>the pane</p>} />);
  expect(screen.getByText('the pane')).toBeInTheDocument();
  expect(screen.getByTestId('run-row')).not.toHaveAttribute('aria-current');
  fireEvent.click(screen.getByText('task-live'));
  expect(onOpenActive).toHaveBeenCalledWith(active[0]);
});

test('every row shows its station: an open PR on PR, a failed gate red on Gates, a live run in the cell', () => {
  const base = { timestamp: '2026-07-06T19:12:02.123Z', totalCostUsd: 0, anyFailed: false };
  const runs = [
    { ...base, taskId: 'gh-1', stages: ['implementer'], prUrl: 'https://github.com/o/r/pull/5' },
    { ...base, taskId: 'gh-2', stages: ['implementer', 'verify'], anyFailed: true },
  ];
  render(<RunList runs={runs} active={[{ taskId: 'gh-3', sessionFile: '/x', lastActivityMs: Date.now() }]} onSelect={noop} onOpenActive={noop} />);
  const [live, pr, failed] = screen.getAllByTestId('run-row');
  expect(live!.querySelector('[role="img"]')).toHaveAttribute('aria-label', 'Station: Sealed cell');
  expect(pr!.querySelector('[role="img"]')).toHaveAttribute('aria-label', 'Station: Pull request');
  expect(failed!.querySelector('[role="img"]')).toHaveAttribute('aria-label', 'Station: Gates (failed)');
});

test('a row\'s avatar is its project\'s colour and initials, and the issue number comes before the title', () => {
  const run = { taskId: 'gh-acme-shop-214', timestamp: '2026-07-06T19:12:02.123Z', stages: [], totalCostUsd: 0, anyFailed: false, repoPath: '/r/shop' };
  const titles = new Map([['/r/shop|gh-214', 'A very long title that truncates']]);
  render(<RunList runs={[run]} active={[]} titles={titles} identity={(p) => (p === '/r/shop' ? { name: 'acme-shop', color: '#112233' } : undefined)} onSelect={noop} onOpenActive={noop} />);
  const row = screen.getByTestId('run-row');
  const avatar = row.querySelector('[aria-hidden]') as HTMLElement;
  expect(avatar).toHaveTextContent('AS');
  expect(avatar).toHaveStyle({ backgroundColor: '#112233' });
  expect(row).toHaveTextContent(/^AS#214A very long title/);
});
