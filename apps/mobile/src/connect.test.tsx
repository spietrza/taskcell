import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ConnectScreen } from './ConnectScreen';
import { connectToHub, isCleartext, normalizeHubUrl } from './connect';
import { SessionProvider, useSession } from './session';
import { Text } from 'react-native';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

const TOKEN = 'good-token';
const requests: { url: string; token: string | undefined }[] = [];

/** A fake hub: `POST /rpc/list_projects` answers `{result: []}` for the right token, a 401 envelope otherwise. */
const fakeHub = (async (input: string, init: RequestInit) => {
  const headers = init.headers as Headers;
  const token = headers.get('x-vanguard-hub-token') ?? undefined;
  requests.push({ url: input, token });
  // Like the real hub: a POST without an Origin matching its host is a 400, whatever the token.
  if (headers.get('origin') !== 'http://hub.local:4317') return { status: 400, json: async () => ({ error: { message: 'cross-origin request rejected' } }) };
  const ok = input === 'http://hub.local:4317/rpc/list_projects' && token === TOKEN;
  return { status: ok ? 200 : 401, json: async () => (ok ? { result: [] } : { error: { message: 'bad hub token' } }) };
}) as unknown as typeof fetch;

beforeEach(() => {
  mockStore.clear();
  requests.length = 0;
});

test('normalizeHubUrl', () => {
  expect(normalizeHubUrl('hub.local:4317/')).toBe('http://hub.local:4317');
  expect(normalizeHubUrl('https://hub.example.com/x')).toBe('https://hub.example.com');
  expect(normalizeHubUrl('ftp://x')).toBeNull();
  expect(normalizeHubUrl('  ')).toBeNull();
});

test('connectToHub accepts a good token with one read call', async () => {
  const result = await connectToHub('hub.local:4317', ` ${TOKEN} `, fakeHub);
  expect(result).toEqual({ ok: true, credentials: { url: 'http://hub.local:4317', token: TOKEN, kind: 'owner' } });
  expect(requests).toHaveLength(1);
});

test('connectToHub reports a wrong token, an unreachable hub and empty input', async () => {
  expect(await connectToHub('hub.local:4317', 'nope', fakeHub)).toMatchObject({ ok: false, error: expect.stringContaining('bad hub token') });
  const down = (async () => {
    throw new Error('Network request failed');
  }) as unknown as typeof fetch;
  expect(await connectToHub('hub.local:4317', TOKEN, down)).toMatchObject({ ok: false, error: expect.stringContaining('Network request failed') });
  expect(await connectToHub('', TOKEN, fakeHub)).toMatchObject({ ok: false });
  expect(await connectToHub('hub.local:4317', '', fakeHub)).toMatchObject({ ok: false });
});

function Probe(): React.ReactNode {
  const { credentials } = useSession();
  return <Text>{credentials ? `connected:${credentials.url}` : 'disconnected'}</Text>;
}

const renderConnect = async () =>
  render(
    <SessionProvider>
      <ConnectScreen fetchImpl={fakeHub} />
      <Probe />
    </SessionProvider>,
  );

test('a wrong token shows an error, stores nothing and stays disconnected', async () => {
  await renderConnect();
  await fireEvent.changeText(screen.getByLabelText('Hub URL'), 'hub.local:4317');
  await fireEvent.changeText(screen.getByLabelText('Hub token'), 'wrong');
  await fireEvent.press(screen.getByText('Connect'));
  expect(await screen.findByText(/bad hub token/)).toBeTruthy();
  expect(screen.getByText('disconnected')).toBeTruthy();
  expect(mockStore.size).toBe(0);
});

test('a good token is kept in the keychain', async () => {
  await renderConnect();
  await fireEvent.changeText(screen.getByLabelText('Hub URL'), 'hub.local:4317');
  await fireEvent.changeText(screen.getByLabelText('Hub token'), TOKEN);
  await fireEvent.press(screen.getByText('Connect'));
  await waitFor(() => expect(screen.getByText('connected:http://hub.local:4317')).toBeTruthy());
  expect([...mockStore.values()].sort()).toEqual([TOKEN, 'http://hub.local:4317', 'owner'].sort());
});

test('isCleartext: http to a non-loopback host only', () => {
  expect(isCleartext('http://192.168.1.20:4317')).toBe(true);
  expect(isCleartext('http://hub.local:4317')).toBe(true);
  expect(isCleartext('https://192.168.1.20:4317')).toBe(false);
  expect(isCleartext('http://127.0.0.1:4317')).toBe(false);
  expect(isCleartext('http://localhost:4317')).toBe(false);
  expect(isCleartext('http://[::1]:4317')).toBe(false);
});

test('the Connect screen warns about cleartext http to a LAN address only', async () => {
  await renderConnect();
  const urlInput = screen.getByLabelText('Hub URL');
  await fireEvent.changeText(urlInput, 'http://192.168.1.20:4317');
  expect(screen.getByText(/cleartext/i)).toBeTruthy();
  await fireEvent.changeText(urlInput, 'https://192.168.1.20:4317');
  expect(screen.queryByText(/cleartext/i)).toBeNull();
  await fireEvent.changeText(urlInput, 'http://127.0.0.1:4317');
  expect(screen.queryByText(/cleartext/i)).toBeNull();
});
