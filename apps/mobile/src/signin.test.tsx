import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking, Text } from 'react-native';
import Settings from '../app/(tabs)/settings';
import { ConnectScreen } from './ConnectScreen';
import { connectToHub, pollDeviceSignIn, startDeviceSignIn } from './connect';
import { SessionProvider, useSession } from './session';
import { loadCredentials } from './credentials';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

const ORIGIN = 'http://hub.local:4317';
const SESSION = 'tcd_session-secret';

interface Fake {
  fetchImpl: typeof fetch;
  calls: { path: string; method: string; token: string | null; body: string }[];
  /** Poll answers, consumed in order (the last repeats). */
  pollAnswers: { status: number; body: Record<string, unknown> }[];
}

/** A fake server-mode hub speaking the device flow (like src/hub/server.ts); `signIn: false` is a local-mode hub. */
interface FakeOptions {
  verificationUri?: string;
  meStatus?: number;
  /** Awaited before a token request is answered (to cancel while it is in flight). */
  beforeToken?: () => Promise<void>;
}

function fakeHub(signIn = true, { verificationUri = `${ORIGIN}/device`, meStatus, beforeToken }: FakeOptions = {}): Fake {
  const calls: Fake['calls'] = [];
  const pollAnswers: Fake['pollAnswers'] = [{ status: 400, body: { error: 'authorization_pending' } }];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const path = input.replace(ORIGIN, '');
    const method = init.method ?? 'GET';
    calls.push({ path, method, token: headers.get('x-vanguard-hub-token'), body: String(init.body ?? '') });
    const res = (status: number, body: unknown) => ({ status, json: async () => body });
    if (path === '/sign-in') return res(signIn ? 200 : 404, {});
    if (!signIn) return res(path === '/rpc/list_projects' && headers.get('x-vanguard-hub-token') === 'owner-token' ? 200 : 401, { result: [] });
    if (method === 'POST' && headers.get('origin') !== ORIGIN) return res(400, { error: { message: 'cross-origin request rejected' } });
    if (path === '/api/device/code') return res(200, { device_code: 'dev-secret', user_code: 'BCDFGHJK', verification_uri: verificationUri, expires_in: 600, interval: 5 });
    if (path === '/api/device/token') {
      await beforeToken?.();
      const answer = pollAnswers.length > 1 ? pollAnswers.shift()! : pollAnswers[0]!;
      return res(answer.status, answer.body);
    }
    if (path === '/api/device/me') return res(meStatus ?? (headers.get('x-vanguard-hub-token') === SESSION ? 200 : 401), { name: 'Octo Cat' });
    if (path === '/api/device/revoke') return res(200, { ok: true });
    return res(404, {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, pollAnswers };
}

function Probe(): React.ReactNode {
  const { credentials } = useSession();
  return <Text>{credentials ? `connected:${credentials.kind}:${credentials.name ?? ''}` : 'disconnected'}</Text>;
}

const noWait = (): Promise<void> => new Promise((r) => setTimeout(r, 100));
const renderConnect = async (hub: Fake) => {
  await render(
    <SessionProvider fetchImpl={hub.fetchImpl}>
      <ConnectScreen fetchImpl={hub.fetchImpl} sleep={noWait} />
      <Probe />
    </SessionProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText('Hub URL'), 'hub.local:4317');
};

let open: jest.SpyInstance;
beforeEach(() => {
  mockStore.clear();
  open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});
afterEach(() => open.mockRestore());

test('a member signs in: code shown, browser opened without any code or token, session kept as a member session', async () => {
  const hub = fakeHub();
  hub.pollAnswers.push({ status: 200, body: { access_token: SESSION, token_type: 'session' } });
  hub.pollAnswers.unshift({ status: 400, body: { error: 'authorization_pending' } });
  await renderConnect(hub);
  await fireEvent.press(await screen.findByText('Sign in', {}, { timeout: 3000 }));
  expect(await screen.findByText('BCDF-GHJK')).toBeTruthy();
  expect(open).toHaveBeenCalledWith(`${ORIGIN}/device`);
  await waitFor(() => expect(screen.getByText('connected:member:Octo Cat')).toBeTruthy());
  expect(mockStore.get('taskcell.hub.token')).toBe(SESSION);
  expect(mockStore.get('taskcell.hub.kind')).toBe('member');
  expect(await loadCredentials()).toEqual({ url: ORIGIN, token: SESSION, kind: 'member', name: 'Octo Cat' });
  // The device_code stays in the app and the hub's own pages: it is never in a URL we open.
  expect(open.mock.calls.flat().join(' ')).not.toMatch(/dev-secret|BCDFGHJK/);
});

const revokes = (hub: Fake): Fake['calls'] => hub.calls.filter((c) => c.path === '/api/device/revoke');
const FLOW = { url: ORIGIN, deviceCode: 'dev-secret', userCode: 'BCDFGHJK', verificationUri: `${ORIGIN}/device`, intervalS: 5, expiresInS: 600 };

test('cancel while the token request is in flight: the issued session is revoked on the hub and nothing is stored', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hub = fakeHub(true, { beforeToken: () => gate });
  hub.pollAnswers[0] = { status: 200, body: { access_token: SESSION, token_type: 'session' } };
  await renderConnect(hub);
  await fireEvent.press(await screen.findByText('Sign in', {}, { timeout: 3000 }));
  await screen.findByText('BCDF-GHJK');
  await waitFor(() => expect(hub.calls.some((c) => c.path === '/api/device/token')).toBe(true));
  await fireEvent.press(screen.getByText('Cancel sign-in'));
  release();
  await waitFor(() => expect(revokes(hub)).toEqual([{ path: '/api/device/revoke', method: 'POST', token: SESSION, body: '' }]));
  expect(screen.getByText('disconnected')).toBeTruthy();
  expect(mockStore.size).toBe(0);
});

