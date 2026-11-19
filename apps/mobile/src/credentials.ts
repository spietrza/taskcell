// The hub URL and token live only in the keychain (expo-secure-store): never AsyncStorage, never logged.
import * as SecureStore from 'expo-secure-store';

export interface Credentials {
  url: string;
  token: string;
}

const URL_KEY = 'taskcell.hub.url';
const TOKEN_KEY = 'taskcell.hub.token';

export async function loadCredentials(): Promise<Credentials | null> {
  const [url, token] = await Promise.all([SecureStore.getItemAsync(URL_KEY), SecureStore.getItemAsync(TOKEN_KEY)]);
  return url && token ? { url, token } : null;
}

export async function saveCredentials({ url, token }: Credentials): Promise<void> {
  await Promise.all([SecureStore.setItemAsync(URL_KEY, url), SecureStore.setItemAsync(TOKEN_KEY, token)]);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(URL_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
}
