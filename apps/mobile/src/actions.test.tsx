import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HomeScreen } from './HomeScreen';
import type { WaitingItem } from './needsYou';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));
const auth = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

const creds = { url: 'http://hub.local:4317', token: 't' };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const item = (o: Partial<WaitingItem>): WaitingItem => ({
  id: 'o/r#1', kind: 'pr', number: 1, repoSlug: 'o/r', repoPath: '/repo', repoName: 'r', title: 'Add login',
  url: 'https://github.com/o/r/pull/1', reason: 'taskcell:needs-human-review', ...o,
});

/** A fake hub: lists `items`; a write command is recorded and answers `error` (hub refusal) or success (and the item leaves). */
function hub(items: WaitingItem[], error?: string): { fetchImpl: typeof fetch; writes: { cmd: string; args: unknown }[] } {
  const writes: { cmd: string; args: unknown }[] = [];
  const fetchImpl = (async (input: string, init: { body: string }) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    const cmd = input.split('/rpc/')[1]!;
    if (cmd === 'list_needs_you_all') return { status: 200, json: async () => ({ result: { items, failures: [] } }) };
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

beforeEach(() => {
  auth.authenticateAsync.mockReset();
  auth.hasHardwareAsync.mockResolvedValue(true);
  auth.isEnrolledAsync.mockResolvedValue(true);
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

test('without biometrics or passcode, a dialog naming the PR confirms the merge', async () => {
  auth.isEnrolledAsync.mockResolvedValue(false);
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
