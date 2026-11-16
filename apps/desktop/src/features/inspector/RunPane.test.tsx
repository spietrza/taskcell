import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunPane } from './RunPane';
import { readRunEvents, readSession } from '../../ipc';
import type { RunDetail, StageDetail } from '../../taskcell-output';

vi.mock('../../ipc', async (orig) => ({
  ...(await orig<typeof import('../../ipc')>()),
  readRunEvents: vi.fn(),
  readSession: vi.fn(),
  listLessons: vi.fn(async () => ({ lessons: [], branchFound: true })),
}));
vi.mock('../../transport', async (orig) => ({ ...(await orig<typeof import('../../transport')>()), subscribe: vi.fn(async () => () => {}) }));

const noEvents = { events: [], nextAfter: 0, hasMore: false, truncated: false };
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); // the Tabs under the pane read it
  vi.mocked(readRunEvents).mockResolvedValue(noEvents);
  vi.mocked(readSession).mockResolvedValue({ entries: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estCostUsd: 0 });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const toolLine = (command: string): string => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const stage = (name: string, ms: number, over: Partial<StageDetail['record']> = {}, transcript?: string): StageDetail => ({
  record: { taskId: 'gh-r-3', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: 'ok', timestamp: '2026-11-16T10:00:00.000Z', stage: name, durationMs: ms, ...over },
  ...(transcript !== undefined ? { transcript } : {}),
});
const detail: RunDetail = {
  taskId: 'gh-r-3',
  timestamp: '2026-11-16T10:00:00.000Z',
  prUrl: 'https://github.com/o/r/pull/5',
  stages: [stage('implementer', 27_000, { startedBy: 'token', baseBranch: 'main' }, toolLine('pnpm build')), stage('reviewer', 75_000, {}, toolLine('git diff')), stage('simplifier', 34_000, {}, toolLine('pnpm test'))],
};
const props = { repo: '/r', repoName: 'taskcell-demo-form', taskId: 'gh-r-3', issue: 3, tick: 0, onBack: () => {}, onCancel: () => {} };

test('a finished run: header, one card per stage record with its own duration, the PR link, and who started it in words', async () => {
  render(<RunPane {...props} title="Disable the Send button while sending" detail={detail} />);
  const pane = screen.getByRole('region', { name: 'Run gh-r-3' });
  expect(within(pane).getByText('Disable the Send button while sending')).toBeInTheDocument();
  expect(within(pane).getByText('#3')).toBeInTheDocument();
  expect(within(pane).getByTitle('Target branch')).toHaveTextContent('main');
  expect(within(pane).getByText('Started by Hub')).toBeInTheDocument();
  expect(screen.queryByText(/\btoken\b/)).toBeNull();
  expect(within(pane).getAllByRole('link', { name: /Open in GitHub/ })[0]).toHaveAttribute('href', 'https://github.com/o/r/pull/5');
  const cards = [0, 1, 2].map((i) => screen.getByTestId(`stage-${i}`));
  expect(cards.map((c) => c.getAttribute('data-phase'))).toEqual(['done', 'done', 'done']);
  expect(cards[0]).toHaveTextContent('implementer27s');
  expect(cards[1]).toHaveTextContent('reviewer1m 15s');
  expect(screen.getByLabelText('Total time')).toHaveTextContent('2m 16s');
  expect(screen.getByText('PR open')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  await waitFor(() => expect(readRunEvents).toHaveBeenCalledWith('/r', 'gh-r-3', detail.timestamp));
});

test('a finished run\'s log is the picked stage\'s transcript; the last stage is open to begin with', async () => {
  render(<RunPane {...props} detail={detail} />);
  const log = screen.getByRole('log', { name: 'Stage log' });
  expect(log).toHaveTextContent('Bash · pnpm test');
  fireEvent.click(within(screen.getByTestId('stage-0')).getByRole('button'));
  expect(log).toHaveTextContent('Bash · pnpm build');
  expect(log).not.toHaveTextContent('pnpm test');
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

test('a failed stage is marked and its log opens first', async () => {
  const failed: RunDetail = { ...detail, stages: [detail.stages[0]!, stage('reviewer', 5_000, { completed: false, exitReason: 'error' }, toolLine('boom'))] };
  render(<RunPane {...props} detail={failed} />);
  expect(screen.getByTestId('stage-1')).toHaveAttribute('data-phase', 'failed');
  expect(screen.getByRole('log')).toHaveTextContent('boom');
  expect(screen.getByText('failed', { selector: '*:not(button)' })).toBeInTheDocument();
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

test('a running run: the stage line comes from the persisted events, the running stage is highlighted, pending ones wait; the log is the live session; Cancel stops it by its run id', async () => {
  const at = (s: number): string => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const e = (n: number, s: number, event: Record<string, unknown>) => ({ id: n, ts: at(s), event: 'api:event', data: { runId: 'run-9', event } });
  vi.mocked(readRunEvents).mockResolvedValue({
    events: [
      e(1, 0, { type: 'run-start', taskId: 'gh-r-3', stages: ['implementer', 'reviewer', 'simplifier'] }),
      e(2, 1, { type: 'stage-start', name: 'implementer', index: 0, of: 3 }),
      e(3, 31, { type: 'stage-end', name: 'implementer', index: 0, of: 3, outcome: 'completed' }),
      e(4, 32, { type: 'stage-start', name: 'reviewer', index: 1, of: 3 }),
    ],
    nextAfter: 4,
    hasMore: false,
    truncated: false,
  });
  vi.mocked(readSession).mockResolvedValue({ entries: [{ role: 'tool', text: 'Read · src/a.ts' }], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estCostUsd: 0 });
  const onCancel = vi.fn();
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '/s.jsonl', lastActivityMs: Date.now() }} onCancel={onCancel} />);
  await waitFor(() => expect(screen.getByTestId('stage-1')).toHaveAttribute('data-phase', 'running'));
  expect(screen.getByTestId('stage-0')).toHaveAttribute('data-phase', 'done');
  expect(screen.getByTestId('stage-0')).toHaveTextContent('30s');
  expect(screen.getByTestId('stage-2')).toHaveAttribute('data-phase', 'pending');
  expect(screen.getByTestId('stage-2')).toHaveTextContent('Waiting');
  expect(within(screen.getByTestId('stage-1')).getByRole('progressbar')).toBeInTheDocument();
  expect(screen.getByLabelText('Total time')).toHaveTextContent('1m 0');
  await waitFor(() => expect(screen.getByRole('log', { name: 'Live log' })).toHaveTextContent('Read · src/a.ts'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledWith('run-9');
});

test('a running run the hub has no events for has no Cancel and says it waits for the first stage', async () => {
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '/s.jsonl', lastActivityMs: Date.now() }} />);
  expect(await screen.findByText('Waiting for the first stage…')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

test('the back button is the way out on a narrow screen', async () => {
  const onBack = vi.fn();
  render(<RunPane {...props} detail={detail} onBack={onBack} />);
  fireEvent.click(screen.getByRole('button', { name: /Back to runs/ }));
  expect(onBack).toHaveBeenCalled();
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});
