import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Inspector } from './Inspector';
import { stubHubCalls } from '../../testHub';
import type { RunDetail as RunDetailT } from '../../taskcell-output';
import { DEFAULT_FILTER } from '../../filterState';

const detail: RunDetailT = { taskId: 'hub-1', timestamp: '2026-11-16T10:00:00.000Z', stages: [] };

vi.mock('../../ipc', () => ({
  listRunsAll: vi.fn(async () => ({ runs: [], failures: [] })),
  listTasksAll: vi.fn(async () => ({ tasks: [] })),
  apiCapabilitiesCached: vi.fn(async () => ({ flows: [] })),
  readRun: vi.fn(async () => detail),
  readRunEvents: vi.fn(async () => ({
    events: [{ id: 1, ts: '2026-11-16T10:00:00.000Z', event: 'api:event', data: { runId: 'run-1', event: { type: 'run-start', taskId: 'hub-1', flow: 'plan', stages: ['implementer'] } } }],
    nextAfter: 1,
    hasMore: false,
    truncated: false,
  })),
}));
// The children under test elsewhere: RunDetail shows the flow it is handed.
vi.mock('./RunDetail', () => ({ RunDetail: ({ flow }: { flow?: string }) => <div data-testid="run-detail">{flow ?? 'no flow'}</div> }));
vi.mock('./LiveRun', () => ({ LiveRun: ({ repo }: { repo: string }) => <div data-testid="live-run">{repo}</div> }));
vi.mock('../needs-you/CardAnswer', () => ({ CardAnswer: () => null }));
vi.mock('../board/TaskBoard', () => ({ TaskBoard: () => null }));
import { readRunEvents } from '../../ipc';

beforeEach(() => {
  stubHubCalls({
    list_runs: async () => [],
    list_active: async () => [],
    list_tasks: async () => ({ tasks: [] }) as never,
    watch_project: async () => undefined as never,
    unwatch_project: async () => undefined as never,
    api_repo_ok: async () => true,
    api_active_run: async () => null,
    api_queue: async () => [],
    read_app_config_strict: async () => ({}) as never,
  });
});
afterEach(() => vi.restoreAllMocks());

test("a run opened as the plain detail shows the flow its event log's run-start names", async () => {
  render(
    <Inspector
      project="/repo"
      projects={[]}
      allRepos={false}
      filter={DEFAULT_FILTER}
      onFilter={() => {}}
      screen="board"
      settingsSection="general"
      onSettingsSection={() => {}}
      focusRunning={null}
      focusRun={{ taskId: detail.taskId, timestamp: detail.timestamp } as never}
      clearNonce={0}
      newTaskNonce={0}
      onCrumb={() => {}}
      onTaskCrumb={() => {}}
      onNewTask={() => {}}
      onOpenBoard={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getByTestId('run-detail')).toHaveTextContent('plan'));
  expect(readRunEvents).toHaveBeenCalledWith('/repo', 'hub-1', detail.timestamp);
});

test("a live run is read from its own repository, else the open project's", async () => {
  const props = {
    project: '/repo', projects: [], allRepos: false, filter: DEFAULT_FILTER, onFilter: () => {}, screen: 'board' as const, settingsSection: 'general' as const,
    onSettingsSection: () => {}, clearNonce: 0, newTaskNonce: 0, onCrumb: () => {}, onTaskCrumb: () => {}, onNewTask: () => {}, onOpenBoard: () => {},
  };
  const live = { taskId: 'hub-1', sessionFile: '/s', lastActivityMs: 0 };
  const { rerender, unmount } = render(<Inspector {...props} focusRunning={null} focusRun={null as never} />);
  rerender(<Inspector {...props} focusRunning={{ ...live, repoPath: '/other' } as never} focusRun={null as never} />);
  await waitFor(() => expect(screen.getByTestId('live-run')).toHaveTextContent('/other'));
  unmount();
  const second = render(<Inspector {...props} focusRunning={null} focusRun={null as never} />);
  second.rerender(<Inspector {...props} focusRunning={live as never} focusRun={null as never} />);
  await waitFor(() => expect(screen.getByTestId('live-run')).toHaveTextContent('/repo'));
});
