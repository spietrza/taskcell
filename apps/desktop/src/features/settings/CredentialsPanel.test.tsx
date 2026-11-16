import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsPanel } from './CredentialsPanel';
import * as ipc from '../../ipc';

vi.mock('../../ipc.js', () => ({
  userCredentialsStatus: vi.fn(),
  callerCapabilities: vi.fn(),
  saveUserCredential: vi.fn(async () => {}),
  deleteUserCredential: vi.fn(async () => {}),
  getCredentialPolicy: vi.fn(async () => ({ policy: 'user-first' })),
  setCredentialPolicy: vi.fn(async () => {}),
  instanceCredentialsStatus: vi.fn(async () => ({ names: ['ANTHROPIC_API_KEY'] })),
  saveInstanceCredential: vi.fn(async () => {}),
  deleteInstanceCredential: vi.fn(async () => {}),
}));

/** The status the hub answers, and the caller's admin flag it reports through `caller_capabilities`. */
function asUser(status: { enabled: boolean; admin: boolean; names: string[] }): void {
  vi.mocked(ipc.userCredentialsStatus).mockResolvedValue(status);
  vi.mocked(ipc.callerCapabilities).mockResolvedValue({ admin: status.admin } as never);
}

test('a non-admin sees only their own credentials — no switch, no instance credentials, no admin calls', async () => {
  asUser({ enabled: true, admin: false, names: ['OPENAI_API_KEY'] });
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText('Your credentials')).toBeInTheDocument());
  expect(screen.queryByText('Per-user credentials')).not.toBeInTheDocument();
  expect(screen.queryByText('Instance credentials')).not.toBeInTheDocument();
  expect(ipc.getCredentialPolicy).not.toHaveBeenCalled();
  expect(ipc.instanceCredentialsStatus).not.toHaveBeenCalled();
});

test('an admin sees the switch and instance credentials; values are write-only and cleared after save', async () => {
  asUser({ enabled: true, admin: true, names: [] });
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

test('an admin sees a value-free store migration or decryption reason', async () => {
  asUser({ enabled: false, admin: true, names: [] });
  vi.mocked(ipc.instanceCredentialsStatus).mockResolvedValueOnce({ names: [], reason: 'credential store cannot be decrypted' });
  render(<CredentialsPanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('credential store cannot be decrypted');
});

test('with the switch off a user is told so and gets no editor', async () => {
  asUser({ enabled: false, admin: false, names: [] });
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText(/are off on this hub/)).toBeInTheDocument());
  expect(screen.queryByText('Your credentials')).not.toBeInTheDocument();
});

test('a failing caller_capabilities leaves the panel on the status alone', async () => {
  vi.mocked(ipc.userCredentialsStatus).mockResolvedValue({ enabled: true, admin: false, names: [] });
  vi.mocked(ipc.callerCapabilities).mockRejectedValueOnce(new Error('unknown command'));
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText('Your credentials')).toBeInTheDocument());
  expect(screen.queryByText('unknown command')).not.toBeInTheDocument();
});
