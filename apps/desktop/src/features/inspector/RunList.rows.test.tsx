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
  expect(row).toHaveTextContent('CSV export skips corrections · #214');
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
