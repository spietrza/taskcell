import { expect, test, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FilterBar } from './FilterBar';
import { DEFAULT_FILTER, type HubFilter } from './filterState';
import { RunList } from './features/inspector/RunList';
import { TaskBoard } from './features/board/TaskBoard';

vi.mock('./ipc', () => ({
  listTasks: vi.fn(),
  listTasksAll: vi.fn().mockResolvedValue({
    tasks: [
      { id: 'gh-1', title: 'Alpha', column: 'running', state: '', source: 'github', repoPath: '/a', repoName: 'a' },
      { id: 'gl-2', title: 'Beta', column: 'review', state: '', source: 'gitlab', repoPath: '/b', repoName: 'b' },
    ],
    capped: false,
    failures: [],
  }),
  listRuns: vi.fn().mockResolvedValue([]),
  readRun: vi.fn(),
  listNeedsYou: vi.fn().mockResolvedValue({ items: [] }),
}));

const repos = [{ path: '/a', name: 'alpha-repo' }, { path: '/b', name: 'beta-repo' }, { path: '/c', name: 'gamma' }];

function Harness({ withCards = ['/a'] }: { withCards?: string[] }) {
  const [f, setF] = useState<HubFilter>(DEFAULT_FILTER);
  return (
    <>
      <FilterBar filter={f} onChange={setF} repos={repos} withCards={withCards} />
      <output data-testid="state">{JSON.stringify(f)}</output>
    </>
  );
}
const state = (): HubFilter => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as HubFilter;

test('triage, source, search and grouping update the state; no runner control', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Needs you' }));
  expect(state().triage).toBe('needs');
  fireEvent.click(screen.getAllByRole('button', { name: 'GitLab' })[0]);
  expect(state().sources).toEqual(['gitlab']);
  fireEvent.change(screen.getByLabelText('Search title or id'), { target: { value: 'abc' } });
  expect(state().query).toBe('abc');
  fireEvent.change(screen.getAllByLabelText('Group by')[0], { target: { value: 'source' } });
  expect(state().group).toBe('source');
  expect(screen.queryByText(/runner/i)).toBeNull();
});

test('the project picker is searchable, multi-select, with a has-cards shortcut', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Projects:/ }));
  const picker = screen.getByRole('group', { name: 'Projects' });
  fireEvent.click(within(picker).getByLabelText('alpha-repo'));
  fireEvent.click(within(picker).getByLabelText('beta-repo'));
  expect(state().repos).toEqual(['/a', '/b']);
  fireEvent.change(within(picker).getByLabelText('Search projects'), { target: { value: 'gam' } });
  expect(within(picker).queryByLabelText('alpha-repo')).toBeNull();
  fireEvent.click(within(picker).getByRole('button', { name: 'Has cards' }));
  expect(state().repos).toEqual(['/a']);
});

test('the Filters drawer holds projects, source and grouping; triage and search stay outside it', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  const drawer = screen.getByRole('dialog', { name: 'Filters' });
  expect(within(drawer).getByRole('button', { name: /Projects:/ })).toBeInTheDocument();
  expect(within(drawer).getByRole('group', { name: 'Card source' })).toBeInTheDocument();
  expect(within(drawer).getByLabelText('Group by')).toBeInTheDocument();
  expect(within(drawer).queryByRole('group', { name: 'Triage' })).toBeNull();
  expect(within(drawer).queryByLabelText('Search title or id')).toBeNull();
});

test('Board and Runs apply the same filter and group', async () => {
  const f: HubFilter = { ...DEFAULT_FILTER, triage: 'needs', group: 'project' };
  const runs = [
    { taskId: 'gh-1', timestamp: 't', stages: [], totalCostUsd: 0, anyFailed: true, repoPath: '/a', repoName: 'a' },
    { taskId: 'gl-2', timestamp: 't2', stages: [], totalCostUsd: 0, anyFailed: false, repoPath: '/b', repoName: 'b' },
  ];
  const board = render(<TaskBoard project="/a" allRepos repos={['/a', '/b']} filter={f} onFilter={() => {}} projects={repos} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByText('Beta')).toBeInTheDocument();
  expect(screen.queryByText('Alpha')).toBeNull();
  expect(screen.getByRole('region', { name: 'b' })).toBeInTheDocument();
  board.unmount();
  render(<RunList runs={runs} active={[]} hub={f} onHub={() => {}} projects={repos} onSelect={() => {}} onOpenActive={() => {}} />);
  expect(screen.getByText('gh-1', { selector: 'td' })).toBeInTheDocument();
  expect(screen.queryByText('gl-2', { selector: 'td' })).toBeNull();
});

