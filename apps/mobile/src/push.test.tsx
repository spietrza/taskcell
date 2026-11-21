import type { Credentials } from './credentials';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Settings from '../app/(tabs)/settings';
import { HomeScreen as Home } from './HomeScreen';
import { HubProvider } from './hubContext';
import { disablePush, enablePush, tappedItem } from './push';
import { SessionProvider, useSession } from './session';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));
let mockPermission = 'granted';
const mockRequest = jest.fn(async () => ({ status: mockPermission }));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: mockPermission })),
  requestPermissionsAsync: () => mockRequest(),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[abc]' })),
  setNotificationHandler: jest.fn(),
}));

/** A fake hub recording its RPC calls. */
const calls: { cmd: string; args: unknown }[] = [];
const hub = (async (input: string, init?: { body?: string }) => {
  if (input.endsWith('/events')) return { ok: false, status: 404, body: null };
  if (input.includes('/rpc/')) {
    calls.push({ cmd: input.split('/rpc/')[1]!, args: init?.body ? JSON.parse(init.body) : undefined });
    return { status: 200, json: async () => ({ result: null }) };
  }
  return { status: 200, json: async () => ({}) };
}) as unknown as typeof fetch;
const pushCalls = (): string[] => calls.map((c) => c.cmd).filter((c) => c.endsWith('push_token'));

function Probe(): React.ReactNode {
  const { credentials, ready } = useSession();
  return <Text>{!ready ? 'loading' : credentials ? 'connected' : 'disconnected'}</Text>;
}
const renderSettings = async (): Promise<void> => {
  mockStore.set('taskcell.hub.url', 'http://hub.local:4317');
  mockStore.set('taskcell.hub.token', 't');
  await render(
    <SessionProvider fetchImpl={hub}>
      <Settings />
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('connected');
};

beforeEach(() => {
  mockStore.clear();
  calls.length = 0;
  mockPermission = 'granted';
  mockRequest.mockClear();
});

test('after connecting, the token is registered with the hub; Disconnect unregisters it', async () => {
  await renderSettings();
  await waitFor(() => expect(pushCalls()).toEqual(['register_push_token']));
  expect(calls[0]!.args).toEqual({ token: 'ExponentPushToken[abc]', platform: 'ios' });
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
  expect(pushCalls()).toEqual(['register_push_token', 'unregister_push_token']);
  expect(calls[1]!.args).toEqual({ token: 'ExponentPushToken[abc]' });
  expect(mockStore.has('taskcell.push.token')).toBe(false);
});

test('denied permission leaves the app working and registers nothing', async () => {
  mockPermission = 'denied';
  await renderSettings();
  await waitFor(() => expect(mockRequest).toHaveBeenCalled());
  expect(pushCalls()).toEqual([]);
  expect(screen.getByText('connected')).toBeTruthy();
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
});

test('Settings shows the Notifications switch on; disablePush/enablePush toggle the hub registration', async () => {
  await renderSettings();
  await waitFor(() => expect(mockStore.has('taskcell.push.token')).toBe(true));
  expect(screen.getByRole('switch').props.value).toBe(true);
  const c = { url: 'http://hub.local:4317', token: 't', kind: 'owner' as const };
  await disablePush(c, hub);
  await enablePush(c, hub);
  expect(pushCalls()).toEqual(['register_push_token', 'unregister_push_token', 'register_push_token']);
});

test('a tapped notification opens that item\'s sheet on Home', async () => {
  const items = [
    { id: 'o/r#1', kind: 'pr', number: 1, repoSlug: 'o/r', title: 'First', url: 'https://github.com/o/r/pull/1', reason: 'x', repoName: 'r' },
    { id: 'o/r#2', kind: 'pr', number: 2, repoSlug: 'o/r', title: 'Second', url: 'https://github.com/o/r/pull/2', reason: 'x', repoName: 'r' },
  ];
  const fetchImpl = (async (input: string) => (input.endsWith('/events') ? { ok: false, status: 404, body: null } : { status: 200, json: async () => ({ result: { items, failures: [] } }) })) as unknown as typeof fetch;
  const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <HomeScreen credentials={{ url: 'http://hub.local:4317', token: 't', kind: 'owner' }} fetchImpl={fetchImpl} openItem={{ id: 'o/r#2', repoName: 'r', key: 'n1' }} />
    </SafeAreaProvider>,
  );
  expect(await screen.findByText('Open in GitHub')).toBeTruthy();
  const response = { notification: { request: { identifier: 'n1', content: { data: { id: 'o/r#2', repoName: 'r' } } } } };
  expect(tappedItem(response as never)).toEqual({ id: 'o/r#2', repoName: 'r', key: 'n1' });
  expect(tappedItem({ notification: { request: { identifier: 'n2', content: { data: {} } } } } as never)).toBeNull();
});

/** The screen inside the session's one hub connection, as the app provides it. */
function HomeScreen({ credentials, fetchImpl, ...props }: { credentials: Credentials; fetchImpl?: typeof fetch } & Parameters<typeof Home>[0]): ReactElement {
  return (
    <HubProvider credentials={credentials} fetchImpl={fetchImpl}>
      <Home {...props} />
    </HubProvider>
  );
}
