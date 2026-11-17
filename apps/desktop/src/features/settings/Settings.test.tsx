import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from './Settings';
import * as ipc from '../../ipc';

vi.mock('../../ipc.js', () => ({
  readAppConfigStrict: vi.fn(async () => ({})),
  writeAppConfig: vi.fn(async () => {}),
  callerCapabilities: vi.fn(async () => ({})),
}));

// Hub panels with their own reads; not under test here.
vi.mock('./AutoMerge', () => ({ AutoMerge: () => null }));
vi.mock('./CredentialsPanel', async (importOriginal) => ({ ...(await importOriginal<typeof import('./CredentialsPanel')>()), CredentialsPanel: () => null }));

const read = vi.mocked(ipc.readAppConfigStrict);
const write = vi.mocked(ipc.writeAppConfig);

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('the form does not render until the read resolves — a mid-load edit cannot be silently clobbered (S6 guard a)', async () => {
  const gate = deferred<Record<string, never>>();
  read.mockReturnValueOnce(gate.promise);
  render(<Settings project="/repo" />);
  // While loading: no editable fields at all (an edit here would be discarded by the resolving
  // setCfg while dirty stayed true — review #341 r3), and Save is disabled.
  expect(screen.queryByPlaceholderText('claude-sonnet-5')).not.toBeInTheDocument();
  expect(screen.getByText('Loading…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  gate.resolve({});
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled(); // still clean — not dirty
});

test('an unset task source shows "—" (not a default the board would reject); picking GitHub saves it', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  expect(screen.getByLabelText('Task source')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Task source'), { target: { value: 'github' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(write).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ taskSource: 'github', source: 'github' })));
});

test('a project configured before taskSource shows its legacy source', async () => {
  read.mockResolvedValueOnce({ source: 'gitlab' });
  render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByLabelText('Task source')).toHaveValue('gitlab'));
});

test('task source and run location are editable, saved per project, and bad pairs are explained', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Task source'), { target: { value: 'linear' } });
  fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'watch' } });
  expect(screen.getByRole('note')).toHaveTextContent(/still need a code host/);
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ taskSource: 'linear', source: 'linear', runLocation: 'watch' }));
});

test('an unreadable config surfaces an error and blocks save instead of silently defaulting (S6 guard b)', async () => {
  read.mockRejectedValueOnce(new Error('.taskcell/app.json is unreadable: expected value at line 1'));
  render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByText(/app\.json is unreadable/i)).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'x' } });
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(write).not.toHaveBeenCalled();
});

