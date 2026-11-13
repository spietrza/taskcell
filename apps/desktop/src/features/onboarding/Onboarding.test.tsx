import { describe, expect, test, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { EMPTY_STORED } from './steps';

vi.mock('../../ipc', () => ({
  setupStatus: vi.fn(async () => ({
    tools: [{ id: 'gh', state: 'ready' }, { id: 'glab', state: 'missing' }, { id: 'linear', state: 'needs-login' }],
    models: { claude: false, codex: false },
  })),
}));

beforeEach(() => localStorage.clear());

describe('Onboarding', () => {
  test('shows detected auth, run-this commands, and lets a step be skipped', async () => {
    const onStored = vi.fn();
    render(<Onboarding projectCount={0} stored={EMPTY_STORED} onStored={onStored} onAddRepo={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('signed in')).toBeInTheDocument());
    expect(screen.getByText('not installed')).toBeInTheDocument();
    expect(screen.getByText(/claude setup-token/)).toBeInTheDocument();
    expect(screen.getAllByText(/never reads or stores the secret value/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Skip this step' })[0]!);
    expect(onStored).toHaveBeenCalledWith({ completed: false, skipped: ['model'] });
  });

  test('the repo step opens the picker; Dismiss completes onboarding', async () => {
    const onAddRepo = vi.fn();
    const onStored = vi.fn();
    const onClose = vi.fn();
    render(<Onboarding projectCount={0} stored={EMPTY_STORED} onStored={onStored} onAddRepo={onAddRepo} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a repository' }));
    expect(onAddRepo).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onStored).toHaveBeenCalledWith({ completed: true, skipped: [] });
    expect(onClose).toHaveBeenCalled();
  });
});

