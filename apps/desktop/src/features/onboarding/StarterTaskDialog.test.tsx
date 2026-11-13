import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StarterTaskDialog } from './StarterTaskDialog';
import { STARTER_TASK } from './steps';

vi.mock('../../ipc', () => ({ apiCreateTask: vi.fn() }));
import { apiCreateTask } from '../../ipc';

const project = { path: '/r/app', name: 'app' };

describe('StarterTaskDialog', () => {
  test('shows the template and creates it only on click', async () => {
    vi.mocked(apiCreateTask).mockResolvedValue({} as never);
    const onCreated = vi.fn();
    render(<StarterTaskDialog project={project} onCreated={onCreated} onClose={() => {}} />);
    expect(screen.getByText(STARTER_TASK.title)).toBeInTheDocument();
    expect(apiCreateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create this task' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(apiCreateTask).toHaveBeenCalledWith('/r/app', STARTER_TASK.title, STARTER_TASK.body);
  });

  test('a refusal shows inline and keeps the dialog open', async () => {
    vi.mocked(apiCreateTask).mockRejectedValue(new Error('no access'));
    const onCreated = vi.fn();
    render(<StarterTaskDialog project={project} onCreated={onCreated} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create this task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Task not created');
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('Not now and Escape close it', () => {
    const onClose = vi.fn();
    render(<StarterTaskDialog project={project} onCreated={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
