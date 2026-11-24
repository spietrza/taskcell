import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from './Settings';
import { NavGuardContext, createNavGuardRegistry, type NavGuardRegistry } from '../../navGuard';
import { stubHubCalls } from '../../testHub';
import type { AppConfig } from '../../taskcell-output';
import { deferred } from '../../testUtils';

vi.mock('../../ipc.js', () => ({
  callerCapabilities: vi.fn(async () => ({})),
}));

// Hub panels with their own reads; not under test here.
vi.mock('./AutoMerge', () => ({ AutoMerge: () => null }));
vi.mock('./CredentialsPanel', async (importOriginal) => ({ ...(await importOriginal<typeof import('./CredentialsPanel')>()), CredentialsPanel: () => null }));

// The hub's app.json read and write, answered through the page session.
const read = vi.fn(async (_repoPath: string): Promise<AppConfig> => ({}));
const write = vi.fn(async (_repoPath: string, _config: AppConfig): Promise<void> => {});
beforeEach(() => {
  stubHubCalls({
    read_app_config_strict: ({ repoPath }) => read(repoPath),
    write_app_config: ({ repoPath, config }) => write(repoPath, config),
  });
});
afterEach(() => vi.restoreAllMocks());

function renderSettings(registry: NavGuardRegistry, project = '/repo') {
  return render(
    <NavGuardContext.Provider value={registry}>
      <Settings project={project} />
    </NavGuardContext.Provider>,
  );
}

// S8 / #339 follow-up: Settings holds real unsaved work behind an explicit Save button — shell
// navigations (project switch, Rail click, home, remove, running-run open, window close) unmount
// this screen, so the App-level registry is the only protection. Clean ⇒ unguarded.
test('guards while dirty and releases on a clean read', async () => {
  const registry = createNavGuardRegistry();
  read.mockResolvedValueOnce({});
  renderSettings(registry);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  expect(registry.guarded()).toBe(false);

  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'ready-label' } });
  expect(registry.guarded()).toBe(true);
});

test('the guard proxies window.confirm', async () => {
  const registry = createNavGuardRegistry();
  read.mockResolvedValueOnce({});
  renderSettings(registry);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'ready-label' } });

  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(registry.confirm()).toBe(false);
  confirmSpy.mockReturnValue(true);
  expect(registry.confirm()).toBe(true);
  confirmSpy.mockRestore();
});

test('a successful save releases the guard', async () => {
  const registry = createNavGuardRegistry();
  read.mockResolvedValueOnce({});
  renderSettings(registry);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'ready-label' } });
  expect(registry.guarded()).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(registry.guarded()).toBe(false));
  expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument();
});

// §1.2: an edit landing while the write is in flight lives in `cfg` but not on disk — clearing
// dirty would disable Save and disarm the guard, letting the next navigation discard it silently.
test('an edit made while the write is in flight keeps dirty true', async () => {
  const registry = createNavGuardRegistry();
  read.mockResolvedValueOnce({});
  const gate = deferred<void>();
  write.mockReturnValueOnce(gate.promise);
  renderSettings(registry);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'ready-label' } });

  const save = screen.getByRole('button', { name: /save/i });
  fireEvent.click(save);
  expect(write).toHaveBeenLastCalledWith('/repo', { chatModel: 'ready-label' });
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'ready-label-2' } });
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });

  expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
  expect(screen.queryByRole('button', { name: /saved/i })).not.toBeInTheDocument();
  expect(registry.guarded()).toBe(true);
});

test('dirty-but-unsavable is still guarded: unreadable config', async () => {
  const registry = createNavGuardRegistry();
  read.mockRejectedValueOnce(new Error('.taskcell/app.json is unreadable'));
  renderSettings(registry);
  await waitFor(() => expect(screen.getByText(/app\.json is unreadable/i)).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'x' } });
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(registry.guarded()).toBe(true);
});

test('dirty-but-unsavable is still guarded: invalid custom-provider row', async () => {
  const registry = createNavGuardRegistry();
  read.mockResolvedValueOnce({});
  renderSettings(registry);
  await screen.findByPlaceholderText('claude-sonnet-5');
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
  expect(await screen.findByText(/name must be lowercase/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(registry.guarded()).toBe(true);
});

test('unmounting while dirty releases the guard', async () => {
  const registry = createNavGuardRegistry();
  read.mockResolvedValueOnce({});
  const { unmount } = renderSettings(registry);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'x' } });
  expect(registry.guarded()).toBe(true);
  unmount();
  expect(registry.guarded()).toBe(false);
});
