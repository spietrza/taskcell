import type { ReactElement } from 'react';
import type { Credentials } from './credentials';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BoardScreen as Board } from './BoardScreen';
import { HubProvider } from './hubContext';
import { COLUMNS, toCards, type HubTask } from './board';

const creds: Credentials = { url: 'http://hub.local:4317', token: 't', kind: 'owner' };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const NOW = Date.parse('2026-07-06T12:00:00Z');
const task = (o: Partial<HubTask>): HubTask => ({ id: 'gh-1', title: 'T', column: 'queued', state: 'ready', repoPath: '/r', repoName: 'o/r', ...o });
const run = { repoPath: '/r', taskId: 'gh-3', timestamp: '2026-07-06T09:00:00Z', stages: [], totalCostUsd: 0, anyFailed: false, prUrl: 'https://github.com/o/r/pull/3' };
const TASKS: HubTask[] = [
  task({ id: 'gh-6', title: 'Merged one', column: 'done' }),
  task({ id: 'gh-3', title: 'In review', column: 'review', url: 'https://github.com/o/r/issues/3', labels: ['bug'] }),
  task({ id: 'gh-2', title: 'Building', column: 'running', stage: 'implementer' }),
  task({ id: 'gh-1', title: 'Queued one', column: 'queued' }),
];

test('columns match the desktop Board, in order, for the same data', () => {
  expect(COLUMNS.map((c) => c.label)).toEqual(['Card', 'Spec', 'Cell', 'Gates', 'Review / PR', 'Done']);
  const cards = toCards([...TASKS, task({ id: 'gh-4', column: 'claimed' }), task({ id: 'gh-5', column: 'verify-failed', stage: 'verify' })], [run], NOW);
  expect(cards.map((c) => [c.task.id, c.column])).toEqual([
    ['gh-1', 'card'], ['gh-4', 'spec'], ['gh-2', 'cell'], ['gh-5', 'gates'], ['gh-3', 'review'], ['gh-6', 'done'],
  ]);
  const review = cards.find((c) => c.task.id === 'gh-3')!;
  expect(review.prUrl).toBe('https://github.com/o/r/pull/3');
  expect(review.age).toBe('3h ago');
});

test('a run of another repository with the same task id is not matched', () => {
  const other = { ...run, repoPath: '/other', prUrl: 'https://github.com/o/other/pull/3', prState: 'merged' as const };
  const [c] = toCards([task({ id: 'gh-3', column: 'review', repoPath: '/r' })], [other], NOW);
  expect(c!.column).toBe('review');
  expect(c!.prUrl).toBeNull();
  expect(c!.runStatus).toBeNull();
  const [d] = toCards([task({ id: 'gh-3', column: 'review', repoPath: '/other' })], [other], NOW);
  expect(d!.column).toBe('done');
  expect(d!.prUrl).toBe('https://github.com/o/other/pull/3');
});

test('non-https links are dropped', () => {
  const [c] = toCards([task({ url: 'javascript:alert(1)', column: 'review' })], [{ ...run, taskId: 'gh-1', prUrl: 'http://x' }], NOW);
  expect(c!.issueUrl).toBeNull();
  expect(c!.prUrl).toBeNull();
});

/** A fake hub: tasks/runs answers, optional failure, a feedable /events stream, a read counter. */
function hub(): { fetchImpl: typeof fetch; reads: () => number; emit: (f: string) => void; failNext: () => void } {
  let reads = 0;
  let fail = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = (async (input: string) => {
    if (input.endsWith('/events')) return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }) };
    if (input.includes('list_tasks_all')) {
      reads += 1;
      if (fail) throw new Error('Network request failed');
      return { status: 200, json: async () => ({ result: { tasks: TASKS, capped: false, failures: [] } }) };
    }
    return { status: 200, json: async () => ({ result: { runs: [run], failures: [] } }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, reads: () => reads, emit: (f) => controller.enqueue(new TextEncoder().encode(f)), failNext: () => void (fail = true) };
}
const frame = (name: string): string => `event: ${name}\ndata: "/r"\n\n`;
const renderBoard = (fetchImpl: typeof fetch): ReturnType<typeof render> =>
  render(<SafeAreaProvider initialMetrics={METRICS}><BoardScreen credentials={creds} fetchImpl={fetchImpl} /></SafeAreaProvider>);

