import { beforeEach, test, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Members } from './Members';
import * as ipc from '../../ipc';
import type { Project } from '../../taskcell-output';
import type { Team } from '../../wire';

const mocks = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' }));
vi.mock('../../ipc', () => ({
  teamRole: vi.fn(async () => mocks.role),
  teamAddMember: vi.fn(),
  teamSetRole: vi.fn(),
  teamRemoveMember: vi.fn(),
  teamAddRepository: vi.fn(),
  teamRemoveRepository: vi.fn(),
}));

const team: Team = {
  id: 't',
  name: 'T',
  members: [
    { login: 'ann', role: 'admin' },
    { login: 'bob', role: 'member' },
  ],
  repositories: ['/r/app'],
};
const project = (path: string, name: string): Project => ({ path, name, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 });
const allProjects = [project('/r/app', 'app'), project('/r/lib', 'lib')];

const show = (t: Team = team, extra: { onTeam?: (t: Team) => void; confirmRemoveRepo?: (p: string) => boolean } = {}): void => {
  render(<Members team={t} allProjects={allProjects} onTeam={extra.onTeam ?? (() => {})} confirmRemoveRepo={extra.confirmRemoveRepo ?? (() => true)} />);
};

beforeEach(() => vi.clearAllMocks());

test('an admin sees the controls', async () => {
  mocks.role = 'admin';
  show();
  expect(await screen.findByRole('button', { name: 'Add member' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Role of bob' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove bob' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove repository app' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Repository to add' })).toBeInTheDocument();
});

test('a member sees the list read-only, with no controls', async () => {
  mocks.role = 'member';
  show();
  await waitFor(() => expect(ipc.teamRole).toHaveBeenCalledWith('t'));
  // Let the role resolve: a still-pending role would also show no controls.
  await Promise.resolve();
  expect(await screen.findByText('bob')).toBeInTheDocument();
  expect(screen.getByText('app')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

test('an admin adds a member, changes a role and removes a member', async () => {
  mocks.role = 'admin';
  const onTeam = vi.fn();
  const updated = { ...team, members: [...team.members, { login: 'cy', role: 'member' as const }] };
  vi.mocked(ipc.teamAddMember).mockResolvedValue(updated);
  vi.mocked(ipc.teamSetRole).mockResolvedValue(team);
  vi.mocked(ipc.teamRemoveMember).mockResolvedValue(team);
  show(team, { onTeam });
  fireEvent.change(await screen.findByRole('textbox', { name: 'Login' }), { target: { value: 'cy' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
  await waitFor(() => expect(onTeam).toHaveBeenCalledWith(updated));
  expect(ipc.teamAddMember).toHaveBeenCalledWith('t', 'cy', 'member');
  fireEvent.change(screen.getByRole('combobox', { name: 'Role of bob' }), { target: { value: 'admin' } });
  await waitFor(() => expect(ipc.teamSetRole).toHaveBeenCalledWith('t', 'bob', 'admin'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove bob' }));
  await waitFor(() => expect(ipc.teamRemoveMember).toHaveBeenCalledWith('t', 'bob'));
});

test('the last-admin refusal is shown and the team is unchanged', async () => {
  mocks.role = 'admin';
  const onTeam = vi.fn();
  vi.mocked(ipc.teamRemoveMember).mockRejectedValue('the last admin cannot be removed');
  show(team, { onTeam });
  fireEvent.click(await screen.findByRole('button', { name: 'Remove ann' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('the last admin cannot be removed');
  expect(onTeam).not.toHaveBeenCalled();
});

test('an admin adds and removes repositories; removing asks first', async () => {
  mocks.role = 'admin';
  const onTeam = vi.fn();
  vi.mocked(ipc.teamAddRepository).mockResolvedValue({ ...team, repositories: ['/r/app', '/r/lib'] });
  vi.mocked(ipc.teamRemoveRepository).mockResolvedValue({ ...team, repositories: [] });
  const confirmRemoveRepo = vi.fn(() => false);
  show(team, { onTeam, confirmRemoveRepo });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Repository to add' }), { target: { value: '/r/lib' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
  await waitFor(() => expect(ipc.teamAddRepository).toHaveBeenCalledWith('t', '/r/lib'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove repository app' }));
  expect(confirmRemoveRepo).toHaveBeenCalledWith('/r/app');
  expect(ipc.teamRemoveRepository).not.toHaveBeenCalled();
  confirmRemoveRepo.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove repository app' }));
  await waitFor(() => expect(ipc.teamRemoveRepository).toHaveBeenCalledWith('t', '/r/app'));
});

test('the default team offers no repository edits, and the role is re-read after an edit', async () => {
  mocks.role = 'admin';
  const view = render(
    <Members team={{ ...team, id: 'default' }} allProjects={allProjects} onTeam={() => {}} confirmRemoveRepo={() => true} />,
  );
  await screen.findByRole('button', { name: 'Add member' });
  expect(screen.queryByRole('button', { name: /Remove repository/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Repository to add' })).not.toBeInTheDocument();
  // The caller demoted themselves: the next team object triggers a role refetch and the controls go.
  mocks.role = 'member';
  view.rerender(
    <Members team={{ ...team, id: 'default', members: [] }} allProjects={allProjects} onTeam={() => {}} confirmRemoveRepo={() => true} />,
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument());
});
