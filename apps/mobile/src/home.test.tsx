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
const fakeHub = (items: WaitingItem[] | null): typeof fetch =>
  (async (input: string) => {
    if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
    if (items === null) throw new Error('Network request failed');
    return { status: 200, json: async () => ({ result: { items, failures: [] } }) };
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