test('a session /api/device/me does not accept is revoked, not kept', async () => {
  const hub = fakeHub(true, { meStatus: 500 });
  hub.pollAnswers[0] = { status: 200, body: { access_token: SESSION, token_type: 'session' } };
  expect(await pollDeviceSignIn(FLOW, { fetchImpl: hub.fetchImpl, sleep: async () => undefined })).toEqual({ ok: false, error: expect.stringContaining('did not accept the new session (500)') });
  expect(revokes(hub)).toHaveLength(1);
  expect(revokes(hub)[0]!.token).toBe(SESSION);
  // So is one whose /me call fails on the network.
  const flaky = fakeHub();
  flaky.pollAnswers[0] = { status: 200, body: { access_token: SESSION, token_type: 'session' } };
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    if (input.endsWith('/api/device/me')) throw new Error('Network request failed');
    return flaky.fetchImpl(input, init);
  }) as unknown as typeof fetch;
  expect(await pollDeviceSignIn(FLOW, { fetchImpl, sleep: async () => undefined })).toMatchObject({ ok: false, error: expect.stringContaining('Network request failed') });
  expect(revokes(flaky)).toHaveLength(1);
});

test('the verification page is opened only when it is http(s) on the hub origin the app connected to', async () => {
  for (const uri of ['https://evil.test/device', 'javascript:alert(1)', 'taskcell://device', 'https://hub.local:4317/device', 'http://hub.local:9999/device', 'not a url']) {
    const hub = fakeHub(true, { verificationUri: uri });
    expect(await startDeviceSignIn('hub.local:4317', hub.fetchImpl)).toMatchObject({ ok: false, error: expect.stringContaining('another address') });
  }
  expect(await startDeviceSignIn('hub.local:4317', fakeHub().fetchImpl)).toMatchObject({ ok: true, flow: { verificationUri: `${ORIGIN}/device` } });
  const hub = fakeHub(true, { verificationUri: 'https://evil.test/device' });
  await renderConnect(hub);
  await fireEvent.press(await screen.findByText('Sign in', {}, { timeout: 3000 }));
  expect(await screen.findByText(/another address/)).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  expect(hub.calls.some((c) => c.path === '/api/device/token')).toBe(false);
});

