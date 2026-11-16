import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../ipc', () => ({ listTasks: vi.fn(), listTasksAll: vi.fn(), retryPausedTask: vi.fn().mockResolvedValue({ label: 'ready for agent' }), callerCapabilities: vi.fn(async () => ({})) }));
import { callerCapabilities, listTasks, retryPausedTask } from '../../ipc';
import { HomePausedBanner, PausedPanel, TaskDetailPaused, retryWords } from './paused';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(retryPausedTask).mockResolvedValue({ label: 'ready for agent' });
});

test('the detail shows the state and Retry now calls the hub with the issue number', async () => {
  render(<PausedPanel repoPath="/r" task={{ id: 'gh-7', paused: { reason: 'provider-limit' } }} />);
  expect(screen.getByText('Paused: provider limit')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
  await waitFor(() => expect(retryPausedTask).toHaveBeenCalledWith('/r', 7));
});

test('Retry now is not offered for a card that is not a GitHub issue', () => {
  render(<PausedPanel repoPath="/r" task={{ id: 'linear-dev-7', paused: { reason: 'provider-limit' } }} />);
  expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
});

test('Retry now is closed, with the reason, when the hub refuses remote writes', async () => {
  vi.mocked(callerCapabilities).mockResolvedValueOnce({ project: { canStartTask: { allowed: false, reason: 'the hub refuses remote writes' } } } as never);
  render(<PausedPanel repoPath="/r" task={{ id: 'gh-7', paused: { reason: 'provider-limit' } }} />);
  const button = screen.getByRole('button', { name: 'Retry now' });
  await waitFor(() => expect(button).toBeDisabled());
  expect(button).toHaveAttribute('title', 'the hub refuses remote writes');
});

test('a refusal shows inline', async () => {
  vi.mocked(retryPausedTask).mockRejectedValueOnce(new Error('#7 is closed'));
  render(<PausedPanel repoPath="/r" task={{ id: 'gh-7', paused: { reason: 'provider-limit' } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('#7 is closed');
});

test('Home shows the banner for paused tasks and nothing otherwise', async () => {
  vi.mocked(listTasks).mockResolvedValueOnce({ tasks: [{ id: 'gh-1', title: 't', column: 'queued', state: '', paused: { reason: 'provider-limit' } }], capped: false });
  const { unmount } = render(<HomePausedBanner project="/r" allRepos={false} repos={[]} />);
  expect(await screen.findByRole('status')).toHaveTextContent('1 task is paused by a provider limit');
  unmount();
  vi.mocked(listTasks).mockResolvedValueOnce({ tasks: [], capped: false });
  render(<HomePausedBanner project="/r" allRepos={false} repos={[]} />);
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('status')).toBeNull();
});

test('the task detail re-reads and clears its paused panel after a retry', async () => {
  vi.mocked(listTasks)
    .mockResolvedValueOnce({ tasks: [{ id: 'gh-7', title: 't', column: 'queued', state: '', paused: { reason: 'provider-limit' } }], capped: false })
    .mockResolvedValueOnce({ tasks: [{ id: 'gh-7', title: 't', column: 'queued', state: 'ready for agent' }], capped: false });
  render(<TaskDetailPaused project="/r" taskId="gh-7" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry now' }));
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Paused: provider limit')).toBeNull());
});

test('retry wording includes the date when the retry is not today', () => {
  const now = new Date(2026, 10, 14, 10, 0).getTime();
  const tomorrow = new Date(2026, 10, 15, 9, 0).getTime();
  expect(retryWords({ reason: 'provider-limit', until: new Date(tomorrow).toISOString() }, now)).toBe(
    `after ${new Date(tomorrow).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${new Date(tomorrow).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
  );
});
