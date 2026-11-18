import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Home } from './Home';
import type { BoardTask, FactoryState, LocalWorkerState, Project, RunSummary } from '../../wire';
import type { StampedNeeds } from './homeModel';

const NOW = Date.now();
const project = (name: string, extra: Partial<Project> = {}): Project => ({ path: `/r/${name}`, name, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0, ...extra });
const alpha = project('alpha', { runningCount: 1, taskSource: 'github', runLocation: 'local' });
const beta = project('beta', { taskSource: 'github', runLocation: 'github-actions' });
const idle = project('idle');
const card = (id: string, column: BoardTask['column'], p: Project, extra: Partial<BoardTask> = {}): BoardTask & { repoPath: string; repoName: string } => ({ id, title: `Card ${id}`, column, state: '', repoPath: p.path, repoName: p.name, ...extra });
const needsItem: StampedNeeds = { id: 'o/alpha#7', kind: 'pr', number: 7, repoSlug: 'o/alpha', title: 'Ready PR', url: 'https://github.com/o/alpha/pull/7', reason: 'taskcell:needs-human-review', repoPath: alpha.path, repoName: 'alpha' };

let tasks: unknown[] = [];
let runs: unknown[] = [];
let activity: unknown[] = [];
const calls: string[] = [];
// A test holds list_tasks_all open with this; `emit` plays a hub event to the page.
let gate: Promise<void> | null = null;
let emit: (name: string, data: unknown) => void = () => {};

