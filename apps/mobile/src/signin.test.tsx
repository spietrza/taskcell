import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Settings from '../app/(tabs)/settings';
import { ConnectScreen } from './ConnectScreen';
import { signInToHub, type OpenAuth } from './connect';
import { HomeScreen } from './HomeScreen';
import { SessionProvider, useSession } from './session';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const ORIGIN = 'http://hub.local:4317';
const OTT = 'one-time';
const SESSION = 'session-token';
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

let sessionLive = true;
let calls: { path: string; headers: Headers }[] = [];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers), json: async () => body });

/** A fake server-mode hub: providers, one-time-token exchange, bearer sessions, sign-out, and RPC that wants the bearer. */
const fakeHub = (async (input: string, init: RequestInit = {}) => {
  const headers = init.headers as Headers;
  const path = input.slice(ORIGIN.length);
  calls.push({ path, headers });
  if (headers.get('origin') !== ORIGIN) return json(400, { error: { message: 'cross-origin request rejected' } });
  if (path === '/api/auth/native/providers') return json(200, { providers: ['github', 'google'] });
  if (path === '/api/auth/one-time-token/verify') {
    const ok = JSON.parse(String(init.body)).token === OTT;
    return ok ? json(200, {}, { 'set-auth-token': SESSION }) : json(401, null);
  }
  const bearer = headers.get('authorization') === `Bearer ${SESSION}` && sessionLive;
  if (path === '/api/auth/get-session') return json(200, bearer ? { user: { name: 'Octo Cat', email: 'octo@nowhere.test' } } : null);
  if (path === '/api/auth/sign-out') {
    sessionLive = false;
    return json(200, { success: true });
  }
  if (headers.has('x-vanguard-hub-token')) return json(401, { error: { message: 'bad hub token' } });
  if (!bearer) return json(401, { error: { message: 'sign-in required' } });
  return json(200, { result: path === '/rpc/list_needs_you_all' ? { items: [], failures: [] } : [] });
}) as unknown as typeof fetch;

const allowed: OpenAuth = async (url, redirect) => {
  expect(url).toBe(`${ORIGIN}/api/auth/native/start?provider=github`);
  expect(redirect).toBe('taskcell://auth');
  return { type: 'success', url: `taskcell://auth?ott=${OTT}` };
};
const refused: OpenAuth = async () => ({ type: 'success', url: `taskcell://auth?error=${encodeURIComponent('Sign-up is not open on this hub: your account is not on the allowlist.')}` });

beforeEach(() => {
  mockStore.clear();
  sessionLive = true;
  calls = [];
});

function Probe(): React.ReactNode {
  const { credentials } = useSession();
  return <Text>{credentials ? `connected:${credentials.user ?? 'owner'}` : 'disconnected'}</Text>;
}

const renderConnect = (openAuth: OpenAuth): ReturnType<typeof render> =>
  render(
    <SessionProvider fetchImpl={fakeHub}>
      <ConnectScreen fetchImpl={fakeHub} openAuth={openAuth} />
      <Probe />
    </SessionProvider>,
  );

const pickGithub = async (): Promise<void> => {
  await fireEvent.changeText(screen.getByLabelText('Hub URL'), 'hub.local:4317');
  await fireEvent(screen.getByLabelText('Hub URL'), 'blur');
  await fireEvent.press(await screen.findByText('Sign in with GitHub'));
};

test('the hub reports its providers; an allowlisted member signs in, the session is kept in the keychain', async () => {
  await renderConnect(allowed);
  await pickGithub();
  expect(screen.getByText('Sign in with Google')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('connected:Octo Cat')).toBeTruthy());
  expect([...mockStore.values()].sort()).toEqual([ORIGIN, SESSION, 'Octo Cat'].sort());
});

