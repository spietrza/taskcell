import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { paletteItems } from '../../paletteIndex';
import { TaskBoard } from './TaskBoard';
import { DEFAULT_FILTER } from '../../filterState';
import type { BoardTask } from '../../wire';

vi.mock('../../ipc', () => ({
  callerCapabilities: vi.fn(async () => ({ mutationsAllowed: true, owner: true, admin: true, canAddProject: { allowed: true }, teamRoles: {} })),
  listTasksAll: vi.fn(),
  readRun: vi.fn(),
  hubTaskCreate: vi.fn().mockResolvedValue({ id: 'hub-2' }),
  hubTaskSchedule: vi.fn().mockResolvedValue({ id: 'hub-1' }),
  fetchSpec: vi.fn(async () => 'The issue body.'),
}));
import { listTasksAll } from '../../ipc';
import { stubHubCalls, type HubCall } from '../../testHub';
const mockListTasks = vi.fn<HubCall<'list_tasks'>>();
const listNeedsYou = vi.fn<HubCall<'list_needs_you'>>(async () => ({ items: [] }));
let hubCall: ReturnType<typeof stubHubCalls>;

beforeEach(() => {
  vi.clearAllMocks();
  window.__TASKCELL_HUB__ = true;
  hubCall = stubHubCalls({
    list_tasks: mockListTasks,
    list_runs: async () => [],
    list_needs_you: listNeedsYou,
    needs_you_comment: async () => ({}),
    retry_paused_task: async () => ({ label: 'ready for agent' }),
    list_skills: async () => ({ skills: ['db', 'release'] }),
    set_task_skills: async ({ skills }) => ({ skills }),
    read_app_config_strict: async () => ({}),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A lane is a station column (a group named by its label); scope queries to it so a task asserted
// "in Cell" really renders under Cell, not just somewhere on the board.
const lane = (label: string): HTMLElement => screen.getByRole('group', { name: label });

const TASKS: BoardTask[] = [
  { id: 't-q1', title: 'Queued one', column: 'queued', state: 'Todo' },
  { id: 't-q2', title: 'Queued two', column: 'queued', state: 'Todo' },
  { id: 't-r1', title: 'Running one', column: 'running', state: 'In Progress' },
  { id: 't-v1', title: 'Verify one', column: 'verify-failed', state: 'changes-requested' },
  { id: 't-d1', title: 'Done one', column: 'done', state: 'done' },
];

const COUNTS_TASKS: BoardTask[] = [
  { id: 't-c1', title: 'Claimed one', column: 'claimed', state: 'speccing' },
  { id: 't-r1', title: 'Running one', column: 'running', state: 'In Progress' },
  { id: 't-w1', title: 'Waiting one', column: 'queued', state: 'ready for spec', waiting: true },
  { id: 't-w2', title: 'Waiting two', column: 'queued', state: 'ready for agent', waiting: true },
];

describe('TaskBoard on a hub-board project', () => {
  test('a card whose run stopped to ask shows "Waiting for your answer" as needs you', async () => {
    mockListTasks.mockResolvedValue({ tasks: [{ id: 'hub-4', title: 'Validate', column: 'verify-failed', state: 'failed', asked: true, schedule: { state: 'failed', label: 'failed: asked', reason: 'asked' } }], capped: false, hubBoard: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    const words = await screen.findByText('Waiting for your answer');
    expect(words.className).toContain('text-primary-text');
    expect(screen.queryByText('failed: asked')).toBeNull();
  });

  const card = (label: string): BoardTask => ({ id: 'hub-1', title: 'Hub one', column: 'queued', state: label, schedule: { state: 'ready', label } });

  test('New card opens the hub card form on demand (closed at first), and adding reloads and closes it', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false, hubBoard: true });
    const onNewTask = vi.fn();
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={onNewTask} />);
    const open = await screen.findByRole('button', { name: 'New card' });
    expect(screen.queryByRole('form', { name: 'New card' })).not.toBeInTheDocument();
    fireEvent.click(open);
    expect(onNewTask).not.toHaveBeenCalled();
    const form = screen.getByRole('form', { name: 'New card' });
    expect(form).toHaveTextContent('New card in repo (Taskcell board)');
    const calls = mockListTasks.mock.calls.length;
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'A' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add card' }));
    await vi.waitFor(() => expect(mockListTasks.mock.calls.length).toBe(calls + 1));
    expect(screen.queryByRole('form', { name: 'New card' })).not.toBeInTheDocument();
  });

  test('the open quick view shows the card as reloaded after a save, not the snapshot that was clicked', async () => {
    mockListTasks.mockResolvedValueOnce({ tasks: [card('starts next')], capped: false, hubBoard: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    fireEvent.click(await screen.findByText('Hub one'));
    mockListTasks.mockResolvedValueOnce({ tasks: [card('blocked by hub-2')], capped: false, hubBoard: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await vi.waitFor(() => expect(within(screen.getByRole('region', { name: 'Schedule' })).getByText('blocked by hub-2')).toBeInTheDocument());
  });

  test('re-reads an open hub board, so a status change shows without a reload', async () => {
    vi.useFakeTimers();
    mockListTasks.mockResolvedValueOnce({ tasks: [{ ...card('starts next'), title: 'Before' }], capped: false, hubBoard: true });
    mockListTasks.mockResolvedValue({ tasks: [{ ...card('not started: no credential'), title: 'After' }], capped: false, hubBoard: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('Before')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  test('a read slower than the poll interval gets no trailing read', async () => {
    vi.useFakeTimers();
    mockListTasks.mockResolvedValueOnce({ tasks: [card('starts next')], capped: false, hubBoard: true });
    let release: () => void = () => {};
    mockListTasks.mockReturnValueOnce(new Promise((r) => { release = () => r({ tasks: [card('starts next')], capped: false, hubBoard: true }); }));
    mockListTasks.mockResolvedValue({ tasks: [card('starts next')], capped: false, hubBoard: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(mockListTasks).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(11000)); // ticks inside the slow read are dropped
    expect(mockListTasks).toHaveBeenCalledTimes(2);
    release();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mockListTasks).toHaveBeenCalledTimes(2); // and leave no trailing read behind
  });

  test('a tracker board holds a stream-reset re-read for the reconnect gap; a hub board does not', async () => {
    const { hub } = await import('../../transport');
    const live = vi.spyOn(hub(), 'liveRead');
    mockListTasks.mockResolvedValue({ tasks: [TASKS[1]!], capped: false });
    const { unmount } = render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await waitFor(() => expect(live).toHaveBeenCalled());
    expect(live.mock.calls.at(-1)?.[1].reconnectMinMs).toBeGreaterThan(0);
    unmount();
    live.mockClear();
    mockListTasks.mockResolvedValue({ tasks: [card('starts next')], capped: false, hubBoard: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await waitFor(() => expect(live).toHaveBeenCalled());
    expect(live.mock.calls.at(-1)?.[1].reconnectMinMs).toBeUndefined();
  });

  test('polls the all-repositories view and a tracker board too, at the slower tracker cadence', async () => {
    vi.useFakeTimers();
    vi.mocked(listTasksAll).mockResolvedValueOnce({ tasks: [], capped: false, failures: [], hubBoards: [] });
    vi.mocked(listTasksAll).mockResolvedValue({ tasks: [{ ...TASKS[0]!, repoPath: '/r/alpha', repoName: 'alpha' }], capped: false, failures: [], hubBoards: [] });
    const { unmount } = render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} onOpenTask={() => {}} onNewTask={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(vi.mocked(listTasksAll)).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(vi.mocked(listTasksAll)).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Queued one')).toBeInTheDocument();
    unmount();

    mockListTasks.mockResolvedValueOnce({ tasks: [], capped: false });
    mockListTasks.mockResolvedValue({ tasks: [TASKS[1]!], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(mockListTasks).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Queued two')).toBeInTheDocument();
  });

  test('a failed poll keeps the board and a typed draft, shows it is stale, and polling resumes', async () => {
    vi.useFakeTimers();
    mockListTasks.mockResolvedValueOnce({ tasks: [card('starts next')], capped: false, hubBoard: true });
    mockListTasks.mockRejectedValueOnce(new Error('hub down'));
    mockListTasks.mockResolvedValue({ tasks: [{ ...card('starts next'), title: 'Back' }], capped: false, hubBoard: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole('button', { name: 'New card' }));
    const title = within(screen.getByRole('form', { name: 'New card' })).getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'my draft' } });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(mockListTasks).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Hub one')).toBeInTheDocument();
    expect(screen.queryByText('Loading tasks…')).not.toBeInTheDocument();
    expect(screen.getByText('Not refreshed — retrying')).toBeInTheDocument();
    expect(within(screen.getByRole('form', { name: 'New card' })).getByLabelText('Title')).toBe(title);
    expect(title).toHaveValue('my draft');
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(mockListTasks).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Back')).toBeInTheDocument();
    expect(screen.queryByText('Not refreshed — retrying')).not.toBeInTheDocument();
    expect(title).toHaveValue('my draft');
  });

  test('an all-repositories poll that cannot read one repository keeps its cards, the open quick view and typed text', async () => {
    vi.useFakeTimers();
    const seven = { id: 'gh-7', title: 'Seven', column: 'review' as const, state: 'review', source: 'github' as const, repoPath: '/r/alpha', repoName: 'alpha', view: { place: { at: 4, failed: false }, waiting: { id: 'o/r#7', kind: 'issue' as const, number: 7, repoSlug: 'o/r', title: 'Seven', url: 'u', reason: 'taskcell:verify-failed' } } };
    vi.mocked(listNeedsYou).mockResolvedValueOnce({ items: [{ id: 'o/r#7', kind: 'issue', number: 7, repoSlug: 'o/r', title: 'Seven', url: 'u', reason: 'taskcell:verify-failed' }] });
    vi.mocked(listTasksAll).mockResolvedValueOnce({ tasks: [seven], capped: false, failures: [], hubBoards: ['/r/alpha'] });
    vi.mocked(listTasksAll).mockResolvedValue({ tasks: [], capped: false, failures: [{ repoPath: '/r/alpha', repoName: 'alpha', error: 'hub down' }], hubBoards: [] });
    render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} onOpenTask={() => {}} onNewTask={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByText('Seven').closest('button')!);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const reply = screen.getByLabelText('reply to o/r#7');
    fireEvent.change(reply, { target: { value: 'my reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'New card' }));
    const title = within(screen.getByRole('form', { name: 'New card' })).getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'my draft' } });
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(vi.mocked(listTasksAll)).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('complementary', { name: /Quick view: Seven/ })).toBeInTheDocument();
    expect(screen.getByLabelText('reply to o/r#7')).toBe(reply);
    expect(reply).toHaveValue('my reply');
    expect(within(screen.getByRole('form', { name: 'New card' })).getByLabelText('Title')).toBe(title);
    expect(title).toHaveValue('my draft');
    expect(screen.getByText('Not refreshed — retrying')).toBeInTheDocument();
  });

  test('a tracker board keeps New Task and has no hub form', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByRole('button', { name: 'New card' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New card' })).not.toBeInTheDocument();
  });
});

describe('TaskBoard', () => {
  test('skills picked on a card show on it at once and go to the full page (and its New Run form)', async () => {
    mockListTasks.mockResolvedValue({ tasks: [{ id: 'gh-1', title: 'One', column: 'queued', state: 'open', source: 'github', skills: ['db'] }], capped: false });
    const onOpenTask = vi.fn();
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={onOpenTask} onNewTask={() => {}} />);
    const card = (await screen.findByText('One')).closest('button') as HTMLElement;
    expect(card).toHaveTextContent('skills: db');
    fireEvent.click(card);
    const section = await screen.findByRole('region', { name: 'Skills' });
    fireEvent.click(await within(section).findByLabelText('release'));
    fireEvent.click(within(section).getByRole('button', { name: 'Save skills' }));
    await waitFor(() => expect(card).toHaveTextContent('skills: db, release'));
    fireEvent.click(screen.getByRole('button', { name: 'Full page' }));
    expect(onOpenTask).toHaveBeenCalledWith('gh-1', undefined, ['db', 'release']);
  });

  test('the columns are the line\'s stations (Review and PR share one), then Done', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByRole('group', { name: 'Card' });
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')).filter((l) => l !== 'Triage')).toEqual(['Card', 'Spec', 'Cell', 'Gates', 'Review / PR', 'Done']);
  });

  test('every card shows its station: a failed verify is Gates, failed; a running card follows its stage', async () => {
    mockListTasks.mockResolvedValue({ tasks: [...TASKS, { id: 't-s', title: 'Speccing', column: 'running', state: '', stage: 'spec' }], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one');
    expect(within(lane('Gates')).getByRole('img', { name: 'Station: Gates (failed)' })).toBeInTheDocument();
    expect(within(lane('Spec')).getByText('Speccing')).toBeInTheDocument();
    expect(within(lane('Spec')).getByRole('img', { name: 'Station: Spec' })).toBeInTheDocument();
    expect(within(lane('Done')).getByRole('img', { name: 'Station: Done' })).toBeInTheDocument();
  });

  test('?card=<id> opens that card\'s quick view; closing it drops the parameter', async () => {
    window.history.replaceState(null, '', '/?screen=board&card=t-r1');
    try {
      mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
      render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
      const panel = await screen.findByRole('complementary', { name: /Quick view: Running one/ });
      // The effect that focuses the panel also installs the Escape listener: wait for it, not just the render.
      await waitFor(() => expect(panel).toHaveFocus());
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(window.location.search).toBe('?screen=board'));
      fireEvent.click(screen.getByText('Queued two').closest('button')!);
      await waitFor(() => expect(window.location.search).toBe('?screen=board&card=t-q2'));
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  test('?card=<id> hidden by a saved filter opens anyway, with a note and Clear', async () => {
    window.history.replaceState(null, '', '/?screen=board&card=t-r1');
    try {
      mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
      const onFilter = vi.fn();
      render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} filter={{ ...DEFAULT_FILTER, query: 'nothing matches this', repos: ['/repo'] }} onFilter={onFilter} />);
      expect(await screen.findByRole('complementary', { name: /Quick view: Running one/ })).toBeInTheDocument();
      const note = screen.getByText(/t-r1 is hidden by your filters/);
      fireEvent.click(within(note).getByRole('button', { name: 'Clear' }));
      // Clear also resets the project tab, as on Runs.
      expect(onFilter).toHaveBeenCalledWith(expect.objectContaining({ query: '', repos: [] }));
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  test('a card picked in ⌘K while the board is open opens its quick view; the board publishes its cards', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    const props = { project: '/repo', repos: [], onOpenTask: () => {}, onNewTask: () => {} };
    const { rerender } = render(<TaskBoard {...props} />);
    await screen.findByText('Running one');
    expect(paletteItems().cards).toContainEqual({ id: 't-r1', title: 'Running one', repoPath: '/repo' });
    rerender(<TaskBoard {...props} openCard={{ id: 't-r1', title: 'Running one', repoPath: '/repo' }} />);
    expect(await screen.findByRole('complementary', { name: /Quick view: Running one/ })).toBeInTheDocument();
  });

  test('a running card\'s Open the run opens that card\'s run', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    const onOpenRun = vi.fn();
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} onOpenRun={onOpenRun} />);
    fireEvent.click((await screen.findByText('Running one')).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the run' }));
    expect(onOpenRun).toHaveBeenCalledWith('t-r1', undefined);
  });

  test('from xl the columns share the row down to 11rem, so all six fit at 1440; below it they keep their width and scroll', async () => {
    mockListTasks.mockResolvedValueOnce({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one');
    const cls = lane('Review / PR').className.split(' ');
    expect(cls).toEqual(expect.arrayContaining(['w-72', 'shrink-0', 'xl:w-auto', 'xl:min-w-44', 'xl:max-w-72', 'xl:flex-1']));
  });

  test('routes each task to its column lane (guards a col.key typo silently emptying a lane)', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one'); // wait for load

    expect(within(lane('Card')).getByText('Queued one')).toBeInTheDocument();
    expect(within(lane('Card')).getByText('Queued two')).toBeInTheDocument();
    expect(within(lane('Cell')).getByText('Running one')).toBeInTheDocument();
    expect(within(lane('Gates')).getByText('Verify one')).toBeInTheDocument();
    expect(within(lane('Done')).getByText('Done one')).toBeInTheDocument();
  });

  test('shows per-column counts and a placeholder for empty lanes', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one');

    expect(within(lane('Card')).getByText('2')).toBeInTheDocument();
    expect(within(lane('Spec')).getByText('0')).toBeInTheDocument();
    expect(within(lane('Spec')).getByText('No cards')).toBeInTheDocument();
  });

  test('shows the raw backend state only when it differs from the lane key', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Running one');

    // running task: state "In Progress" !== column "running" → shown
    expect(within(lane('Cell')).getByText('In Progress')).toBeInTheDocument();
    // done task: state "done" === column "done" → the redundant state line is suppressed
    expect(within(lane('Done')).queryByText('done')).not.toBeInTheDocument();
  });

  test('renders the error branch when listTasks rejects', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByText(/Couldn't load the Board/)).toBeInTheDocument();
  });

  test('an uncapped list shows exact header counts, as a single text run', async () => {
    mockListTasks.mockResolvedValue({ tasks: COUNTS_TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByText('Running 2 · Queued 2 · Waiting for you 0')).toBeInTheDocument();
  });

  test('a capped list makes both header counts a lower bound', async () => {
    mockListTasks.mockResolvedValue({ tasks: COUNTS_TASKS, capped: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByText('Running 2+ · Queued 2+ · Waiting for you 0+')).toBeInTheDocument();
  });

  test('error branch renders no Running/Waiting text', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText(/Couldn't load the Board/);
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument();
  });
});

test('the cap banner follows the RESPONSE capped flag, not a client-side count (S9)', async () => {
  mockListTasks.mockResolvedValue({ tasks: TASKS, capped: true });
  render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByText(/Showing the first 5 cards/)).toBeInTheDocument();
});

test('T26/T27/T28: stage and verdict pills stay in their intended lanes, with tone classes', async () => {
  const chips: NonNullable<BoardTask['chips']> = [
    { key: 'implementer', label: 'implementer: ok', tone: 'pass' },
    { key: 'reviewer', label: 'reviewer: changes (2)', tone: 'changes' },
    { key: 'proof', label: 'proof: fail', tone: 'failed' },
    { key: 'future', label: 'future gate', tone: 'unknown' as 'pass' },
  ];
  mockListTasks.mockResolvedValue({ capped: false, tasks: [
    { id: 'r', title: 'Running stage', column: 'running', state: '', stage: 'implementer' },
    { id: 'rev', title: 'Review chips', column: 'review', state: '', chips },
    { id: 'done', title: 'Done chips', column: 'done', state: '', chips },
    { id: 'q', title: 'Queued chips', column: 'queued', state: '', chips },
  ] });
  render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
  await screen.findByText('Running stage');
  expect(within(lane('Cell')).getByText('stage: implementer')).toBeInTheDocument();
  for (const label of ['Review / PR', 'Done']) {
    const scope = within(lane(label));
    expect(scope.getByText('implementer: ok').className).toContain('success');
    expect(scope.getByText('reviewer: changes (2)').className).toContain('warning');
    expect(scope.getByText('proof: fail').className).toContain('destructive');
    expect(scope.getByText('future gate').className).toContain('bg-muted');
  }
  expect(within(lane('Card')).queryByText('implementer: ok')).not.toBeInTheDocument();
});

test('T26: a running card without a stage has no stage line', async () => {
  mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
  render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
  await screen.findByText('Running one');
  expect(within(lane('Cell')).queryByText(/^stage:/)).not.toBeInTheDocument();
});

describe('TaskBoard all repositories', () => {
  test('lists every repository, names it on each card, and names a failing one', async () => {
    vi.mocked(listTasksAll).mockResolvedValue({
      tasks: [{ id: 't-1', title: 'From alpha', column: 'queued', state: 'Todo', repoPath: '/r/alpha', repoName: 'alpha' }],
      capped: false,
      failures: [{ repoPath: '/r/beta', repoName: 'beta', error: 'tracker down' }],
    });
    render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha', '/r/beta']} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('From alpha');
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('beta (tracker down)');
  });
});

test('a project with no task source gets a setup hint with a way to Settings, not an error about other repositories', async () => {
  const unset = 'Set a Task Source in Settings to load the board.';
  vi.mocked(listTasksAll).mockResolvedValue({ tasks: [], capped: false, failures: [{ repoPath: '/r/alpha', repoName: 'alpha', error: unset }] });
  const onOpenSettings = vi.fn();
  const all = render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} onOpenTask={() => {}} onNewTask={() => {}} onOpenSettings={onOpenSettings} />);
  expect(await screen.findByRole('note')).toHaveTextContent('alpha has no card source yet. Choose one');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/other repositories/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
  expect(onOpenSettings).toHaveBeenCalled();
  all.unmount();
  mockListTasks.mockRejectedValue(unset);
  render(<TaskBoard project="/r/alpha" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByRole('note')).toHaveTextContent('This project has no card source yet.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

describe('TaskBoard task-source hint scope', () => {
  const unset = 'Set a Task Source in Settings to load the board.';
  const failures = [
    { repoPath: '/r/alpha', repoName: 'alpha', error: unset },
    { repoPath: '/r/qa', repoName: 'qa-repo', error: unset },
  ];
  const repos = ['/r/alpha', '/r/beta', '/r/qa'];
  const beta = { id: 't-1', title: 'From beta', column: 'queued' as const, state: 'Todo', repoPath: '/r/beta', repoName: 'beta' };
  // Renders the board under "All repositories" with `project` open and, when given, a Projects filter.
  const board = (project: string, filterRepos?: string[]): void => {
    const filter = filterRepos && { ...DEFAULT_FILTER, repos: filterRepos };
    render(<TaskBoard project={project} allRepos repos={repos} filter={filter} onOpenTask={() => {}} onNewTask={() => {}} onOpenSettings={() => {}} />);
  };
  beforeEach(() => {
    vi.mocked(listTasksAll).mockResolvedValue({ tasks: [beta], capped: false, failures });
  });

  test('another project open and no Projects filter: every repository is in view, so the hint names all unset ones', async () => {
    board('/r/beta');
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('alpha');
    expect(note).toHaveTextContent('qa-repo');
    expect(within(note).queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });

  test('the Projects filter excludes an unset repository: no hint about it', async () => {
    board('/r/qa', ['/r/beta']);
    await screen.findByText('From beta');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  test('the Projects filter selects unset repositories: the hint names only those, and offers Settings for the open project', async () => {
    board('/r/qa', ['/r/qa', '/r/beta']);
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(/^qa-repo has no card source yet\./);
    expect(note).not.toHaveTextContent('alpha');
    expect(within(note).getByRole('button', { name: 'Open Settings' })).toBeInTheDocument();
  });

  test('a filtered-in unset repository other than the open project is named without a Settings button', async () => {
    board('/r/beta', ['/r/alpha']);
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(/^alpha has no card source yet\./);
    expect(within(note).queryByRole('button', { name: 'Open Settings' })).toBeNull();
  });
});

describe('TaskBoard team scope', () => {
  test('under "All repositories" cards of repositories outside the team are not listed', async () => {
    vi.mocked(listTasksAll).mockResolvedValue({
      tasks: [
        { id: 't-1', title: 'Mine', column: 'queued', state: 'Todo', repoPath: '/r/alpha', repoName: 'alpha' },
        { id: 't-2', title: 'Other team', column: 'queued', state: 'Todo', repoPath: '/r/zed', repoName: 'zed' },
      ],
      capped: false,
      failures: [],
    });
    render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Mine');
    expect(screen.queryByText('Other team')).not.toBeInTheDocument();
  });

  test('the open project being a hub board offers the hub task form in the all-repositories view', async () => {
    vi.mocked(listTasksAll).mockResolvedValue({ tasks: [], capped: false, failures: [], hubBoards: ['/r/alpha'] });
    render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} onOpenTask={() => {}} onNewTask={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New card' }));
    expect(screen.getByRole('form', { name: 'New card' })).toBeInTheDocument();
  });

  test('the selected team is sent with the all-repositories read', async () => {
    vi.mocked(listTasksAll).mockResolvedValue({ tasks: [], capped: false, failures: [] });
    render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} teamId="b" onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByRole('group', { name: 'Card' });
    expect(listTasksAll).toHaveBeenCalledWith('b');
  });
});

describe('TaskBoard open-in-tracker links', () => {
  test.each([
    ['github', 'Open in GitHub', 'https://github.com/o/r/issues/1'],
    ['gitlab', 'Open in GitLab', 'https://gitlab.com/g/p/-/issues/1'],
    ['linear', 'Open in Linear', 'https://linear.app/x/issue/DEV-1'],
  ] as const)('%s card links to its issue in a new tab', async (source, text, url) => {
    mockListTasks.mockResolvedValue({ tasks: [{ id: 't1', title: 'T', column: 'queued', state: 'Todo', source, url }], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    // The repeated link text is named for the card it belongs to.
    const link = await screen.findByRole('link', { name: `Open t1 T in ${text.slice('Open in '.length)}` });
    expect(link).toHaveTextContent(text);
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
  });

  test('the link sits inside the card frame, outside its button; a bare open/closed state is not repeated', async () => {
    mockListTasks.mockResolvedValue({ tasks: [{ id: 'gh-1', title: 'T', column: 'queued', state: 'open', source: 'github', url: 'https://github.com/o/r/issues/1' }, { id: 'gh-2', title: 'U', column: 'queued', state: 'needs design' }], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    const link = await screen.findByRole('link', { name: 'Open gh-1 T in GitHub' });
    const button = screen.getByText('T').closest('button') as HTMLElement;
    expect(button.contains(link)).toBe(false);
    expect(button.parentElement?.contains(link)).toBe(true);
    expect(screen.queryByText('open')).toBeNull();
    expect(screen.getByText('needs design')).toBeInTheDocument();
  });

  test('no link when the server sent no address', async () => {
    mockListTasks.mockResolvedValue({ tasks: [{ id: 't1', title: 'T', column: 'queued', state: 'Todo', source: 'github' }], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('T');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('TaskBoard quick view', () => {
  const setup = async (): Promise<{ card: HTMLElement; onOpenTask: ReturnType<typeof vi.fn> }> => {
    mockListTasks.mockResolvedValue({ tasks: [{ id: 'gh-7', title: 'Seven', column: 'review', state: 'review' }], capped: false });
    const onOpenTask = vi.fn();
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={onOpenTask} onNewTask={() => {}} />);
    return { card: (await screen.findByText('Seven')).closest('button') as HTMLElement, onOpenTask };
  };

  test('a click opens the panel beside the board; Escape closes it and focus returns to the card', async () => {
    const { card, onOpenTask } = await setup();
    fireEvent.click(card);
    expect(await screen.findByRole('complementary', { name: /Quick view: Seven/ })).toBeInTheDocument();
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(screen.queryByText('Receipt')).not.toBeInTheDocument(); // no pull request yet
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });

  test('a click outside closes it; "Full page" opens the task detail', async () => {
    const { card, onOpenTask } = await setup();
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: 'Full page' }));
    expect(onOpenTask).toHaveBeenCalledWith('gh-7', undefined, undefined);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });
});

describe('TaskBoard empty state', () => {
  test('an empty board says what to do next and links to creating a task', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    const onNewTask = vi.fn();
    render(<TaskBoard project="/r/alpha" repos={['/r/alpha']} onOpenTask={() => {}} onNewTask={onNewTask} />);
    await screen.findByText('No cards yet');
    fireEvent.click(screen.getByRole('button', { name: 'Create a card' }));
    expect(onNewTask).toHaveBeenCalled();
  });
});

describe('TaskBoard paused by a provider limit', () => {
  // `now` and both retry times sit within 20 minutes, so they share a local day in every time zone.
  const until = '2026-11-14T12:20:00.000Z';
  const clock = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const paused = (id: string, u?: string): BoardTask => ({ id, title: `Paused ${id}`, column: 'queued', state: 'taskcell:rate-limited', paused: { reason: 'provider-limit', ...(u ? { until: u } : {}) } });

  test('the card shows the state and the retry time, and one banner counts the paused tasks', async () => {
    mockListTasks.mockResolvedValue({ tasks: [paused('gh-1', '2026-11-14T12:10:00.000Z'), paused('gh-2', until), TASKS[0]!], capped: false });
    vi.setSystemTime(new Date('2026-11-14T12:01:00Z'));
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Paused gh-1');
    expect(screen.getAllByText('Paused: provider limit')).toHaveLength(2);
    expect(screen.getByText(`retries automatically after ${clock}`)).toBeInTheDocument();
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('2 cards are paused by a provider limit');
    expect(banner).toHaveTextContent(`latest retry after ${clock}`);
    expect(banner).toHaveTextContent('add credit or switch the model in Settings');
    vi.useRealTimers();
  });

  test('a missing time shows no time; a passed time says soon', async () => {
    mockListTasks.mockResolvedValue({ tasks: [paused('gh-1'), paused('gh-2', '2000-01-01T00:00:00.000Z')], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Paused gh-1');
    expect(screen.getByText('retries automatically')).toBeInTheDocument();
    expect(screen.getByText('retries automatically soon')).toBeInTheDocument();
  });

  test('no banner when nothing is paused', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Paused: provider limit')).toBeNull();
  });

  test('Retry now refreshes the card and banner', async () => {
    mockListTasks
      .mockResolvedValueOnce({ tasks: [paused('gh-7')], capped: false })
      .mockResolvedValueOnce({ tasks: [{ id: 'gh-7', title: 'Paused gh-7', column: 'queued', state: 'ready for agent' }], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    fireEvent.click(await screen.findByText('Paused gh-7'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry now' }));
    await waitFor(() => expect(hubCall).toHaveBeenCalledWith('retry_paused_task', { repoPath: '/repo', number: 7 }));
    await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Paused: provider limit')).toBeNull();
  });
});

describe('TaskBoard on a phone', () => {
  afterEach(() => vi.unstubAllGlobals());
  test('pick a stage: no sideways columns, the cards stack in the desktop order (Card first, Done last); a stage narrows them', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one');
    expect(screen.queryByRole('group', { name: 'Card' })).toBeNull();
    const stages = screen.getByRole('group', { name: 'Stage' });
    expect(within(stages).getByRole('button', { name: 'All stages 5' })).toHaveAttribute('aria-pressed', 'true');
    const titles = (): string[] => screen.getAllByRole('button', { expanded: false }).map((b) => b.querySelector('.text-sm')?.textContent ?? '').filter(Boolean);
    expect(titles()).toEqual(['Queued one', 'Queued two', 'Running one', 'Verify one', 'Done one']);
    fireEvent.click(within(stages).getByRole('button', { name: 'Gates 1' }));
    expect(titles()).toEqual(['Verify one']);
    fireEvent.click(within(stages).getByRole('button', { name: 'Spec 0' }));
    expect(screen.getByText('No cards')).toBeInTheDocument();
  });
});
