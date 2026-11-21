// The hub URL and token live only in the keychain (expo-secure-store): never AsyncStorage, never logged.
import * as SecureStore from 'expo-secure-store';

export interface Credentials {
  url: string;
  /** The hub owner token, or — for a signed-in member (`user` set) — the hub's bearer session. */
  token: string;
  /** Who is signed in on a server-mode hub; absent for the owner-token connection. */
  user?: string;
}

const URL_KEY = 'taskcell.hub.url';
const TOKEN_KEY = 'taskcell.hub.token';
const USER_KEY = 'taskcell.hub.user';
// The token is the hub owner's (or the member's session) bearer: keep it out of backups and off other devices.
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadCredentials(): Promise<Credentials | null> {
  const [url, token, user] = await Promise.all([SecureStore.getItemAsync(URL_KEY, KEYCHAIN), SecureStore.getItemAsync(TOKEN_KEY, KEYCHAIN), SecureStore.getItemAsync(USER_KEY, KEYCHAIN)]);
  return url && token ? { url, token, ...(user ? { user } : {}) } : null;
}

export async function saveCredentials({ url, token, user }: Credentials): Promise<void> {
  // A stale user from an earlier sign-in must not label an owner-token connection.
  if (!user) await SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined);
  await Promise.all([
    SecureStore.setItemAsync(URL_KEY, url, KEYCHAIN),
    SecureStore.setItemAsync(TOKEN_KEY, token, KEYCHAIN),
    ...(user ? [SecureStore.setItemAsync(USER_KEY, user, KEYCHAIN)] : []),
  ]);
}

export async function clearCredentials(): Promise<void> {
  // The token first: once it is gone the leftover URL alone is no credential, so a failed URL delete still ends disconnected.
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(URL_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined);
}
