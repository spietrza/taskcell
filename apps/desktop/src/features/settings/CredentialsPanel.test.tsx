import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsPanel } from './CredentialsPanel';
import * as ipc from '../../ipc';
import { stubHubCalls } from '../../testHub';
import type { HubCallHandlers } from '../../testHub';
import type { CredentialAccountView } from '../../wire';

vi.mock('../../ipc.js', () => ({
  callerCapabilities: vi.fn(),
}));

type Status = { enabled: boolean; admin: boolean; names: string[]; accounts?: CredentialAccountView[] };
let status: Status = { enabled: true, admin: false, names: [] };
let instanceAccounts: CredentialAccountView[] = [];
let spy: ReturnType<typeof stubHubCalls>;
const accountOf = (i: number, over: Partial<CredentialAccountView> = {}): CredentialAccountView => ({ id: `a${i}`, provider: 'claude', name: `Key ${i}`, type: 'api-key', enabled: true, ...over });
const stub = (overrides: HubCallHandlers = {}): void => {
  spy = stubHubCalls({
    user_credentials_status: () => ({ accounts: [], ...status }),
    save_user_account: () => ({ id: 'n' }),
    delete_user_account: () => {},
    reorder_user_accounts: () => {},
    save_instance_account: () => ({ id: 'n' }),
    delete_instance_account: () => {},
    reorder_instance_accounts: () => {},
    save_user_credential: () => {},
    delete_user_credential: () => {},
    get_credential_policy: () => ({ policy: 'user-first' }),
    set_credential_policy: () => {},
    instance_credentials_status: () => ({ names: ['ANTHROPIC_API_KEY'], accounts: instanceAccounts }),
    save_instance_credential: () => {},
    delete_instance_credential: () => {},
    ...overrides,
  });
};
beforeEach(() => {
  instanceAccounts = [];
  stub();
});
afterEach(() => vi.restoreAllMocks());

/** The status the hub answers, and the caller's admin flag it reports through `caller_capabilities`. */
function asUser(s: Status): void {
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
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_user_credential', { name: 'CODEX_AUTH_JSON', value: 'sk-secret' }));
  await waitFor(() => expect(input.value).toBe(''));
});

test('an admin sees a value-free store migration or decryption reason', async () => {
  asUser({ enabled: false, admin: true, names: [] });
  vi.restoreAllMocks();
  stub({ instance_credentials_status: () => ({ names: [], accounts: [], reason: 'credential store cannot be decrypted' }) });
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

test('accounts: add sends the secret once and clears the field; the secret is never pre-filled', async () => {
  asUser({ enabled: true, admin: true, names: [] });
  instanceAccounts = [accountOf(1)];
  render(<CredentialsPanel />);
  await screen.findByLabelText('Name of Key 1');
  const secret = screen.getByLabelText('Instance Anthropic accounts secret') as HTMLInputElement;
  expect(secret.value).toBe('');
  fireEvent.change(screen.getByLabelText('Instance Anthropic accounts name'), { target: { value: 'Team' } });
  fireEvent.change(secret, { target: { value: 'sk-ant-x' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Add account' })[0]!);
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_instance_account', { provider: 'claude', name: 'Team', type: 'api-key', value: 'sk-ant-x' }));
  await waitFor(() => expect(secret.value).toBe(''));
});

test('accounts: toggle, reorder and remove call the hub with ids only', async () => {
  asUser({ enabled: true, admin: true, names: [] });
  instanceAccounts = [accountOf(1), accountOf(2)];
  render(<CredentialsPanel />);
  await screen.findByLabelText('Name of Key 2');
  fireEvent.click(screen.getByLabelText('Key 1 on'));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_instance_account', { provider: 'claude', id: 'a1', name: 'Key 1', type: 'api-key', enabled: false }));
  fireEvent.click(screen.getByLabelText('Move Key 1 down'));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('reorder_instance_accounts', { ids: ['a2', 'a1'] }));
  fireEvent.click(screen.getByLabelText('Remove Key 2'));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('delete_instance_account', { id: 'a2' }));
});

test('accounts: Add is disabled at the cap of 20', async () => {
  asUser({ enabled: true, admin: true, names: [] });
  instanceAccounts = Array.from({ length: 20 }, (_, i) => accountOf(i));
  render(<CredentialsPanel />);
  await screen.findByLabelText('Name of Key 19');
  expect(screen.getByRole('button', { name: '20 of 20' })).toBeDisabled();
});

test('accounts: a second subscription token shows the terms caveat and needs the acknowledgement', async () => {
  asUser({ enabled: false, admin: true, names: [] });
  instanceAccounts = [accountOf(1, { type: 'subscription' })];
  render(<CredentialsPanel />);
  await screen.findByLabelText('Name of Key 1');
  fireEvent.change(screen.getByLabelText('Instance Anthropic accounts type'), { target: { value: 'subscription' } });
  expect(screen.getByText(/ordinary, individual usage/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Instance Anthropic accounts name'), { target: { value: 'Second' } });
  fireEvent.change(screen.getByLabelText('Instance Anthropic accounts secret'), { target: { value: 'tok' } });
  const add = screen.getByRole('button', { name: 'Add account' });
  expect(add).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I understand the terms caveat/));
  expect(add).toBeEnabled();
  fireEvent.click(add);
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_instance_account', expect.objectContaining({ acknowledgeTerms: true })));
});

test('accounts: rename and replace-secret are explicit actions; the existing secret is never shown', async () => {
  asUser({ enabled: true, admin: true, names: [] });
  instanceAccounts = [accountOf(1)];
  render(<CredentialsPanel />);
  await screen.findByLabelText('Name of Key 1');
  expect((screen.getByLabelText('Replace secret of Key 1') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Name of Key 1'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByLabelText('Rename Key 1'));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_instance_account', { provider: 'claude', id: 'a1', name: 'Renamed', type: 'api-key' }));
  fireEvent.change(screen.getByLabelText('Replace secret of Key 1'), { target: { value: 'sk-new' } });
  fireEvent.click(screen.getByLabelText('Replace secret for Key 1'));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_instance_account', { provider: 'claude', id: 'a1', name: 'Key 1', type: 'api-key', value: 'sk-new' }));
});

test('accounts: re-enabling a second instance subscription token needs its own acknowledgement', async () => {
  asUser({ enabled: false, admin: true, names: [] });
  instanceAccounts = [accountOf(1, { type: 'subscription' }), accountOf(2, { type: 'subscription', enabled: false })];
  render(<CredentialsPanel />);
  await screen.findByLabelText('Name of Key 2');
  const toggle = screen.getByLabelText('Key 2 on');
  expect(toggle).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Acknowledge terms for Key 2'));
  fireEvent.click(toggle);
  await waitFor(() => expect(spy).toHaveBeenCalledWith('save_instance_account', { provider: 'claude', id: 'a2', name: 'Key 2', type: 'subscription', enabled: true, acknowledgeTerms: true }));
});

test('the per-variable editor does not list Claude variables (accounts own them)', async () => {
  asUser({ enabled: true, admin: false, names: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] });
  render(<CredentialsPanel />);
  await screen.findByText('Your credentials');
  expect(screen.queryAllByText('ANTHROPIC_API_KEY')).toHaveLength(0);
  expect(screen.getAllByText('OPENAI_API_KEY').length).toBeGreaterThan(1);
});
