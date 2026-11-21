import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunPane } from './RunPane';
import { readSession } from '../../ipc';
import { subscribe } from '../../transport';
import type { RunDetail, StageDetail } from '../../taskcell-output';

vi.mock('../../ipc', async (orig) => ({
  ...(await orig<typeof import('../../ipc')>()),
  readSession: vi.fn(),
  listLessons: vi.fn(async () => ({ lessons: [], branchFound: true })),
}));
// The event log is read through the transport's `invoke`; `readRunEvents` stands for `read_run_events` (repo, task, timestamp).
const readRunEvents = vi.fn();
vi.mock('../../transport', async (orig) => {
  const t = await orig<typeof import('../../transport')>();
  return {
    ...t,
    subscribe: vi.fn(async () => () => {}),
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => (cmd === 'read_run_events' ? readRunEvents(args?.repoPath, args?.taskId, args?.timestamp, args?.after) : t.invoke(cmd, args))),
  };
});

const noEvents = { events: [], nextAfter: 0, hasMore: false, truncated: false };
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); // the Tabs under the pane read it
  readRunEvents.mockReset();
  readRunEvents.mockResolvedValue(noEvents);
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

const summary = { taskId: 'gh-r-3', timestamp: detail.timestamp, stages: [], anyFailed: false, totalCostUsd: 0.5, prUrl: detail.prUrl } as never;