beforeEach(() => {
  tasks = [];
  runs = [];
  activity = [];
  gate = null;
  calls.length = 0;
  window.__TASKCELL_HUB__ = true;
  // Home subscribes to the hub's event stream.
  vi.stubGlobal(
    'EventSource',
    class {
      private on = new Map<string, Set<(e: MessageEvent) => void>>();
      constructor() {
        emit = (name, data) => this.on.get(name)?.forEach((l) => l(new MessageEvent(name, { data: JSON.stringify(data) })));
      }
      addEventListener(n: string, l: (e: MessageEvent) => void): void {
        this.on.set(n, (this.on.get(n) ?? new Set()).add(l));
      }
      removeEventListener(n: string, l: (e: MessageEvent) => void): void {
        this.on.get(n)?.delete(l);
      }
      close(): void {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      calls.push(cmd);
      if (cmd === 'list_tasks_all') await gate;
      const result =
        cmd === 'list_tasks_all' ? { tasks, capped: false, failures: [] } : cmd === 'list_runs_all' ? { runs, failures: [] } : cmd === 'list_activity' ? activity : cmd === 'list_active' ? [{ taskId: 'gh-owner-alpha-1', sessionFile: '/s', lastActivityMs: NOW }] : null;
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

function mount(over: Partial<Parameters<typeof Home>[0]> = {}) {
  const props = {
    project: alpha.path,
    projects: [alpha, beta, idle],
    repoPaths: [alpha.path, beta.path, idle.path],
    needs: { items: [needsItem], failures: [] },
    needsError: null,
    onReloadNeeds: vi.fn(),
    factoryStates: {} as Record<string, FactoryState>,
    localWorkers: {} as Record<string, LocalWorkerState>,
    onOpenRunning: vi.fn(),
    onEnterProject: vi.fn(),
    onSeeAllMoving: vi.fn(),
    onOpenFactory: vi.fn(),
    onOpenBoard: vi.fn(),
    ...over,
  };
  const { rerender } = render(<Home {...props} />);
  return { ...props, rerender: (o: Partial<Parameters<typeof Home>[0]>) => rerender(<Home {...props} {...o} />) };
}

test('says what waits and what moves, lists the inbox, Moving, the floor and the week', async () => {
  tasks = [card('gh-1', 'running', alpha, { stage: 'reviewer' }), card('gh-2', 'claimed', beta), card('gh-3', 'running', beta, { paused: { reason: 'provider-limit' } }), card('gh-4', 'review', beta)];
  runs = [{ taskId: 'gh-9', timestamp: new Date(NOW - 1000).toISOString(), stages: [], totalCostUsd: 2.5, anyFailed: false, repoPath: beta.path, repoName: 'beta', prState: 'merged' } satisfies RunSummary & { repoPath: string; repoName: string }];
  mount();
  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('1 card waits for you.');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('2 are moving, 1 paused by a provider limit.'));
  // Waiting for you
  expect(screen.getByText('Ready PR')).toBeInTheDocument();
  expect(screen.getByText('PR ready')).toBeInTheDocument();
  // Moving: the two moving cards, the paused one, and the live run no card explains.
  const moving = await screen.findByRole('region', { name: 'Moving' });
  expect(within(moving).getByText('Card gh-1')).toBeInTheDocument();
  expect(within(moving).getByText(/Review: Review/)).toBeInTheDocument();
  expect(within(moving).getByText('Paused')).toBeInTheDocument();
  expect(within(moving).getByText(/add credit or switch the model/)).toBeInTheDocument();
  // The floor folds the idle project and names the stations in one image per project.
  const floor = screen.getByRole('region', { name: 'Cards by station' });
  expect(within(floor).getByText('and 1 idle project')).toBeInTheDocument();
  expect(within(floor).getByText(/Each card passes these stations: Card → Spec \(plan\)/)).toBeInTheDocument();
  expect(within(floor).getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toContainEqual(expect.stringContaining('PR: 0 cards'));
  // This week
  const week = screen.getByRole('complementary', { name: 'This week' });
  expect(week).toHaveTextContent('1 pull request merged. Spend so far $2.50.');
  expect(week).toHaveTextContent('Last 7 days');
});

test('the week counts failed and self-fixed runs, and the feed lists team and factory events in the shown repositories', async () => {
  const at = (ago: number): string => new Date(NOW - ago).toISOString();
  const r = (taskId: string, extra: Partial<RunSummary>): RunSummary & { repoPath: string; repoName: string } => ({ taskId, timestamp: at(1000), stages: [], totalCostUsd: 1, anyFailed: false, repoPath: beta.path, repoName: 'beta', ...extra });
  runs = [r('gh-1', { prState: 'merged' }), r('gh-2', { anyFailed: true }), r('gh-3', { extraAttempts: 2 })];
  activity = [
    { time: at(60_000), kind: 'pr-merged', repoPath: beta.path, repoName: 'beta', login: 'ann', subject: '#12' },
    { time: at(120_000), kind: 'settings-changed', repoPath: alpha.path, repoName: 'alpha', login: 'token', keys: ['budgetUsd'] },
    { time: at(180_000), kind: 'card-created', repoPath: '/r/hidden', repoName: 'hidden', login: 'bob' },
  ];
  mount();
  const week = screen.getByRole('complementary', { name: 'This week' });
  await waitFor(() => expect(week).toHaveTextContent('1 pull request merged, 1 failed, 1 passed after extra attempts. Spend so far $3.00.'));
  const feed = await screen.findByRole('region', { name: 'Team and factory' });
  expect(within(feed).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('ann merged PR #12'), expect.stringContaining('You changed settings: budgetUsd')]);
  expect(calls.filter((c) => c === 'list_activity')).toHaveLength(1);
});

test('nothing waiting reads as one calm sentence', async () => {
  mount({ needs: { items: [], failures: [] } });
  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Nothing waits for you.');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nothing is moving.'));
});

test('the can’t-start banner appears only when a waiting card meets a broken runner', async () => {
  tasks = [card('gh-5', 'queued', alpha, { waiting: true })];
  const onOpenFactory = vi.fn();
  const worker = { enabled: false, credentials: { names: [], present: true } } satisfies LocalWorkerState;
  mount({ localWorkers: { [alpha.path]: worker }, onOpenFactory });
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent("1 card can't start.");
  expect(banner).toHaveTextContent('The Local hub worker for alpha is off.');
  fireEvent.click(within(banner).getByRole('button', { name: 'Open auto-run' }));
  expect(onOpenFactory).toHaveBeenCalledWith({ path: alpha.path, name: 'alpha' });
});

test('no banner while the worker is healthy', async () => {
  tasks = [card('gh-5', 'queued', alpha, { waiting: true })];
  mount({ localWorkers: { [alpha.path]: { enabled: true, credentials: { names: [], present: true } } } });
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(calls).toContain('list_tasks_all'));
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelector('[data-cant-start]')).toBeNull();
});

