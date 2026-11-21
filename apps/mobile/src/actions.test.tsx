import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HomeScreen } from './HomeScreen';
import type { WaitingItem } from './needsYou';

jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(),
  authenticateAsync: jest.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));
const auth = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

const creds = { url: 'http://hub.local:4317', token: 't' };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const item = (o: Partial<WaitingItem>): WaitingItem => ({
  id: 'o/r#1', kind: 'pr', number: 1, repoSlug: 'o/r', repoPath: '/repo', repoName: 'r', title: 'Add login',
  url: 'https://github.com/o/r/pull/1', reason: 'taskcell:needs-human-review', ...o,
});

const caps = (allowed: boolean): unknown => {
  const c = { allowed, reason: allowed ? undefined : 'read-only' };
  return { project: { canReply: c, canMerge: c, canStartTask: c } };
};

/** A fake hub: lists `items`; a write command is recorded and answers `error` (hub refusal) or success (and the item leaves). */
function hub(items: WaitingItem[], error?: string, capabilities: unknown = caps(true)): { fetchImpl: typeof fetch; writes: { cmd: string; args: unknown }[] } {
  const writes: { cmd: string; args: unknown }[] = [];
  const fetchImpl = (async (input: string, init: { body: string }) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    const cmd = input.split('/rpc/')[1]!;
    if (cmd === 'list_needs_you_all') return { status: 200, json: async () => ({ result: { items, failures: [] } }) };
    if (cmd === 'caller_capabilities') return { status: 200, json: async () => ({ result: capabilities }) };
    writes.push({ cmd, args: JSON.parse(init.body) });
    if (error) return { status: 400, json: async () => ({ error: { message: error } }) };
    items.splice(0, items.length);
    return { status: 200, json: async () => ({ result: null }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, writes };
}

const open = async (title = 'Add login'): Promise<void> => {
  await fireEvent.press(await screen.findByText(title));
};
const renderHome = async (fetchImpl: typeof fetch): Promise<void> => {
  await render(<SafeAreaProvider initialMetrics={METRICS}><HomeScreen credentials={creds} fetchImpl={fetchImpl} /></SafeAreaProvider>);
};

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  auth.authenticateAsync.mockReset();
  auth.getEnrolledLevelAsync.mockResolvedValue(LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG);
});

test('merge calls the hub after Face ID succeeds, then the row leaves', async () => {
  auth.authenticateAsync.mockResolvedValue({ success: true } as never);
  const { fetchImpl, writes } = hub([item({})]);
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Merge'));
  await waitFor(() => expect(screen.getByText('Merged.')).toBeTruthy());
  expect(writes).toEqual([{ cmd: 'merge_needs_you', args: { repoPath: '/repo', id: 'o/r#1' } }]);
  await waitFor(() => expect(screen.queryByText('Add login')).toBeNull());
});

test('a failed or cancelled Face ID sends nothing', async () => {
  auth.authenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' } as never);
  const { fetchImpl, writes } = hub([item({})]);
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Merge'));
  await waitFor(() => expect(auth.authenticateAsync).toHaveBeenCalled());
  await screen.findByText('Merge not confirmed.');
  expect(writes).toEqual([]);
});

test('a passcode-only device gets the passcode check, not the dialog', async () => {
  auth.getEnrolledLevelAsync.mockResolvedValue(LocalAuthentication.SecurityLevel.SECRET);
  auth.authenticateAsync.mockResolvedValue({ success: true } as never);
  const alert = jest.spyOn(Alert, 'alert');
  const { fetchImpl, writes } = hub([item({})]);
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Merge'));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(auth.authenticateAsync).toHaveBeenCalledWith({ promptMessage: 'Merge: Add login' });
  expect(alert).not.toHaveBeenCalled();
  alert.mockRestore();
});

test('without biometrics or passcode, a dialog naming the PR confirms the merge', async () => {
  auth.getEnrolledLevelAsync.mockResolvedValue(LocalAuthentication.SecurityLevel.NONE);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.text === 'Merge')?.onPress?.());
  const { fetchImpl, writes } = hub([item({})]);
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Merge'));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(alert.mock.calls[0]![1]).toBe('Add login');
  expect(auth.authenticateAsync).not.toHaveBeenCalled();
});

test('a hub refusal is shown and the row stays', async () => {
  auth.authenticateAsync.mockResolvedValue({ success: true } as never);
  const { fetchImpl } = hub([item({})], 'checks are not green');
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Merge'));
  await screen.findByText(/checks are not green/);
  await fireEvent.press(screen.getByText('Close'));
  expect(screen.getByText('Add login')).toBeTruthy();
});

