import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../ipc', () => ({ listTasks: vi.fn(), listTasksAll: vi.fn(), retryPausedTask: vi.fn().mockResolvedValue({ label: 'ready for agent' }) }));
vi.mock('../needs-you/NeedsYou', () => ({ canUseNeedsYou: () => true }));
import { listTasks, retryPausedTask } from '../../ipc';
import { HomePausedBanner, PausedPanel } from './paused';

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
