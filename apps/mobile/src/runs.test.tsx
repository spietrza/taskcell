import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RunsScreen } from './RunsScreen';
import { MAX_LINES, diffSummary } from './runs';

const creds = { url: 'http://hub.local:4317', token: 't' };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const DIFF = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n+x\n+y\n-z\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n+w\n';
const run = { repoPath: '/r', repoName: 'o/r', taskId: 'gh-3', timestamp: '2026-07-06T09:00:00Z', stages: ['implementer'], totalCostUsd: 0.42, anyFailed: false, prUrl: 'https://github.com/o/r/pull/3' };

function hub(): { fetchImpl: typeof fetch; emit: (f: string) => void; push: (n: number) => void; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let log: { id: number; ts: string; event: string; data: unknown }[] = [];
  const add = (n: number): void => {
    for (let i = 0; i < n; i++) log.push({ id: log.length + 1, ts: '2026-07-06T10:00:00Z', event: 'note', data: `line ${log.length + 1}` });
  };
  const fetchImpl = (async (input: string, init?: { body?: string }) => {
    if (input.endsWith('/events')) return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }) };
    const args = init?.body ? JSON.parse(init.body) : {};
    const reply = (result: unknown) => ({ status: 200, json: async () => ({ result }) });
    if (input.includes('list_runs_all')) return reply({ runs: [run, { ...run, taskId: 'gh-9', timestamp: '2026-07-07T09:00:00Z', anyFailed: true, prUrl: undefined }], failures: [] });
    if (input.includes('list_projects')) return reply([{ path: '/r', name: 'o/r' }]);
    if (input.includes('list_tasks_all')) return reply({ tasks: [{ id: 'gh-3', title: 'Fix it', repoPath: '/r' }, { id: 'gh-5', title: 'Live one', repoPath: '/r' }], capped: false, failures: [] });
    if (input.includes('list_active')) return reply([{ taskId: 'gh-5', sessionFile: 's', lastActivityMs: Date.now() }]);
    if (input.includes('read_run_events')) {
      const after = args.after ?? 0;
      const events = log.filter((e) => e.id > after);
      return reply({ events, nextAfter: log.at(-1)?.id ?? after, hasMore: false, truncated: false });
    }
    if (input.includes('read_run')) return reply({ taskId: 'gh-3', timestamp: run.timestamp, stages: [{ record: { stage: 'implementer', completed: true, model: 'opus' }, diff: DIFF }], prUrl: 'https://github.com/o/r/pull/3', diffUrl: 'http://insecure/x', ciUrl: 'https://ci/x' });
    return reply(null);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    emit: (f) => controller.enqueue(new TextEncoder().encode(f)),
    push: (n) => add(n),
    end: () => void log.push({ id: log.length + 1, ts: '2026-07-06T10:01:00Z', event: 'api:event', data: { runId: 'x', event: { type: 'run-end' } } }),
  };
}
const renderRuns = (fetchImpl: typeof fetch): ReturnType<typeof render> =>
  render(<SafeAreaProvider initialMetrics={METRICS}><RunsScreen credentials={creds} fetchImpl={fetchImpl} /></SafeAreaProvider>);

test('active runs are listed above finished ones with title, repo, status, cost and age', async () => {
  await renderRuns(hub().fetchImpl);
  const live = await screen.findByText('Live one');
  const fin = screen.getByText('Fix it');
  const titles = screen.getAllByText(/^(Live one|Fix it|gh-9)$/).map((n) => n.props.children);
  expect(titles.indexOf('Live one')).toBe(0);
  expect(live).toBeTruthy();
  expect(fin).toBeTruthy();
  expect(screen.getByText(/o\/r · running · \d+s ago/)).toBeTruthy();
  expect(screen.getByText(/o\/r · PR open · \$0\.42 · /)).toBeTruthy();
  expect(screen.getByText(/gh-9/)).toBeTruthy();
});

test('unreachable hub says so', async () => {
  await renderRuns((async () => { throw new Error('Network request failed'); }) as unknown as typeof fetch);
  expect(await screen.findByText('Hub unreachable')).toBeTruthy();
});

test('an empty hub says no runs yet', async () => {
  const empty = (async (input: string) => ({ status: 200, json: async () => ({ result: input.includes('list_runs_all') ? { runs: [], failures: [] } : input.includes('list_tasks_all') ? { tasks: [], capped: false, failures: [] } : [] }) })) as unknown as typeof fetch;
  await renderRuns(empty);
  expect(await screen.findByText('No runs yet')).toBeTruthy();
});

test('active run view appends lines, stays bounded and stops when the run ends', async () => {
  const h = hub();
  h.push(3);
  await renderRuns(h.fetchImpl);
  await fireEvent.press(await screen.findByText('Live one'));
  expect(await screen.findByText(/note "?line 3/)).toBeTruthy();
  expect(screen.getByText('Live transcript')).toBeTruthy();
  h.push(80);
  await act(async () => h.emit('event: vanguard:changed\ndata: "/r"\n\n'));
  await waitFor(() => expect(screen.getByText(/line 83/)).toBeTruthy());
  expect(screen.queryByText(/line 3"?$/)).toBeNull();
  expect(screen.getAllByText(/note|run-end/).length).toBeLessThanOrEqual(MAX_LINES);
  h.end();
  await act(async () => h.emit('event: vanguard:changed\ndata: "/r"\n\n'));
  await waitFor(() => expect(screen.getByText('Transcript (run ended)')).toBeTruthy());
  expect(screen.getByText('Status: ended')).toBeTruthy();
});

test('finished run view shows the timeline, diff summary and https links only', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  await renderRuns(hub().fetchImpl);
  await fireEvent.press(await screen.findByText('Fix it'));
  expect(await screen.findByText('2 files changed, +3 −1')).toBeTruthy();
  expect(screen.getByText('implementer: completed · opus')).toBeTruthy();
  expect(screen.queryByText('Open files changed')).toBeNull();
  await fireEvent.press(screen.getByText('Open pull request'));
  expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/3');
  expect(screen.getByText('Open CI run')).toBeTruthy();
});

test('diffSummary counts files and changed lines of the last diff', () => {
  expect(diffSummary([{ record: {} as never, diff: DIFF }])).toEqual({ files: 2, added: 3, removed: 1 });
  expect(diffSummary([{ record: {} as never }])).toBeNull();
});