test('a grouped Board with no matching card says so, and a grouped Runs table has lane rows', async () => {
  const none: HubFilter = { ...DEFAULT_FILTER, query: 'zzz', group: 'source' };
  const board = render(<TaskBoard project="/a" allRepos repos={['/a', '/b']} filter={none} onFilter={() => {}} projects={repos} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByText('No cards match the search "zzz".')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  board.unmount();
  // A source filter that empties the Board on its own: clearing the search would not help, so it is not offered.
  const bySource = render(<TaskBoard project="/a" allRepos repos={['/a', '/b']} filter={{ ...DEFAULT_FILTER, query: 'a', sources: ['linear'] }} onFilter={() => {}} projects={repos} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByText('No cards match the current filters.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  bySource.unmount();
  const runs = [{ taskId: 'gh-1', timestamp: 't', stages: [], totalCostUsd: 0, anyFailed: false }, { taskId: 'gl-2', timestamp: 't2', stages: [], totalCostUsd: 0, anyFailed: false }];
  render(<RunList runs={runs} active={[]} hub={{ ...DEFAULT_FILTER, group: 'source' }} onHub={() => {}} onSelect={() => {}} onOpenActive={() => {}} />);
  expect(screen.getByText('GitHub', { selector: 'td' })).toBeInTheDocument();
  expect(screen.getByText('GitLab', { selector: 'td' })).toBeInTheDocument();
});

test('Escape closes the Projects popup and returns focus to its button', () => {
  render(<Harness />);
  const trigger = screen.getAllByRole('button', { name: /^Projects:/ })[0]!;
  fireEvent.click(trigger);
  expect(screen.getByRole('group', { name: 'Projects' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText('Search projects'), { key: 'Escape' });
  expect(screen.queryByRole('group', { name: 'Projects' })).toBeNull();
  expect(trigger).toHaveFocus();
});

test('one Escape closes one layer: the popup stops it for an enclosing layer, and leaves one a layer above already took', () => {
  render(<Harness />);
  const outer = vi.fn();
  window.addEventListener('keydown', outer);
  try {
    fireEvent.click(screen.getAllByRole('button', { name: /^Projects:/ })[0]!);
    const search = screen.getByLabelText('Search projects');
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    fireEvent(search, taken);
    expect(screen.getByRole('group', { name: 'Projects' })).toBeInTheDocument();
    outer.mockClear();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Projects' })).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', outer);
  }
});

test('Escape closes the Filters sheet, one layer per press: an open Projects popup inside closes first', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  const drawer = screen.getByRole('dialog', { name: 'Filters' });
  fireEvent.click(within(drawer).getByRole('button', { name: /^Projects:/ }));
  const search = within(drawer).getByLabelText('Search projects');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(within(drawer).queryByRole('group', { name: 'Projects' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  fireEvent.keyDown(drawer, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
});

test('a Board emptied by filters names them and offers Clear filters, which keeps Projects and grouping', async () => {
  const onFilter = vi.fn();
  const f: HubFilter = { ...DEFAULT_FILTER, triage: 'merged', sources: ['linear'], repos: ['/a'], group: 'source' };
  render(<TaskBoard project="/a" allRepos repos={['/a', '/b']} filter={f} onFilter={onFilter} projects={repos} onOpenTask={() => {}} onNewTask={() => {}} />);
  expect(await screen.findByText(/Active: Merged, Linear, Projects\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(onFilter).toHaveBeenCalledWith({ ...f, triage: 'all', sources: [], query: '' });
});

test('the Board search box says Runs shares it and matches the task id only', () => {
  render(<Harness />);
  expect(screen.getAllByLabelText('Search title or id')[0]).toHaveAttribute('title', expect.stringContaining('Runs shares this search'));
});