test('card view shows title, repository, status, https links and latest run', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  await renderBoard(hub().fetchImpl);
  await fireEvent.press(await screen.findByText(/Review \/ PR 1/));
  await fireEvent.press(await screen.findByText('In review'));
  expect(screen.getByText('Repository: o/r')).toBeTruthy();
  expect(screen.getByText(/Status: /)).toBeTruthy();
  expect(screen.getByText('Latest run: PR open')).toBeTruthy();
  expect(screen.getByText('Labels: bug')).toBeTruthy();
  await fireEvent.press(screen.getByText('Open issue'));
  expect(open).toHaveBeenCalledWith('https://github.com/o/r/issues/3');
  await fireEvent.press(screen.getByText('Open pull request'));
  expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/3');
});

test('only vanguard:changed reloads, coalesced; a failed reload keeps the board', async () => {
  const h = hub();
  await renderBoard(h.fetchImpl);
  await screen.findByText('Queued one');
  expect(h.reads()).toBe(1);
  for (let i = 0; i < 50; i += 1) h.emit(frame('run-update'));
  await new Promise((r) => setTimeout(r, 50));
  expect(h.reads()).toBe(1);
  h.emit(Array.from({ length: 20 }, () => frame('vanguard:changed')).join(''));
  await waitFor(() => expect(h.reads()).toBeGreaterThan(1));
  await new Promise((r) => setTimeout(r, 100));
  expect(h.reads()).toBeLessThanOrEqual(3);
  h.failNext();
  h.emit(frame('vanguard:changed'));
  expect(await screen.findByText(/Could not refresh from .*Network request failed/)).toBeTruthy();
  expect(screen.getByText('Queued one')).toBeTruthy();
  expect(screen.queryByText('Hub unreachable')).toBeNull();
});

test('loading, empty and unreachable states', async () => {
  await renderBoard((() => new Promise(() => undefined)) as unknown as typeof fetch);
  expect(screen.getByText('Loading…')).toBeTruthy();
});

test('says so when there are no cards', async () => {
  const f = (async (input: string) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    return { status: 200, json: async () => ({ result: input.includes('list_tasks_all') ? { tasks: [], capped: false, failures: [] } : { runs: [], failures: [] } }) };
  }) as unknown as typeof fetch;
  await renderBoard(f);
  expect(await screen.findByText('No cards yet')).toBeTruthy();
});

test('a repository without a task source is a setup hint, not a read error', async () => {
  const failures = [
    { repoPath: '/r/a', repoName: 'alpha', error: 'Set a Task Source in Settings to load the board.' },
    { repoPath: '/r/b', repoName: 'beta', error: 'gh: not logged in' },
  ];
  const f = (async (input: string) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    return { status: 200, json: async () => ({ result: input.includes('list_tasks_all') ? { tasks: [], capped: false, failures } : { runs: [], failures: [] } }) };
  }) as unknown as typeof fetch;
  await renderBoard(f);
  expect(await screen.findByText(/No card source yet: alpha\./)).toBeTruthy();
  expect(screen.getByText('Could not read beta: gh: not logged in')).toBeTruthy();
  expect(screen.queryByText(/Could not read alpha/)).toBeNull();
});

test('says so when the hub is unreachable', async () => {
  const f = (async (input: string) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    throw new Error('Network request failed');
  }) as unknown as typeof fetch;
  await renderBoard(f);
  expect(await screen.findByText('Hub unreachable')).toBeTruthy();
});

/** The screen inside the session's one hub connection, as the app provides it. */
function BoardScreen({ credentials, fetchImpl }: { credentials: Credentials; fetchImpl?: typeof fetch }): ReactElement {
  return (
    <HubProvider credentials={credentials} fetchImpl={fetchImpl}>
      <Board />
    </HubProvider>
  );
}