test('an invalid custom-provider row blocks save with an inline message', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
  // a fresh empty row is invalid (empty name) — save blocked, message shown
  expect(await screen.findByText(/name must be lowercase/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
});

test('a valid custom-provider row saves through writeAppConfig with only name/baseUrl/keyEnv/model', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
  fireEvent.change(screen.getAllByRole('textbox').find((el) => el.closest('label')?.textContent?.startsWith('Provider name'))!, {
    target: { value: 'my-proxy' },
  });
  fireEvent.change(screen.getByPlaceholderText('MY_PROXY_API_KEY'), { target: { value: 'MY_KEY' } });
  fireEvent.change(screen.getByPlaceholderText('https://llm.example.com/api'), {
    target: { value: 'https://llm.example.com/api' },
  });
  const save = screen.getByRole('button', { name: /save/i });
  await waitFor(() => expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await waitFor(() => expect(write).toHaveBeenCalled());
  // Exact row shape: an extra key leaking into a SAVED row would survive the raw-Value round-trip
  // forever, so objectContaining is not enough here (review #341 r2 minor).
  expect(vi.mocked(write).mock.calls[0]?.[1]?.customProviders).toEqual([
    { name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_KEY' },
  ]);
});

// T13 (#339 follow-up): every case in this file renders <Settings> WITHOUT a NavGuardContext
// provider, so they exercise useDiscardGuard's null-registry path end-to-end (AC-1 clause 4).
// Make that explicit: a dirty, provider-less Settings must neither throw nor touch window.confirm.
test('a dirty Settings with no nav-guard provider is inert — no throw, no confirm prompt', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm');
  read.mockResolvedValueOnce({});
  const { unmount } = render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByPlaceholderText('claude-sonnet-5')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('claude-sonnet-5'), { target: { value: 'x' } });
  expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
  expect(() => unmount()).not.toThrow();
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test('a save the hub refuses shows its message and keeps the input', async () => {
  read.mockResolvedValueOnce({});
  write.mockRejectedValueOnce('Invalid base branch "no such branch!!"');
  render(<Settings project="/repo" />);
  const branch = await screen.findByPlaceholderText('claude-sonnet-5');
  fireEvent.change(branch, { target: { value: 'no such branch!!' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid base branch "no such branch!!"');
  expect(branch).toHaveValue('no such branch!!');
  expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
});

test('an out-of-range number names its range and blocks save', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  fireEvent.change(await screen.findByPlaceholderText('80'), { target: { value: '500' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Usage cap % must be from 1 to 100');
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '80' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
});

test('the hub board can be picked as a task source', async () => {
  read.mockResolvedValueOnce({ taskSource: 'hub' });
  render(<Settings project="/repo" />);
  const select = (await screen.findByLabelText('Task source')) as HTMLSelectElement;
  expect(select).toHaveValue('hub');
  expect(screen.getByRole('option', { name: 'Hub board' })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'GitHub Issues' })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'Self-hosted (watch)' })).toBeEnabled();
});

test('"Runs on" shows the local hub for a hub-board project with no stored location, and a stored one as is', async () => {
  read.mockResolvedValueOnce({ taskSource: 'hub' });
  const first = render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByLabelText('Runs on')).toHaveValue('local'));
  first.unmount();
  read.mockResolvedValueOnce({ taskSource: 'hub', runLocation: 'gitlab-ci' });
  const second = render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByLabelText('Runs on')).toHaveValue('gitlab-ci'));
  second.unmount();
  read.mockResolvedValueOnce({ taskSource: 'github' });
  render(<Settings project="/repo" />);
  await waitFor(() => expect(screen.getByLabelText('Runs on')).toHaveValue('github-actions'));
});

test('Enter in a single-line field saves a valid form, and does nothing while the form is invalid', async () => {
  write.mockClear();
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  const label = await screen.findByPlaceholderText('claude-sonnet-5');
  fireEvent.keyDown(label, { key: 'Enter' }); // nothing edited: nothing to save
  expect(write).not.toHaveBeenCalled();
  fireEvent.change(label, { target: { value: 'ready-label' } });
  fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '500' } }); // out of range
  fireEvent.keyDown(label, { key: 'Enter' });
  expect(write).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText('80'), { target: { value: '50' } });
  fireEvent.keyDown(label, { key: 'Enter' });
  await waitFor(() => expect(write).toHaveBeenCalledWith('/repo', expect.objectContaining({ chatModel: 'ready-label', usageCapPct: 50 })));
  expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
});

test('Save is closed, with the reason, when the hub refuses remote writes', async () => {
  vi.mocked(ipc.callerCapabilities).mockResolvedValueOnce({ project: { canChangeSettings: { allowed: false, reason: 'the hub refuses remote writes' } } } as never);
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  fireEvent.change(await screen.findByPlaceholderText('claude-sonnet-5'), { target: { value: 'go' } });
  const save = screen.getByRole('button', { name: /save/i });
  await waitFor(() => expect(save).toHaveAttribute('title', 'the hub refuses remote writes'));
  expect(save).toBeDisabled();
});

test('a setting explains itself behind an info button', async () => {
  read.mockResolvedValueOnce({});
  render(<Settings project="/repo" />);
  expect(await screen.findByLabelText('Task source')).toBeInTheDocument();
  expect(screen.getAllByTestId('field-help').length).toBeGreaterThan(0);
  expect(screen.getByText(/Where this project's tasks come from/)).toHaveClass('sr-only');
});

test('Discard changes puts back the config as last read, and Save goes quiet again', async () => {
  read.mockResolvedValueOnce({ chatModel: 'go' });
  render(<Settings project="/repo" />);
  const field = await screen.findByPlaceholderText('claude-sonnet-5');
  expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
  fireEvent.change(field, { target: { value: 'oops' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.getByPlaceholderText('claude-sonnet-5')).toHaveValue('go');
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
});
