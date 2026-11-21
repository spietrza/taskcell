import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RunsScreen } from './RunsScreen';
import { MAX_LINES, diffSummary } from './runs';

const creds = { url: 'http://hub.local:4317', token: 't' };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const DIFF = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n+x\n+y\n-z\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n+w\n';
const run = { repoPath: '/r', repoName: 'o/r', taskId: 'gh-3', timestamp: '2026-07-06T09:00:00Z', stages: ['implementer'], totalCostUsd: 0.42, anyFailed: false, prUrl: 'https://github.com/o/r/pull/3' };

afterEach(() => jest.restoreAllMocks());

type Hub = { fetchImpl: typeof fetch; emit: (f: string) => void; push: (n: number) => void; end: (ts?: string) => void; reads: () => number; reset: () => void };
function hub(): Hub {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let log: { id: number; ts: string; event: string; data: unknown }[] = [];
  let reads = 0;
  const add = (n: number): void => {
    for (let i = 0; i < n; i++) log.push({ id: log.length + 1, ts: new Date().toISOString(), event: 'note', data: `line ${log.length + 1}` });
  };
  const fetchImpl = (async (input: string, init?: { body?: string }) => {
    if (input.endsWith('/events')) return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }) };
    const args = init?.body ? JSON.parse(init.body) : {};
    const reply = (result: unknown) => ({ status: 200, json: async () => ({ result }) });
    if (input.includes('list_runs_all')) return reply({ runs: [run, { ...run, taskId: 'gh-9', timestamp: '2026-07-07T09:00:00Z', anyFailed: true, prUrl: undefined }], failures: [] });
    if (input.includes('list_projects')) return reply([{ path: '/r', name: 'o/r' }]);
    if (input.includes('list_tasks_all')) return reply({ tasks: [{ id: 'gh-3', title: 'Fix it', repoPath: '/r', url: 'https://github.com/o/r/issues/3' }, { id: 'gh-5', title: 'Live one', repoPath: '/r', url: 'http://insecure/5' }], capped: false, failures: [] });
    if (input.includes('list_active')) return reply([{ taskId: 'gh-5', sessionFile: 's', lastActivityMs: Date.now() }]);
    if (input.includes('read_run_events')) {
      reads += 1;
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
    end: (ts = new Date().toISOString()) => void log.push({ id: log.length + 1, ts, event: 'api:event', data: { runId: 'x', event: { type: 'run-end' } } }),
    reads: () => reads,
    reset: () => void (log = []),
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

test('an older run\'s ended log does not end the active run; its own log is read from the start', async () => {
  const h = hub();
  h.push(2);
  h.end('2026-07-06T10:01:00Z');
  await renderRuns(h.fetchImpl);
  await fireEvent.press(await screen.findByText('Live one'));
  await waitFor(() => expect(h.reads()).toBeGreaterThan(0));
  expect(screen.getByText('Live transcript')).toBeTruthy();
  expect(screen.getByText('Status: running')).toBeTruthy();
  expect(screen.getByText('No events yet.')).toBeTruthy();
  h.reset();
  h.push(1);
  await act(async () => h.emit('event: vanguard:changed\ndata: "/r"\n\n'));
  expect(await screen.findByText(/note "?line 1/)).toBeTruthy();
  expect(screen.getByText('Status: running')).toBeTruthy();
});

test('the run view reads only on events for its run', async () => {
  const h = hub();
  h.push(1);
  await renderRuns(h.fetchImpl);
  await fireEvent.press(await screen.findByText('Live one'));
  expect(await screen.findByText(/note "?line 1/)).toBeTruthy();
  await waitFor(() => expect(h.reads()).toBeGreaterThan(0));
  const before = h.reads();
  await act(async () => h.emit('event: vanguard:changed\ndata: "/other"\n\n'));
  await act(async () => h.emit('event: api:event\ndata: {"runId":"y","event":{"type":"stage-start"}}\n\n'));
  expect(h.reads()).toBe(before);
  await act(async () => h.emit('event: api:event\ndata: {"runId":"y","event":{"type":"run-start","taskId":"gh-5"}}\n\n'));
  await waitFor(() => expect(h.reads()).toBe(before + 1));
  await act(async () => h.emit('event: api:event\ndata: {"runId":"y","event":{"type":"stage-start"}}\n\n'));
  await waitFor(() => expect(h.reads()).toBe(before + 2));
});

test('an active run view offers no link for a non-https issue url', async () => {
  const h = hub();
  await renderRuns(h.fetchImpl);
  await fireEvent.press(await screen.findByText('Live one'));
  await waitFor(() => expect(h.reads()).toBeGreaterThan(0));
  expect(screen.queryByText('Open issue')).toBeNull();
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
  await fireEvent.press(screen.getByText('Open issue'));
  expect(open).toHaveBeenCalledWith('https://github.com/o/r/issues/3');
});

test('diffSummary counts files and changed lines of the last diff', () => {
  expect(diffSummary([{ record: {} as never, diff: DIFF }])).toEqual({ files: 2, added: 3, removed: 1 });
  expect(diffSummary([{ record: {} as never }])).toBeNull();
});


const runsHub = (runs: unknown[], caps: unknown, retry: { refuse?: string }): { fetchImpl: typeof fetch; calls: { cmd: string; args: unknown }[] } => {
  const calls: { cmd: string; args: unknown }[] = [];
  const fetchImpl = (async (input: string, init?: { body?: string }) => {
    const cmd = input.split('/rpc/')[1] ?? '';
    const reply = (result: unknown) => ({ status: 200, json: async () => ({ result }) });
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    if (cmd === 'list_runs_all') return reply({ runs, failures: [] });
    if (cmd === 'list_tasks_all') return reply({ tasks: [], capped: false, failures: [] });
    if (cmd === 'list_projects') return reply([]);
    if (cmd === 'caller_capabilities') return reply(caps);
    if (cmd === 'read_run') return reply({ taskId: 'x', timestamp: run.timestamp, stages: [] });
    calls.push({ cmd, args: JSON.parse(init?.body ?? '{}') });
    return retry.refuse ? { status: 400, json: async () => ({ error: { message: retry.refuse } }) } : reply({ label: 'x' });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};
const ALLOW = { project: { canStartTask: { allowed: true } } };
const confirmWith = (label: string) =>
  jest.spyOn(Alert, 'alert').mockImplementation((...a: unknown[]) => (a[2] as { text: string; onPress?: () => void }[]).find((x) => x.text === label)?.onPress?.());

test.each([
  ['gh-9', { stoppedBy: 'rate-limit' }, 'retry_paused_task', { repoPath: '/r', number: 9 }],
  ['hub-4', { anyFailed: true }, 'hub_task_retry', { repoPath: '/r', id: 'hub-4' }],
])('Re-run of %s calls %s after the dialog; cancel sends nothing', async (taskId, extra, cmd, args) => {
  const { fetchImpl, calls } = runsHub([{ ...run, taskId, prUrl: undefined, anyFailed: false, ...extra }], ALLOW, {});
  await renderRuns(fetchImpl);
  await fireEvent.press(await screen.findByText(taskId));
  const alert = confirmWith('Cancel');
  await fireEvent.press(await screen.findByText('Re-run'));
  expect(alert.mock.calls[0]![1]).toBe(taskId);
  expect(calls).toEqual([]);
  alert.mockRestore();
  confirmWith('Re-run');
  await fireEvent.press(screen.getByText('Re-run'));
  await screen.findByText('Re-run requested.');
  expect(calls).toEqual([{ cmd, args }]);
});

test('Re-run shows a hub refusal; it is absent for a read-only caller and for runs the hub would refuse', async () => {
  const failedGh = { ...run, taskId: 'gh-9', prUrl: undefined, anyFailed: true };
  const refused = runsHub([{ ...run, taskId: 'hub-4', prUrl: undefined, anyFailed: true }], ALLOW, { refuse: 'not failed' });
  const first = await renderRuns(refused.fetchImpl);
  await fireEvent.press(await screen.findByText('hub-4'));
  confirmWith('Re-run');
  await fireEvent.press(await screen.findByText('Re-run'));
  await screen.findByText(/not failed/);
  await first.unmount();
  const ro = runsHub([{ ...run, taskId: 'hub-4', prUrl: undefined, anyFailed: true }], { project: { canStartTask: { allowed: false } } }, {});
  const second = await renderRuns(ro.fetchImpl);
  await fireEvent.press(await screen.findByText('hub-4'));
  await screen.findByText(/Status: failed/);
  await waitFor(() => expect(screen.queryByText('Re-run')).toBeNull());
  await second.unmount();
  await renderRuns(runsHub([failedGh], ALLOW, {}).fetchImpl); // a failed (not paused) GitHub run
  await fireEvent.press(await screen.findByText('gh-9'));
  await screen.findByText(/Status: failed/);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText('Re-run')).toBeNull();
});
