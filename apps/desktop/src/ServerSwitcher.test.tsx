import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ServerSwitcher } from './ServerSwitcher';
import * as servers from './servers';

vi.mock('./servers', () => ({
  canSwitchServers: vi.fn(() => true),
  canEditServers: vi.fn(() => true),
  listServers: vi.fn(),
  addServer: vi.fn(),
  removeServer: vi.fn(),
  switchServer: vi.fn(async () => undefined),
}));

const state = { servers: [{ id: 's1', name: 'Team hub', url: 'https://hub.example.com' }], active: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(servers.canSwitchServers).mockReturnValue(true);
  vi.mocked(servers.canEditServers).mockReturnValue(true);
  vi.mocked(servers.listServers).mockResolvedValue(state);
});

test('renders nothing outside the desktop app', () => {
  vi.mocked(servers.canSwitchServers).mockReturnValue(false);
  const { container } = render(<ServerSwitcher collapsed={false} />);
  expect(container).toBeEmptyDOMElement();
});

test('shows Local and switches to a saved server', async () => {
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team hub' }));
  expect(servers.switchServer).toHaveBeenCalledWith('s1');
});

test('adding a server saves it then connects', async () => {
  vi.mocked(servers.addServer).mockResolvedValue({ id: 's2', name: 'NAS', url: 'https://nas.lan' });
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Add server/ }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NAS' } });
  fireEvent.change(screen.getByLabelText('Hub URL'), { target: { value: 'https://nas.lan' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
  await waitFor(() => expect(servers.switchServer).toHaveBeenCalledWith('s2'));
  expect(servers.addServer).toHaveBeenCalledWith('NAS', 'https://nas.lan');
});

test('an add error is shown and nothing switches', async () => {
  vi.mocked(servers.addServer).mockRejectedValue('That server is already saved');
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Add server/ }));
  fireEvent.change(screen.getByLabelText('Hub URL'), { target: { value: 'https://x.io' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add and connect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('already saved');
  expect(servers.switchServer).not.toHaveBeenCalled();
});

test('a failed switch shows the error and keeps the menu usable', async () => {
  vi.mocked(servers.switchServer).mockRejectedValueOnce('Unknown server');
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team hub' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown server');
});

test('removing asks first and only then removes', async () => {
  vi.mocked(servers.removeServer).mockResolvedValue(undefined);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Team hub' }));
  expect(servers.removeServer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Team hub' }));
  expect(servers.removeServer).toHaveBeenCalledWith('s1');
  await waitFor(() => expect(servers.listServers).toHaveBeenCalledTimes(2));
  confirm.mockRestore();
});

test('Escape and an outside click close the menu', async () => {
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Server: Local' }));
  fireEvent.click(screen.getByTestId('server-menu-backdrop'));
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test("a saved server's page can switch but not add or remove servers", async () => {
  vi.mocked(servers.canEditServers).mockReturnValue(false);
  render(<ServerSwitcher collapsed={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Server: Local' }));
  expect(screen.getByRole('menuitem', { name: 'Team hub' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /Add server/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove Team hub' })).not.toBeInTheDocument();
});
