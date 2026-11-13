import { test, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { AutoMerge } from './AutoMerge';
import type { ApproverScorecard } from '../../wire';

afterEach(() => {
  clearMocks();
  delete window.__TASKCELL_HUB__;
});

const card = (o: Partial<ApproverScorecard> = {}): ApproverScorecard => ({
  status: 'ok', period: '90d', mode: 'shadow', policyFound: true, actOffered: true, threshold: 30,
  judged: 114, approves: 1, escalates: 113, approvesRight: 1, approvesWrong: 0, approvesPending: 0, barMet: false,
  byRiskClass: [{ riskClass: 'general', approveTotal: 1, approveCorrect: 1, streak: 1 }],
  topReasons: [{ reason: 'size-lines', count: 90 }], ...o,
});

test('shows the 90-day scorecard in plain words, the mode, and the reasons', async () => {
  mockIPC((cmd) => (cmd === 'read_approver_scorecard' ? card() : undefined));
  render(<AutoMerge project="/repo" />);
  expect(await screen.findByText(/1 of 114 pull requests would have been merged automatically; the bar is 30 correct in a row/)).toBeInTheDocument();
  expect(screen.getByText(/The bar is not met/)).toBeInTheDocument();
  expect(screen.getByText(/Shadow — it judges/)).toBeInTheDocument();
  expect(screen.getByText(/size-lines \(90\)/)).toBeInTheDocument();
});

test('no data is an explanation, not zeros', async () => {
  mockIPC((cmd) => (cmd === 'read_approver_scorecard' ? card({ status: 'no-data', hint: 'No approver decisions on the metrics branch yet.', judged: 0, approves: 0, escalates: 0 }) : undefined));
  render(<AutoMerge project="/repo" />);
  expect(await screen.findByText(/No approver decisions on the metrics branch yet/)).toBeInTheDocument();
  expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument();
});

test('below the bar, act needs the explicit confirmation before the PR is opened', async () => {
  const sent: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === 'read_approver_scorecard') return card();
    if (cmd === 'set_approver_mode') {
      sent.push(args);
      return { branch: 'b', prUrl: 'https://github.com/a/b/pull/3', mode: 'act' };
    }
    return undefined;
  });
  render(<AutoMerge project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Act' }));
  const open = screen.getByRole('button', { name: 'Open pull request' });
  expect(open).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(open);
  await screen.findByText(/merge it to apply/);
  expect(sent).toEqual([expect.objectContaining({ repoPath: '/repo', mode: 'act', confirmBelowBar: true })]);
});

test('act is not offered while it is blocked, and nothing is written directly', async () => {
  mockIPC((cmd) => (cmd === 'read_approver_scorecard' ? card({ actOffered: false }) : undefined));
  render(<AutoMerge project="/repo" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Act' })).toBeDisabled());
  expect(screen.getByText(/Act mode is not available yet/)).toBeInTheDocument();
});