test('a signed-in member reaches Home with their identity, over the bearer and no hub token', async () => {
  mockStore.set('taskcell.hub.url', ORIGIN);
  const result = await signInToHub('hub.local:4317', 'github', allowed, fakeHub);
  expect(result).toEqual({ ok: true, credentials: { url: ORIGIN, token: SESSION, user: 'Octo Cat' } });
  if (!result.ok) return;
  calls = [];
  const view: ReactElement = (
    <SafeAreaProvider initialMetrics={METRICS}>
      <HomeScreen credentials={result.credentials} fetchImpl={fakeHub} />
    </SafeAreaProvider>
  );
  await render(view);
  expect(await screen.findByText('Signed in as Octo Cat')).toBeTruthy();
  expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
  const rpc = calls.find((c) => c.path === '/rpc/list_needs_you_all');
  expect(rpc?.headers.get('authorization')).toBe(`Bearer ${SESSION}`);
  expect(rpc?.headers.has('x-vanguard-hub-token')).toBe(false);
});

test('a non-allowlisted account is refused with the hub message and nothing is stored', async () => {
  await renderConnect(refused);
  await pickGithub();
  expect(await screen.findByText(/Sign-up is not open on this hub/)).toBeTruthy();
  expect(screen.getByText('disconnected')).toBeTruthy();
  expect(mockStore.size).toBe(0);
});

test('a cancelled browser sheet signs nothing in', async () => {
  const result = await signInToHub('hub.local:4317', 'github', async () => ({ type: 'cancel' }), fakeHub);
  expect(result).toEqual({ ok: false, error: 'Sign-in was cancelled.' });
});

test('a hub without sign-in shows no provider buttons and the owner token still connects', async () => {
  const noAuth = (async (input: string, init: RequestInit = {}) => {
    const headers = init.headers as Headers;
    if (input.endsWith('/api/auth/native/providers')) return { status: 404, json: async () => ({}) };
    const ok = headers.get('x-vanguard-hub-token') === 'owner-token';
    return { status: ok ? 200 : 401, json: async () => (ok ? { result: [] } : { error: { message: 'bad hub token' } }) };
  }) as unknown as typeof fetch;
  await render(
    <SessionProvider>
      <ConnectScreen fetchImpl={noAuth} />
      <Probe />
    </SessionProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText('Hub URL'), 'hub.local:4317');
  await fireEvent(screen.getByLabelText('Hub URL'), 'blur');
  await fireEvent.changeText(screen.getByLabelText('Hub token'), 'owner-token');
  await fireEvent.press(screen.getByText('Connect'));
  await waitFor(() => expect(screen.getByText('connected:owner')).toBeTruthy());
  expect(screen.queryByText(/Sign in with/)).toBeNull();
  expect(mockStore.has('taskcell.hub.user')).toBe(false);
});

test('Disconnect revokes the member session on the hub and clears the keychain', async () => {
  mockStore.set('taskcell.hub.url', ORIGIN);
  mockStore.set('taskcell.hub.token', SESSION);
  mockStore.set('taskcell.hub.user', 'Octo Cat');
  await render(
    <SessionProvider fetchImpl={fakeHub}>
      <Settings />
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('connected:Octo Cat');
  expect(screen.getByText('Signed in as Octo Cat')).toBeTruthy();
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
  expect(sessionLive).toBe(false);
  expect(calls.find((c) => c.path === '/api/auth/sign-out')?.headers.get('authorization')).toBe(`Bearer ${SESSION}`);
  expect(mockStore.size).toBe(0);
});

test('an unreachable hub does not trap a member in the app', async () => {
  mockStore.set('taskcell.hub.url', ORIGIN);
  mockStore.set('taskcell.hub.token', SESSION);
  mockStore.set('taskcell.hub.user', 'Octo Cat');
  const down = (async () => {
    throw new Error('Network request failed');
  }) as unknown as typeof fetch;
  await render(
    <SessionProvider fetchImpl={down}>
      <Settings />
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('connected:Octo Cat');
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
  expect(mockStore.size).toBe(0);
});
