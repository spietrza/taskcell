import { describe, expect, test, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { EMPTY_STORED } from './steps';
import { setupStatus } from '../../ipc';

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
    expect(onStored).toHaveBeenCalledWith({ completed: false, skipped: ['model'], model: 'claude' });
  });

  test('the model step shows only the chosen option, with a restart note after each export', async () => {
    const onStored = vi.fn();
    const { rerender } = render(<Onboarding projectCount={0} stored={EMPTY_STORED} onStored={onStored} onAddRepo={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('signed in')).toBeInTheDocument());
    expect(screen.queryByText(/codex login/)).toBeNull();
    expect(screen.getAllByText(/restart the hub/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(onStored).toHaveBeenCalledWith({ ...EMPTY_STORED, model: 'codex' });
    rerender(<Onboarding projectCount={0} stored={{ ...EMPTY_STORED, model: 'codex' }} onStored={onStored} onAddRepo={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/codex login/)).toBeInTheDocument();
    expect(screen.queryByText(/claude setup-token/)).toBeNull();
    expect(screen.getAllByText(/restart the hub/)).toHaveLength(2);
  });

  test('a Codex sign-in file with no credential: the step is not Done, and the guide shows the export that makes it usable', async () => {
    vi.mocked(setupStatus).mockResolvedValueOnce({ tools: [], models: { claude: false, codex: false }, codexSignInFile: true });
    render(<Onboarding projectCount={0} stored={{ ...EMPTY_STORED, model: 'codex' }} onStored={() => {}} onAddRepo={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/hub runs do not read it until it is set as CODEX_AUTH_JSON/)).toBeInTheDocument();
    expect(screen.getByText(/Codex: not found/)).toBeInTheDocument();
    expect(screen.getByText(/export CODEX_AUTH_JSON=/)).toBeInTheDocument();
    expect(screen.queryByText(/codex login/)).toBeNull();
    expect(screen.getAllByText('Needs action').length).toBeGreaterThanOrEqual(2);
  });

  test('the repo step opens the picker; Dismiss completes onboarding', async () => {
    const onAddRepo = vi.fn();
    const onStored = vi.fn();
    const onClose = vi.fn();
    render(<Onboarding projectCount={0} stored={EMPTY_STORED} onStored={onStored} onAddRepo={onAddRepo} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('signed in')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add a repository' }));
    expect(onAddRepo).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onStored).toHaveBeenCalledWith({ completed: true, skipped: [], model: 'claude' });
    expect(onClose).toHaveBeenCalled();
  });
});

