import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Fleet } from './Fleet';
import type { BoardTask } from '../../wire';

import type { AppConfig } from '../../taskcell-output';
import { stubHubCalls } from '../../testHub';

vi.mock('../../transport', async (orig) => ({ ...(await orig<typeof import('../../transport')>()), subscribe: vi.fn(async () => () => {}) }));
const mockListTasks = vi.fn<(repoPath: string) => Promise<{ tasks: BoardTask[]; capped: boolean }>>();
const readAppConfigStrict = vi.fn<() => Promise<AppConfig>>();
const spawnRun = vi.fn<() => Promise<number>>();
let hubCall: ReturnType<typeof stubHubCalls>;
beforeEach(() => {
  mockListTasks.mockReset();
  readAppConfigStrict.mockReset().mockResolvedValue({});
  spawnRun.mockReset();
  hubCall = stubHubCalls({
    list_spawns: async () => [],
    list_tasks: ({ repoPath }) => mockListTasks(repoPath),
    read_app_config_strict: () => readAppConfigStrict(),
    spawn_run: () => spawnRun(),
    kill_run: async () => undefined,
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Fleet watch loop launch — repo config cannot inject', () => {
  test('a provider carrying shell syntax is refused and nothing is spawned', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    readAppConfigStrict.mockResolvedValueOnce({ provider: 'claude; touch /tmp/x #' });
    render(<Fleet project="/repo" active={[]} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByLabelText('Toggle watch loop')));
    expect(await screen.findByText(/Invalid provider/)).toBeInTheDocument();
    expect(hubCall).not.toHaveBeenCalledWith('spawn_run', expect.anything());
  });

  test('a valid config is spawned as an argv, not a shell string', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    readAppConfigStrict.mockResolvedValueOnce({ provider: 'codex' });
    spawnRun.mockResolvedValueOnce(7);
    render(<Fleet project="/repo" active={[]} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByLabelText('Toggle watch loop')));
    expect(hubCall).toHaveBeenCalledWith('spawn_run', { cwd: '/repo', argv: [
      'taskcell', 'watch', '--github', '--concurrency', '3', '--provider', 'codex', '--max-turns', '30',
    ] });
  });
});

function waitingTask(id: string): BoardTask {
  return { id, title: id, column: 'queued', state: 'ready for spec', waiting: true };
}
const WAITING_FOUR: BoardTask[] = ['a', 'b', 'c', 'd'].map(waitingTask);

describe('Fleet slot meter — waiting count (T18–T20)', () => {
  test('T18: Fleet fetches the task list itself on mount — no prior board visit needed', async () => {
    mockListTasks.mockResolvedValue({ tasks: WAITING_FOUR, capped: false });
    render(<Fleet project="/repo" active={[]} />);
    expect(await screen.findByText('Slots 0 / 3 in use · 4 waiting')).toBeInTheDocument();
    expect(hubCall).toHaveBeenCalledWith('list_tasks', { repoPath: '/repo' });
  });

  test('another repository’s running runs do not take this project’s slots', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    const run = (taskId: string, repoPath?: string) => ({ taskId, sessionFile: '/s', lastActivityMs: 0, ...(repoPath ? { repoPath } : {}) });
    render(<Fleet project="/repo" active={[run('MINE', '/repo'), run('OTHER', '/other'), run('LOCAL')]} />);
    expect(await screen.findByText('Slots 2 / 3 in use · 0 waiting')).toBeInTheDocument();
    expect(screen.queryByText('OTHER')).toBeNull();
  });

  test('T18b: a capped list makes the count a lower bound', async () => {
    mockListTasks.mockResolvedValue({ tasks: WAITING_FOUR, capped: true });
    render(<Fleet project="/repo" active={[]} />);
    expect(await screen.findByText('Slots 0 / 3 in use · 4+ waiting')).toBeInTheDocument();
  });

  test('T19: while loading, and if the fetch fails, the meter stays bare — never `0`', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<Fleet project="/repo" active={[]} />);
    expect(screen.getByText('Slots 0 / 3 in use')).toBeInTheDocument(); // still loading
    // Let the rejection settle — asserting before it does would pass against the loading state and
    // never exercise the error branch at all.
    await act(async () => {});
    expect(mockListTasks).toHaveBeenCalled();
    expect(screen.getByText('Slots 0 / 3 in use')).toBeInTheDocument();
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
  });

  test('T20: a fetched zero is a real answer — only an unknown count suppresses', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    render(<Fleet project="/repo" active={[]} />);
    expect(await screen.findByText('Slots 0 / 3 in use · 0 waiting')).toBeInTheDocument();
  });
});
