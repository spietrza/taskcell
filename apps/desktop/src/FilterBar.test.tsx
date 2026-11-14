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
  const runs = [{ taskId: 'gh-1', timestamp: 't', stages: [], totalCostUsd: 0, anyFailed: false }, { taskId: 'gl-2', timestamp: 't2', stages: [], totalCostUsd: 0, anyFailed: false }];
  render(<RunList runs={runs} active={[]} hub={{ ...DEFAULT_FILTER, group: 'source' }} onHub={() => {}} onSelect={() => {}} onOpenActive={() => {}} />);
  expect(screen.getByText('GitHub', { selector: 'td' })).toBeInTheDocument();
  expect(screen.getByText('GitLab', { selector: 'td' })).toBeInTheDocument();
});
