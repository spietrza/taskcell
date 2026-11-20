import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Settings from '../app/(tabs)/settings';
import { SessionProvider, useSession } from './session';

const mockStore = new Map<string, string>();
let mockFailDelete = false;
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => {
    if (mockFailDelete) throw new Error('keychain locked');
    mockStore.delete(k);
  }),
}));

function Probe(): React.ReactNode {
  const { credentials, ready } = useSession();
  return <Text>{!ready ? 'loading' : credentials ? 'connected' : 'disconnected'}</Text>;
}

const renderSettings = async () => {
  mockStore.set('taskcell.hub.url', 'http://hub.local:4317');
  mockStore.set('taskcell.hub.token', 't');
  await render(
    <SessionProvider>
      <Settings />
      <Probe />
    </SessionProvider>,
  );
  await screen.findByText('connected');
};

beforeEach(() => {
  mockStore.clear();
  mockFailDelete = false;
});

test('Disconnect removes both keychain items', async () => {
  await renderSettings();
  await fireEvent.press(screen.getByText('Disconnect'));
  await waitFor(() => expect(screen.getByText('disconnected')).toBeTruthy());
  expect(mockStore.size).toBe(0);
});

test('a failed keychain delete shows an error and stays connected', async () => {
  await renderSettings();
  mockFailDelete = true;
  await fireEvent.press(screen.getByText('Disconnect'));
  expect(await screen.findByText(/Could not remove the connection/)).toBeTruthy();
  expect(screen.getByText('connected')).toBeTruthy();
  expect(mockStore.size).toBe(2);
});
