// The hub URL and token live only in the keychain (expo-secure-store): never AsyncStorage, never logged.
import * as SecureStore from 'expo-secure-store';

/** `owner`: the hub's owner token (single-user hub). `member`: a session the hub issued to a signed-in member (device flow). */
export type CredentialKind = 'owner' | 'member';

export interface Credentials {
  url: string;
  /** The owner token or the member session secret, per `kind`. */
  token: string;
  kind: CredentialKind;
  /** The signed-in member's display name (member sessions only). */
  name?: string;
}

const URL_KEY = 'taskcell.hub.url';
const TOKEN_KEY = 'taskcell.hub.token';
const KIND_KEY = 'taskcell.hub.kind';
const NAME_KEY = 'taskcell.hub.name';
// The token is a bearer: keep it out of backups and off other devices.
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadCredentials(): Promise<Credentials | null> {
  const [url, token, kind, name] = await Promise.all([URL_KEY, TOKEN_KEY, KIND_KEY, NAME_KEY].map((k) => SecureStore.getItemAsync(k, KEYCHAIN)));
  if (!url || !token) return null;
  // An item saved before sign-in existed has no kind: it is an owner token.
  return { url, token, kind: kind === 'member' ? 'member' : 'owner', ...(name ? { name } : {}) };
}

export async function saveCredentials({ url, token, kind, name }: Credentials): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(URL_KEY, url, KEYCHAIN),
    SecureStore.setItemAsync(TOKEN_KEY, token, KEYCHAIN),
    SecureStore.setItemAsync(KIND_KEY, kind, KEYCHAIN),
    name ? SecureStore.setItemAsync(NAME_KEY, name, KEYCHAIN) : SecureStore.deleteItemAsync(NAME_KEY),
  ]);
}

export async function clearCredentials(): Promise<void> {
  // The token first: once it is gone the leftover URL alone is no credential, so a failed URL delete still ends disconnected.
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await Promise.all([URL_KEY, KIND_KEY, NAME_KEY].map((k) => SecureStore.deleteItemAsync(k).catch(() => undefined)));
}