test('a finished run: header with the issue link and one PR chip, the six stations, the receipt, and what the factory did', async () => {
  render(<RunPane {...props} title="Disable the Send button while sending" detail={detail} summary={summary} />);
  const pane = screen.getByRole('region', { name: 'Run gh-r-3' });
  expect(within(pane).getByText('Disable the Send button while sending')).toBeInTheDocument();
  expect(within(pane).getByTitle('Target branch')).toHaveTextContent('main');
  // The shared hub token is not a person: no "Started by" line.
  expect(within(pane).queryByText(/Started by/)).toBeNull();
  expect(screen.queryByText(/\btoken\b/)).toBeNull();
  // One issue link and one PR link, both in the header; no "Open in GitHub".
  expect(within(pane).getByRole('link', { name: /gh-3/ })).toHaveAttribute('href', 'https://github.com/o/r/issues/3');
  expect(within(pane).getAllByRole('link', { name: /PR #5/ })).toHaveLength(1);
  expect(within(pane).queryByRole('link', { name: /Open in GitHub/ })).toBeNull();
  const stations = within(screen.getByRole('list', { name: 'Stations' })).getAllByRole('listitem');
  expect(stations.map((s) => s.getAttribute('data-status'))).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  const receipt = screen.getByRole('region', { name: 'Receipt' });
  expect(within(receipt).getByText('Cost').nextSibling).toHaveTextContent('$0.50');
  expect(within(receipt).getByText('Spec').nextSibling).toHaveTextContent('from the card');
  expect(within(receipt).queryByText('Skills used')).toBeNull(); // recorded before the field
  expect(screen.getByRole('tab', { name: 'What the factory did', selected: true })).toBeInTheDocument();
  expect(screen.getByTestId('step-0')).toHaveTextContent('Code');
  expect(screen.getByTestId('step-0')).toHaveTextContent('27s');
  expect(screen.getByTestId('step-1')).toHaveTextContent('1m 15s');
  expect(screen.getByLabelText('Total time')).toHaveTextContent('2m 16s');
  expect(screen.getByText('PR open')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
  await waitFor(() => expect(readRunEvents).toHaveBeenCalledWith('/r', 'gh-r-3', detail.timestamp, 0));
});

test('the board task url is the issue link when known', async () => {
  render(<RunPane {...props} detail={{ ...detail, prUrl: undefined }} issueHref="https://github.com/o/r/issues/3" />);
  expect(screen.getByRole('link', { name: /gh-3/ })).toHaveAttribute('href', 'https://github.com/o/r/issues/3');
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

test('a merged run says merged, from the same row the list shows', async () => {
  render(<RunPane {...props} detail={detail} summary={{ ...(summary as object), prState: 'merged' } as never} />);
  expect(screen.getByText('merged', { selector: '*:not(span span)' })).toBeInTheDocument();
  expect(screen.queryByText('PR open')).toBeNull();
  const stations = within(screen.getByRole('list', { name: 'Stations' })).getAllByRole('listitem');
  expect(stations.every((s) => s.getAttribute('data-status') === 'done')).toBe(true);
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

test('skills used shows the recorded list, "none" when empty', async () => {
  const withSkills: RunDetail = { ...detail, stages: [stage('implementer', 1_000, { skillsUsed: ['tdd'] }), stage('reviewer', 1_000, { skillsUsed: [] })] };
  const { unmount } = render(<RunPane {...props} detail={withSkills} />);
  expect(within(screen.getByRole('region', { name: 'Receipt' })).getByText('Skills used').nextSibling).toHaveTextContent('tdd');
  unmount();
  render(<RunPane {...props} detail={{ ...detail, stages: [stage('implementer', 1_000, { skillsUsed: [] })] }} />);
  expect(within(screen.getByRole('region', { name: 'Receipt' })).getByText('Skills used').nextSibling).toHaveTextContent('none');
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

test('a failed stage is marked on its station and in the activity', async () => {
  const failed: RunDetail = { ...detail, stages: [detail.stages[0]!, stage('reviewer', 5_000, { completed: false, exitReason: 'error' }, toolLine('boom'))] };
  render(<RunPane {...props} detail={failed} />);
  expect(screen.getByTestId('step-1')).toHaveAttribute('data-phase', 'failed');
  const stations = within(screen.getByRole('list', { name: 'Stations' })).getAllByRole('listitem');
  expect(stations[4]).toHaveAttribute('data-status', 'failed');
  expect(screen.getByRole('region', { name: 'Run gh-r-3' }).firstElementChild).toHaveTextContent(/failed$/);
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

test('a running run: the stage line comes from the persisted events, the running stage is highlighted, pending ones wait; the log is the live session; Cancel stops it by its run id', async () => {
  const at = (s: number): string => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const e = (n: number, s: number, event: Record<string, unknown>) => ({ id: n, ts: at(s), event: 'api:event', data: { runId: 'run-9', event } });
  readRunEvents.mockResolvedValue({
    events: [
      e(1, 0, { type: 'stage-start', name: 'sandbox', index: 0, of: 1 }),
      e(2, 4, { type: 'stage-end', name: 'sandbox', index: 0, of: 1, outcome: 'completed' }),
      e(3, 5, { type: 'run-start', taskId: 'gh-r-3', stages: ['sandbox', 'implementer', 'reviewer', 'simplifier'] }),
      e(4, 6, { type: 'stage-start', name: 'implementer', index: 1, of: 4 }),
      e(5, 36, { type: 'stage-end', name: 'implementer', index: 1, of: 4, outcome: 'completed' }),
      e(6, 37, { type: 'stage-start', name: 'reviewer', index: 2, of: 4 }),
    ],
    nextAfter: 6,
    hasMore: false,
    truncated: false,
  });
  vi.mocked(readSession).mockResolvedValue({ entries: [{ role: 'tool', text: 'Read · src/a.ts' }], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estCostUsd: 0 });
  const onCancel = vi.fn();
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '/s.jsonl', lastActivityMs: Date.now() }} onCancel={onCancel} />);
  // Sandbox, Code, Tests (passed: Review only starts on a green gate), Review (running), Simplify, PR (pending).
  await waitFor(() => expect(screen.getByTestId('stage-3')).toHaveAttribute('data-phase', 'running'));
  expect(screen.getByTestId('stage-0')).toHaveTextContent('Cell');
  expect(screen.getByTestId('stage-0')).toHaveAttribute('data-phase', 'done');
  expect(screen.getByTestId('stage-1')).toHaveTextContent('30s');
  expect(screen.getByTestId('stage-2')).toHaveTextContent('Gates');
  expect(screen.getByTestId('stage-2')).toHaveAttribute('data-phase', 'done');
  expect(screen.getByTestId('stage-4')).toHaveTextContent('Waiting');
  expect(screen.getByTestId('stage-5')).toHaveTextContent('PR');
  expect(screen.getByTestId('stage-5')).toHaveAttribute('data-phase', 'pending');
  expect(within(screen.getByTestId('stage-3')).getByRole('progressbar')).toBeInTheDocument();
  expect(screen.getByLabelText('Total time')).toHaveTextContent('1m 0');
  await waitFor(() => expect(screen.getByRole('log', { name: 'Live log' })).toHaveTextContent('Read · src/a.ts'));
  // Receipt first, as on a finished run: everything pending reads "not yet"; Review is the current station.
  expect(screen.getByText('in progress')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Receipt' })).getByText('Author').nextSibling).toHaveTextContent('not yet');
  const stations = within(screen.getByRole('list', { name: 'Stations' })).getAllByRole('listitem');
  expect(stations.map((x) => x.getAttribute('data-status'))).toEqual(['done', 'done', 'done', 'done', 'current', 'waiting']);
  expect(stations[2]).toHaveTextContent('Cell');
  expect(screen.getByRole('tab', { name: 'Transcript' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
  expect(onCancel).toHaveBeenCalledWith('run-9');
});

test('a running run the hub has no events for has no Cancel and says it waits for the first stage', async () => {
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '/s.jsonl', lastActivityMs: Date.now() }} />);
  expect(await screen.findByText('Waiting for the first stage…')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
});

test('the back button is the way out on a narrow screen', async () => {
  const onBack = vi.fn();
  render(<RunPane {...props} detail={detail} onBack={onBack} />);
  fireEvent.click(screen.getByRole('button', { name: /Back to runs/ }));
  expect(onBack).toHaveBeenCalled();
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
});

const sealedEvents = (tail: Record<string, unknown>[] = []) => {
  const at = (s: number): string => new Date(Date.UTC(2026, 10, 16, 10, 0, s)).toISOString();
  const e = (n: number, s: number, event: Record<string, unknown>) => ({ id: n, ts: at(s), event: 'api:event', data: { runId: 'run-9', event } });
  return {
    events: [
      e(1, 0, { type: 'stage-start', name: 'sandbox', index: 0, of: 1 }),
      e(2, 4, { type: 'stage-end', name: 'sandbox', index: 0, of: 1, outcome: 'completed' }),
      e(3, 5, { type: 'run-start', taskId: 'gh-r-3', stages: ['sandbox', 'implementer', 'reviewer', 'simplifier'] }),
      ...tail.map((t, i) => e(4 + i, 6 + i, t)),
    ],
    nextAfter: 9,
    hasMore: false,
    truncated: false,
  };
};

test('a finished run keeps its Cell step from the event log', async () => {
  readRunEvents.mockResolvedValue(sealedEvents());
  render(<RunPane {...props} detail={detail} />);
  await waitFor(() => expect(screen.getByTestId('step-0')).toHaveTextContent('Cell'));
  expect(screen.getByTestId('step-0')).toHaveTextContent('4s');
  expect(screen.getByTestId('step-1')).toHaveTextContent('Code');
});

test('the Tests and PR cards stay when the live run turns terminal', async () => {
  readRunEvents.mockResolvedValue(sealedEvents([{ type: 'run-error', message: 'boom' }]));
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '/s.jsonl', lastActivityMs: Date.UTC(2026, 10, 16, 9) }} />);
  await waitFor(() => expect(screen.getByTestId('stage-5')).toHaveTextContent('PR'));
  expect(screen.getByTestId('stage-0')).toHaveTextContent('Cell');
  expect(screen.getByTestId('stage-2')).toHaveTextContent('Gates');
});

test('a run whose agent stopped to ask: the chip word and colour come from one state, the header says why, the stations show the cell', async () => {
  const asking: RunDetail = {
    taskId: 'hub-4',
    timestamp: '2026-11-17T15:53:58.120Z',
    proof: { command: 'npm test', exitCode: 0, passed: true, sha256: 'x', outputTail: 'ok' } as never,
    stages: [stage('implementer', 25_000, { taskId: 'hub-4', completed: false, exitReason: 'incomplete', finalText: 'To finish, I still need: **which config file?**' })],
  };
  const row = { taskId: 'hub-4', timestamp: asking.timestamp, stages: ['implementer'], anyFailed: true, failedStage: 'implementer', asked: 'To finish, I still need: **which config file?**', totalCostUsd: 0.2 } as never;
  render(<RunPane {...props} taskId="hub-4" issue={undefined} detail={asking} summary={row} />);
  const pane = screen.getByRole('region', { name: 'Run hub-4' });
  // The proof passed, yet the run did not: never a green chip next to a "failed"/"asks you" word.
  const chip = within(pane).getByText('Waiting for your answer');
  expect(chip.closest('[class*="success"]')).toBeNull();
  expect(within(pane).getByRole('note')).toHaveTextContent('Stopped to ask you');
  // Rendered as agent text: the markdown is formatting, not raw asterisks.
  expect(within(pane).getByRole('note').querySelector('strong')).toHaveTextContent('which config file?');
  expect(within(pane).getByRole('note')).not.toHaveTextContent('**');
  expect(within(pane).getAllByText('hub-4').length).toBeGreaterThan(0);
  // The gates ran green (the receipt's proof): the stations show Gates done, the Cell where it stopped to ask.
  const stations = within(screen.getByRole('list', { name: 'Stations' })).getAllByRole('listitem');
  expect(stations.map((s) => s.getAttribute('data-status'))).toEqual(['done', 'done', 'current', 'done', 'waiting', 'waiting']);
});

test('a question answered in the pane tells the caller, so it can follow the run the answer starts', async () => {
  const ipc = await import('../../ipc');
  vi.spyOn(ipc, 'listNeedsYou').mockResolvedValue({ items: [{ kind: 'card', id: 'hub-4', number: 4, repoSlug: '', title: 'T', url: '', reason: 'question', lastComment: { author: 'agent', body: 'Which file?' } }] });
  vi.spyOn(ipc, 'replyNeedsYou').mockResolvedValue(undefined);
  const asking: RunDetail = { taskId: 'hub-4', timestamp: '2026-11-17T15:53:58.120Z', stages: [stage('implementer', 25_000, { taskId: 'hub-4', completed: false, exitReason: 'incomplete', finalText: 'Which file?' })] };
  const row = { taskId: 'hub-4', timestamp: asking.timestamp, stages: ['implementer'], anyFailed: true, failedStage: 'implementer', asked: 'Which file?', totalCostUsd: 0.2 } as never;
  const onAnswered = vi.fn();
  render(<RunPane {...props} taskId="hub-4" issue={undefined} detail={asking} summary={row} onAnswered={onAnswered} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'reply to hub-4' }), { target: { value: 'config.json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  await waitFor(() => expect(onAnswered).toHaveBeenCalledOnce());
});

// A fake log of n events served 500 to a page, as the hub's default limit does: the tail must page on with `after`.
const longLog = (n: number) => {
  const at = (i: number): string => new Date(Date.UTC(2026, 10, 16, 10, 0, 0) + i * 1000).toISOString();
  const log = [
    { id: 1, ts: at(0), event: 'api:event', data: { runId: 'run-9', event: { type: 'run-start', taskId: 'gh-r-3', stages: ['implementer'] } } },
    { id: 2, ts: at(1), event: 'api:event', data: { runId: 'run-9', event: { type: 'stage-start', name: 'implementer', index: 0, of: 1 } } },
    ...Array.from({ length: n - 3 }, (_, i) => ({ id: i + 3, ts: at(i + 2), event: 'note', data: 'x' })),
    { id: n, ts: at(n), event: 'api:event', data: { runId: 'run-9', event: { type: 'run-end', outcome: 'success' } } },
  ];
  return (_repo: unknown, _task: unknown, _ts: unknown, after: unknown) => {
    const rest = log.filter((e) => e.id > (after as number));
    const events = rest.slice(0, 500);
    return Promise.resolve({ events, nextAfter: events.at(-1)?.id ?? (after as number), hasMore: rest.length > 500, truncated: false });
  };
};

test('a live run past 500 events: the tail pages on and reaches its terminal event', async () => {
  readRunEvents.mockImplementation(longLog(1300));
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '', lastActivityMs: Date.UTC(2026, 10, 16, 9) }} />);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull());
  await waitFor(() => expect(screen.getByRole('region', { name: 'Run gh-r-3' }).firstElementChild).toHaveTextContent(/passed$/));
  expect(readRunEvents.mock.calls.map((c) => c[3])).toEqual([0, 500, 1000]);
});

test("another run's event does not re-read this run's log", async () => {
  let push: ((payload: unknown) => void) | undefined;
  vi.mocked(subscribe).mockImplementation((async (_name: string, h: (e: { payload: unknown }) => void) => {
    push = (payload) => h({ payload });
    return () => {};
  }) as never);
  readRunEvents.mockResolvedValue(sealedEvents([{ type: 'stage-start', name: 'implementer', index: 1, of: 4 }]));
  render(<RunPane {...props} active={{ taskId: 'gh-r-3', sessionFile: '', lastActivityMs: Date.UTC(2026, 10, 16, 9) }} />);
  await waitFor(() => expect(readRunEvents).toHaveBeenCalled());
  await waitFor(() => expect(push).toBeDefined());
  const before = readRunEvents.mock.calls.length;
  push!({ runId: 'other', event: { type: 'stage-start', name: 'implementer' } });
  push!({ runId: 'run-9', event: { type: 'stage-end', name: 'implementer' } });
  await waitFor(() => expect(readRunEvents.mock.calls.length).toBe(before + 1));
});