test('a non-allowlisted account is refused with the hub\'s message and nothing is stored', async () => {
  const hub = fakeHub();
  hub.pollAnswers[0] = { status: 403, body: { error: 'access_denied', error_description: 'Sign-up is not open on this hub: your account is not on the allowlist.' } };
  await renderConnect(hub);
  await fireEvent.press(await screen.findByText('Sign in', {}, { timeout: 3000 }));
  expect(await screen.findByText(/not on the allowlist/)).toBeTruthy();
  expect(screen.getByText('disconnected')).toBeTruthy();
  expect(mockStore.size).toBe(0);
});

test('wrong, expired or reused device codes surface the hub\'s reason; slow_down backs off', async () => {
  const hub = fakeHub();
  const flow = { url: ORIGIN, deviceCode: 'dev-secret', userCode: 'BCDFGHJK', verificationUri: `${ORIGIN}/device`, intervalS: 5, expiresInS: 600 };
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => void waits.push(ms);
  hub.pollAnswers.splice(0, 1, { status: 400, body: { error: 'slow_down' } }, { status: 400, body: { error: 'expired_token', error_description: 'The code expired. Start sign-in again.' } });
  expect(await pollDeviceSignIn(flow, { fetchImpl: hub.fetchImpl, sleep })).toEqual({ ok: false, error: 'The code expired. Start sign-in again.' });
  expect(waits).toEqual([5000, 10000]);
});

test('start fails clearly on an unreachable hub; no sign-in is offered on a local-mode hub', async () => {
  const down = (async () => {
    throw new Error('Network request failed');
  }) as unknown as typeof fetch;
  expect(await startDeviceSignIn('hub.local:4317', down)).toMatchObject({ ok: false, error: expect.stringContaining('Network request failed') });
  await renderConnect(fakeHub(false));
  await new Promise((r) => setTimeout(r, 700));
  expect(screen.queryByText('Sign in')).toBeNull();
});

test('the owner token still connects to a hub without sign-in, as an owner session', async () => {
  const hub = fakeHub(false);
  expect(await connectToHub('hub.local:4317', 'owner-token', hub.fetchImpl)).toEqual({ ok: true, credentials: { url: ORIGIN, token: 'owner-token', kind: 'owner' } });
});

test('Disconnect revokes a member session on the hub and clears the keychain; an owner token is not revoked', async () => {
  const hub = fakeHub();
  mockStore.set('taskcell.hub.url', ORIGIN);
  mockStore.set('taskcell.hub.token', SESSION);
  mockStore.set('taskcell.hub.kind', 'member');
  mockStore.set('taskcell.hub.name', 'Octo Cat');
  await render(
    <SessionProvider fetchImpl={hub.fetchImpl}>
      <Settings />
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('connected:member:Octo Cat');
  expect(screen.getByText('Signed in as Octo Cat')).toBeTruthy();
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
  expect(hub.calls.filter((c) => c.path === '/api/device/revoke')).toEqual([{ path: '/api/device/revoke', method: 'POST', token: SESSION, body: '' }]);
  expect(mockStore.size).toBe(0);
});

test('Disconnect of an owner token makes no revoke call', async () => {
  const hub = fakeHub();
  mockStore.set('taskcell.hub.url', ORIGIN);
  mockStore.set('taskcell.hub.token', 'owner-token');
  await render(
    <SessionProvider fetchImpl={hub.fetchImpl}>
      <Settings />
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('connected:owner:');
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
  expect(hub.calls).toEqual([]);
  expect(mockStore.size).toBe(0);
});
