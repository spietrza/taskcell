import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HomeScreen } from './HomeScreen';
import { kindLabel, toRows, type WaitingItem } from './needsYou';

const creds = { url: 'http://hub.local:4317', token: 't' };
/** An iPhone-like top inset (status bar), as expo-router's SafeAreaProvider would give it. */
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const renderHome = (el: ReactElement): ReturnType<typeof render> => render(<SafeAreaProvider initialMetrics={METRICS}>{el}</SafeAreaProvider>);
const NOW = Date.parse('2026-07-06T12:00:00Z');
const item = (o: Partial<WaitingItem>): WaitingItem => ({
  id: 'o/r#1', kind: 'pr', number: 1, repoSlug: 'o/r', title: 'T', url: 'https://github.com/o/r/pull/1', reason: 'taskcell:needs-human-review', ...o,
});

/** A fake hub: `list_needs_you_all` answers `items` (or fails), `/events` answers 404 (the stream is optional). */
const fakeHub = (items: WaitingItem[] | null, failures: unknown[] = []): typeof fetch =>
  (async (input: string) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    if (items === null) throw new Error('Network request failed');
    return { status: 200, json: async () => ({ result: { items, failures } }) };
  }) as unknown as typeof fetch;

test('toRows maps kinds, repo, age, newest first', () => {
  const rows = toRows(
    [
      item({ id: 'a', title: 'old', updatedAt: '2026-07-04T12:00:00Z' }),
      item({ id: 'b', kind: 'issue', ask: 'too-vague', title: 'new', updatedAt: '2026-07-06T09:00:00Z' }),
      item({ id: 'c', kind: 'issue', ask: 'question', title: 'none', url: '' }),
    ],
    NOW,
  );
  expect(rows.map((r) => [r.title, r.kind, r.repo, r.age, r.url])).toEqual([
    ['new', 'Too vague', 'o/r', '3h ago', 'https://github.com/o/r/pull/1'],
    ['old', 'PR ready', 'o/r', '2d ago', 'https://github.com/o/r/pull/1'],
    ['none', 'Question', 'o/r', '', null],
  ]);
  expect(kindLabel(item({ reason: 'changes requested' }))).toBe('Changes requested');
});

test('shows the waiting items and opens one in the browser', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  await renderHome(<HomeScreen credentials={creds} fetchImpl={fakeHub([item({ title: 'Add login' })])} />);
  await fireEvent.press(await screen.findByText('Add login'));
  expect(screen.getByText('PR ready')).toBeTruthy();
  expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
});

test('a hub card with no repoSlug shows its repoName', () => {
  const [row] = toRows([item({ kind: 'card', repoSlug: '', repoName: 'my-repo', updatedAt: '2026-07-06T09:00:00Z' })], NOW);
  expect(row!.repo).toBe('my-repo');
  expect(row!.age).toBe('3h ago');
});

test('shows repository read failures, even with no items', async () => {
  const failures = [{ repoPath: '/r', repoName: 'broken-repo', error: 'tracker down' }];
  await render(<HomeScreen credentials={creds} fetchImpl={fakeHub([], failures)} />);
  expect(await screen.findByText(/Could not read broken-repo: tracker down/)).toBeTruthy();
  expect(screen.queryByText('Nothing is waiting for you')).toBeNull();
});

test('a failed Linking.openURL is caught', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
  await render(<HomeScreen credentials={creds} fetchImpl={fakeHub([item({ title: 'Add login' })])} />);
  await fireEvent.press(await screen.findByText('Add login'));
});

/** A hub whose /events stream the test feeds, counting `list_needs_you_all` calls. */
function streamingHub(): { fetchImpl: typeof fetch; reads: () => number; emit: (frame: string) => void; failNext: () => void } {
  let reads = 0;
  let fail = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = (async (input: string) => {
    if (input.endsWith('/events')) {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      return { ok: true, status: 200, body };
    }
    reads += 1;
    await new Promise((r) => setTimeout(r, 30)); // a real read takes a while: a burst lands mid-read
    if (fail) throw new Error('Network request failed');
    return { status: 200, json: async () => ({ result: { items: [item({ title: 'Add login' })], failures: [] } }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, reads: () => reads, emit: (f) => controller.enqueue(new TextEncoder().encode(f)), failNext: () => void (fail = true) };
}
const frame = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

test('100 other events trigger no reload; a vanguard:changed burst at most one more', async () => {
  const hub = streamingHub();
  await render(<HomeScreen credentials={creds} fetchImpl={hub.fetchImpl} />);
  await screen.findByText('Add login');
  expect(hub.reads()).toBe(1);
  for (let i = 0; i < 100; i += 1) hub.emit(frame('run-update', { i }));
  await tick();
  expect(hub.reads()).toBe(1);
  hub.emit(Array.from({ length: 20 }, () => frame('vanguard:changed', '/r')).join(''));
  await new Promise((r) => setTimeout(r, 200));
  expect(hub.reads()).toBeGreaterThan(1);
  expect(hub.reads()).toBeLessThanOrEqual(3); // the initial read + at most two for the burst
});

test('a failed background reload keeps the list and shows the error inline', async () => {
  const hub = streamingHub();
  await render(<HomeScreen credentials={creds} fetchImpl={hub.fetchImpl} />);
  await screen.findByText('Add login');
  hub.failNext();
  hub.emit(frame('vanguard:changed', '/r'));
  expect(await screen.findByText(/Could not refresh from .*Network request failed/)).toBeTruthy();
  expect(screen.getByText('Add login')).toBeTruthy();
  expect(screen.queryByText('Hub unreachable')).toBeNull();
});

test('says so when nothing waits', async () => {
  await renderHome(<HomeScreen credentials={creds} fetchImpl={fakeHub([])} />);
  expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
});

test('says so when the hub is unreachable', async () => {
  await renderHome(<HomeScreen credentials={creds} fetchImpl={fakeHub(null)} />);
  await waitFor(() => expect(screen.getByText('Hub unreachable')).toBeTruthy());
  expect(screen.getByText(/Network request failed/)).toBeTruthy();
});

test('says so while loading', async () => {
  const pending = (() => new Promise(() => undefined)) as unknown as typeof fetch;
  await renderHome(<HomeScreen credentials={creds} fetchImpl={pending} />);
  expect(screen.getByText('Loading…')).toBeTruthy();
});

test('keeps the heading below the status bar', async () => {
  await renderHome(<HomeScreen credentials={creds} fetchImpl={fakeHub([])} />);
  await screen.findByText('Waiting for you');
  expect(StyleSheet.flatten(screen.getByTestId('home').props.style)).toMatchObject({ paddingTop: 47 + 16 });
});
