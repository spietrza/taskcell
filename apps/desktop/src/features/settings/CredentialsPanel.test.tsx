import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsPanel } from './CredentialsPanel';
import * as ipc from '../../ipc';

vi.mock('../../ipc.js', () => ({
  userCredentialsStatus: vi.fn(),
  saveUserCredential: vi.fn(async () => {}),
  deleteUserCredential: vi.fn(async () => {}),
  getCredentialPolicy: vi.fn(async () => ({ policy: 'user-first' })),
  setCredentialPolicy: vi.fn(async () => {}),
  instanceCredentialsStatus: vi.fn(async () => ({ names: ['ANTHROPIC_API_KEY'] })),
  saveInstanceCredential: vi.fn(async () => {}),
  deleteInstanceCredential: vi.fn(async () => {}),
}));

test('a non-admin sees only their own credentials — no switch, no instance credentials, no admin calls', async () => {
  vi.mocked(ipc.userCredentialsStatus).mockResolvedValue({ enabled: true, admin: false, names: ['OPENAI_API_KEY'] });
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText('Your credentials')).toBeInTheDocument());
  expect(screen.queryByText('Per-user credentials')).not.toBeInTheDocument();
  expect(screen.queryByText('Instance credentials')).not.toBeInTheDocument();
  expect(ipc.getCredentialPolicy).not.toHaveBeenCalled();
  expect(ipc.instanceCredentialsStatus).not.toHaveBeenCalled();
});

test('an admin sees the switch and instance credentials; values are write-only and cleared after save', async () => {
  vi.mocked(ipc.userCredentialsStatus).mockResolvedValue({ enabled: true, admin: true, names: [] });
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText('Per-user credentials')).toBeInTheDocument());
  expect(screen.getByText('Instance credentials')).toBeInTheDocument();
  const input = screen.getByLabelText('Your credentials value') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'sk-secret' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
  await waitFor(() => expect(ipc.saveUserCredential).toHaveBeenCalledWith('ANTHROPIC_API_KEY', 'sk-secret'));
  await waitFor(() => expect(input.value).toBe(''));
});

test('with the switch off a user is told so and gets no editor', async () => {
  vi.mocked(ipc.userCredentialsStatus).mockResolvedValue({ enabled: false, admin: false, names: [] });
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText(/are off on this hub/)).toBeInTheDocument());
  expect(screen.queryByText('Your credentials')).not.toBeInTheDocument();
});
