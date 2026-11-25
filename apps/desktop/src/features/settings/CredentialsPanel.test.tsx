import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsPanel } from './CredentialsPanel';
import * as ipc from '../../ipc';
import { stubHubCalls } from '../../testHub';
import type { HubCallHandlers } from '../../testHub';

vi.mock('../../ipc.js', () => ({
  callerCapabilities: vi.fn(),
}));

let status = { enabled: true, admin: false, names: [] as string[] };
let spy: ReturnType<typeof stubHubCalls>;
const stub = (overrides: HubCallHandlers = {}): void => {
  spy = stubHubCalls({
    user_credentials_status: () => status,
    save_user_credential: () => {},
    delete_user_credential: () => {},
    get_credential_policy: () => ({ policy: 'user-first' }),
    set_credential_policy: () => {},
    instance_credentials_status: () => ({ names: ['ANTHROPIC_API_KEY'] }),
    save_instance_credential: () => {},
    delete_instance_credential: () => {},
    get_paid_fallback: () => ({ user: false, instance: false }),
    set_instance_paid_fallback: () => {},
    set_user_paid_fallback: () => {},
    ...overrides,
  });
};
beforeEach(() => stub());
afterEach(() => vi.restoreAllMocks());

/** The status the hub answers, and the caller's admin flag it reports through `caller_capabilities`. */
function asUser(s: { enabled: boolean; admin: boolean; names: string[] }): void {
  status = s;
  vi.mocked(ipc.callerCapabilities).mockResolvedValue({ admin: s.admin } as never);
}

test('a non-admin sees only their own credentials — no switch, no instance credentials, no admin calls', async () => {
  asUser({ enabled: true, admin: false, names: ['OPENAI_API_KEY'] });
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText('Your credentials')).toBeInTheDocument());
  expect(screen.queryByText('Per-user credentials')).not.toBeInTheDocument();
  expect(screen.queryByText('Instance credentials')).not.toBeInTheDocument();
  expect(spy).not.toHaveBeenCalledWith('get_credential_policy');
  expect(spy).not.toHaveBeenCalledWith('instance_credentials_status');
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
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_user_credential', { name: 'ANTHROPIC_API_KEY', value: 'sk-secret' }));
  await waitFor(() => expect(input.value).toBe(''));
});

test('an admin sees a value-free store migration or decryption reason', async () => {
  asUser({ enabled: false, admin: true, names: [] });
  vi.restoreAllMocks();
  stub({ instance_credentials_status: () => ({ names: [], reason: 'credential store cannot be decrypted' }) });
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
  status = { enabled: true, admin: false, names: [] };
  vi.mocked(ipc.callerCapabilities).mockRejectedValueOnce(new Error('unknown command'));
  render(<CredentialsPanel />);
  await waitFor(() => expect(screen.getByText('Your credentials')).toBeInTheDocument());
  expect(screen.queryByText('unknown command')).not.toBeInTheDocument();
});

test('paid fallback: unchecked by default; an admin has both switches, a non-admin only their own; toggling calls the RPC and errors show inline', async () => {
  asUser({ enabled: true, admin: false, names: [] });
  const { unmount } = render(<CredentialsPanel />);
  const own = await screen.findByLabelText(/continue on your own paid API key/);
  expect(own).not.toBeChecked();
  expect(screen.queryByLabelText(/continue on the instance's paid API key/)).not.toBeInTheDocument();
  fireEvent.click(own);
  await waitFor(() => expect(spy).toHaveBeenCalledWith('set_user_paid_fallback', { enabled: true }));
  unmount();

  asUser({ enabled: true, admin: true, names: [] });
  stub({ set_instance_paid_fallback: () => { throw new Error('nope'); } });
  render(<CredentialsPanel />);
  const inst = await screen.findByLabelText(/continue on the instance's paid API key/);
  expect(inst).not.toBeChecked();
  fireEvent.click(inst);
  await waitFor(() => expect(screen.getByText(/nope/)).toBeInTheDocument());
});