test('a Moving row with a live run opens it; one without opens its project; See all goes to the Board', async () => {
  tasks = [card('gh-1', 'running', alpha), card('gh-2', 'running', beta)];
  const props = mount();
  const moving = await screen.findByRole('region', { name: 'Moving' });
  fireEvent.click(within(moving).getByText('Card gh-1'));
  expect(props.onOpenRunning).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'gh-owner-alpha-1', repoPath: alpha.path }));
  fireEvent.click(within(moving).getByText('Card gh-2'));
  expect(props.onEnterProject).toHaveBeenCalledWith(beta.path);
  fireEvent.click(within(moving).getByRole('button', { name: /^See all 2 on the Board/ }));
  expect(props.onSeeAllMoving).toHaveBeenCalled();
});

test('a floor row opens that project’s Board', async () => {
  tasks = [card('gh-4', 'review', beta)];
  const props = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Open beta on the Board' }));
  expect(props.onEnterProject).toHaveBeenCalledWith(beta.path);
});

test('live runs are asked for only in projects the hub says are running, and runs are read once, not on a timer', async () => {
  mount();
  await waitFor(() => expect(calls).toContain('list_active'));
  expect(calls.filter((c) => c === 'list_active')).toHaveLength(1);
  expect(calls.filter((c) => c === 'list_runs_all')).toHaveLength(1);
});

test('a change that arrives while a read is out triggers one trailing read', async () => {
  let release = (): void => {};
  gate = new Promise<void>((r) => (release = r));
  mount();
  await waitFor(() => expect(calls.filter((c) => c === 'list_tasks_all')).toHaveLength(1));
  await waitFor(() => expect(calls).toContain('list_runs_all'));
  emit('vanguard:changed', alpha.path);
  emit('vanguard:changed', alpha.path);
  gate = null;
  release();
  await waitFor(() => expect(calls.filter((c) => c === 'list_tasks_all')).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.filter((c) => c === 'list_tasks_all')).toHaveLength(2);
});

test('after the scope changes the old scope’s data is not shown while the new read is out', async () => {
  tasks = [card('gh-1', 'running', alpha)];
  const m = mount();
  await screen.findByText('Card gh-1');
  let release = (): void => {};
  gate = new Promise<void>((r) => (release = r));
  m.rerender({ repoPaths: [beta.path], teamId: 'other', needs: null });
  await waitFor(() => expect(screen.queryByText('Card gh-1')).toBeNull());
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByText('Card gh-1')).toBeNull();
  release();
});

test('first paint is one skeleton until the cards and runs arrive: no half headline, no empty floor', async () => {
  let release = (): void => {};
  gate = new Promise<void>((r) => (release = r));
  tasks = [card('gh-1', 'running', alpha)];
  mount();
  expect(screen.getByRole('status', { name: 'Loading Home' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Cards by station' })).toBeNull();
  release();
  // Both lines of the headline arrive together.
  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('1 card waits for you.1 is moving.');
  expect(screen.queryByRole('status', { name: 'Loading Home' })).toBeNull();
});

test('an opened card question links to its card and to the run that asked', async () => {
  const asked = { kind: 'card' as const, id: 'hub-4', number: 4, repoSlug: '', title: 'Validate the config', url: '', repoPath: alpha.path, repoName: 'alpha', lastComment: { author: 'agent', body: 'Which file?' } };
  const old = { taskId: 'hub-4', timestamp: new Date(NOW - 9000).toISOString(), stages: [], totalCostUsd: 0.1, anyFailed: false, repoPath: alpha.path, repoName: 'alpha' };
  const newest = { ...old, timestamp: new Date(NOW - 1000).toISOString(), asked: 'Which file?' };
  runs = [old, newest] as typeof runs;
  const onOpenCard = vi.fn();
  const onOpenRun = vi.fn();
  mount({ needs: { items: [asked as never], failures: [] }, onOpenCard, onOpenRun });
  fireEvent.click(await screen.findByRole('button', { name: 'Answer Validate the config' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open the card' }));
  expect(onOpenCard).toHaveBeenCalledWith({ id: 'hub-4', title: 'Validate the config', repoPath: alpha.path });
  fireEvent.click(await screen.findByRole('button', { name: /Open the run/ }));
  expect(onOpenRun.mock.calls[0]![0].timestamp).toBe(newest.timestamp);
});
