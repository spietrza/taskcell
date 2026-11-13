import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TaskBoard } from './TaskBoard';
import type { BoardTask } from '../../wire';

vi.mock('../../ipc', () => ({
  listTasks: vi.fn(),
  listTasksAll: vi.fn(),
  listRuns: vi.fn().mockResolvedValue([]),
  readRun: vi.fn(),
  listNeedsYou: vi.fn().mockResolvedValue({ items: [] }),
}));
import { listTasks, listTasksAll } from '../../ipc';
const mockListTasks = vi.mocked(listTasks);

// A lane is the column container carrying `rounded-xl`; scope queries to it so a task asserted
// "in Running" really renders under Running, not just somewhere on the board.
function lane(label: string): HTMLElement {
  const el = screen.getByText(label).closest('[class*="rounded-xl"]');
  if (!el) throw new Error(`lane "${label}" not found`);
  return el as HTMLElement;
}

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

describe('TaskBoard', () => {
  test('renders all six workflow columns', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    for (const label of ['Queued', 'Claimed', 'Running', 'Verify failed', 'Review', 'Done']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  test('routes each task to its column lane (guards a col.key typo silently emptying a lane)', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one'); // wait for load

    expect(within(lane('Queued')).getByText('Queued one')).toBeInTheDocument();
    expect(within(lane('Queued')).getByText('Queued two')).toBeInTheDocument();
    expect(within(lane('Running')).getByText('Running one')).toBeInTheDocument();
    expect(within(lane('Verify failed')).getByText('Verify one')).toBeInTheDocument();
    expect(within(lane('Done')).getByText('Done one')).toBeInTheDocument();
  });

  test('shows per-column counts and a placeholder for empty lanes', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued one');

    expect(within(lane('Queued')).getByText('2')).toBeInTheDocument();
    expect(within(lane('Claimed')).getByText('0')).toBeInTheDocument();
    expect(within(lane('Claimed')).getByText('No tasks')).toBeInTheDocument();
  });

  test('shows the raw backend state only when it differs from the lane key', async () => {
    mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Running one');

    // running task: state "In Progress" !== column "running" → shown
    expect(within(lane('Running')).getByText('In Progress')).toBeInTheDocument();
    // done task: state "done" === column "done" → the redundant state line is suppressed
    expect(within(lane('Done')).queryByText('done')).not.toBeInTheDocument();
  });

  test('renders the error branch when listTasks rejects', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByText(/Couldn't load the task board/)).toBeInTheDocument();
  });

  test('an uncapped list shows exact header counts, as a single text run', async () => {
    mockListTasks.mockResolvedValue({ tasks: COUNTS_TASKS, capped: false });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByText('Running 2 · Waiting 2')).toBeInTheDocument();
  });

  test('a capped list makes both header counts a lower bound', async () => {
    mockListTasks.mockResolvedValue({ tasks: COUNTS_TASKS, capped: true });
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    expect(await screen.findByText('Running 2+ · Waiting 2+')).toBeInTheDocument();
  });

  test('error branch renders no Running/Waiting text', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText(/Couldn't load the task board/);
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument();
  });
});

test('the cap banner follows the RESPONSE capped flag, not a client-side count (S9)', async () => {
  mockListTasks.mockResolvedValue({ tasks: TASKS, capped: true });
  render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByText(/Showing the first 5 tasks/)).toBeInTheDocument();
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
  expect(within(lane('Running')).getByText('stage: implementer')).toBeInTheDocument();
  for (const label of ['Review', 'Done']) {
    const scope = within(lane(label));
    expect(scope.getByText('implementer: ok').className).toContain('success');
    expect(scope.getByText('reviewer: changes (2)').className).toContain('warning');
    expect(scope.getByText('proof: fail').className).toContain('destructive');
    expect(scope.getByText('future gate').className).toContain('bg-muted');
  }
  expect(within(lane('Queued')).queryByText('implementer: ok')).not.toBeInTheDocument();
});

test('T26: a running card without a stage has no stage line', async () => {
  mockListTasks.mockResolvedValue({ tasks: TASKS, capped: false });
  render(<TaskBoard project="/repo" repos={[]} onOpenTask={() => {}} onNewTask={() => {}} />);
  await screen.findByText('Running one');
  expect(within(lane('Running')).queryByText(/^stage:/)).not.toBeInTheDocument();
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

  test('the selected team is sent with the all-repositories read', async () => {
    vi.mocked(listTasksAll).mockResolvedValue({ tasks: [], capped: false, failures: [] });
    render(<TaskBoard project="/r/alpha" allRepos repos={['/r/alpha']} teamId="b" onOpenTask={() => {}} onNewTask={() => {}} />);
    await screen.findByText('Queued');
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
    const link = await screen.findByRole('link', { name: text });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
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
    expect(onOpenTask).toHaveBeenCalledWith('gh-7', undefined);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });
});