test.each([
  ['issue', { kind: 'issue', id: 'o/r#2', ask: 'question', reason: 'needs info' }],
  ['pr', { kind: 'pr', id: 'o/r#3', reason: 'changes requested' }],
  ['card', { kind: 'card', id: 'hub-4', url: '', ask: 'question', reason: 'asked' }],
] as const)('reply on %s sends the body; an empty body is refused', async (_n, o) => {
  const { fetchImpl, writes } = hub([item(o as Partial<WaitingItem>)]);
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Send reply'));
  await screen.findByText('Write a reply first.');
  expect(writes).toEqual([]);
  await fireEvent.changeText(screen.getByLabelText('Reply'), 'use sqlite');
  await fireEvent.press(screen.getByText('Send reply'));
  await waitFor(() => expect(screen.getByText('Reply sent.')).toBeTruthy());
  expect(writes).toEqual([{ cmd: 'reply_needs_you', args: { repoPath: '/repo', id: o.id, kind: o.kind, body: 'use sqlite' } }]);
  await waitFor(() => expect(screen.queryByText('Add login')).toBeNull());
});

test('a reply refusal is shown and the row stays', async () => {
  const { fetchImpl } = hub([item({ kind: 'issue', ask: 'question', reason: 'needs info' })], 'read-only member');
  await renderHome(fetchImpl);
  await open();
  await fireEvent.changeText(screen.getByLabelText('Reply'), 'hi');
  await fireEvent.press(screen.getByText('Send reply'));
  await screen.findByText(/read-only member/);
});

test('Request changes on a ready PR sends the body as the desktop does (reply_needs_you); an empty body is refused', async () => {
  auth.authenticateAsync.mockResolvedValue({ success: true } as never);
  const { fetchImpl, writes } = hub([item({})]);
  await renderHome(fetchImpl);
  await open();
  await fireEvent.press(screen.getByText('Request changes'));
  await screen.findByText('Describe the changes you want first.');
  expect(writes).toEqual([]);
  await fireEvent.changeText(screen.getByLabelText('Request changes'), 'rename foo');
  await fireEvent.press(screen.getByText('Request changes'));
  await waitFor(() => expect(screen.getByText('Changes requested.')).toBeTruthy());
  expect(writes).toEqual([{ cmd: 'reply_needs_you', args: { repoPath: '/repo', id: 'o/r#1', kind: 'pr', body: 'rename foo' } }]);
});

test('a read-only caller sees neither Merge nor Request changes', async () => {
  const { fetchImpl } = hub([item({})], undefined, caps(false));
  await renderHome(fetchImpl);
  await open();
  await waitFor(() => expect(screen.queryByText('Merge')).toBeNull());
  expect(screen.queryByText('Request changes')).toBeNull();
});

describe('Re-run on a failed card', () => {
  const card = (id: string): WaitingItem =>
    item({ id, kind: 'card', number: 4, repoSlug: '', url: '', reason: 'asked', ask: 'question', title: 'Board card', lastComment: { author: 'agent', body: 'Which DB?' } });

  test('a failed hub card offers Re-run, which calls hub_task_retry after the dialog', async () => {
    const { fetchImpl, writes } = hub([card('hub-4')]);
    await renderHome(fetchImpl);
    await open('Board card');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.text === 'Re-run')?.onPress?.());
    await fireEvent.press(await screen.findByText('Re-run'));
    expect(alert.mock.calls[0]![1]).toBe('Board card');
    await screen.findByText('Re-run requested.');
    expect(writes).toEqual([{ cmd: 'hub_task_retry', args: { repoPath: '/repo', id: 'hub-4' } }]);
  });

  test.each(['gh-27', 'gl-3', 'linear-ab12'])('a %s card offers no Re-run (it is not a failed hub card)', async (id) => {
    const { fetchImpl } = hub([card(id)]);
    await renderHome(fetchImpl);
    await open('Board card');
    await screen.findByText('Send reply');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Re-run')).toBeNull();
  });

  test('a read-only caller sees no Re-run on a failed hub card', async () => {
    const { fetchImpl } = hub([card('hub-4')], undefined, caps(false));
    await renderHome(fetchImpl);
    await open('Board card');
    await waitFor(() => expect(screen.queryByText('Send reply')).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Re-run')).toBeNull();
  });
});
