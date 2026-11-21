// Push notifications (Expo push, APNs on iOS): ask for permission after the app has connected, register the Expo push
// token with the hub, and unregister it on Disconnect. A denied permission or any failure leaves the app working
// without push. The token is kept in the keychain only so Disconnect can name it; it is never logged or shown.
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { createHubClient } from '../../../packages/hub-client/src/client';
import { withOrigin } from './connect';
import type { Credentials } from './credentials';

const TOKEN_KEY = 'taskcell.push.token';
const OFF_KEY = 'taskcell.push.off';
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type PushStatus = 'on' | 'denied' | 'failed';

const hubClient = (c: Credentials, fetchImpl?: typeof fetch): ReturnType<typeof createHubClient> =>
  createHubClient({ baseUrl: c.url, token: c.token, fetch: withOrigin(c.url, fetchImpl) });

/** False once the user switched Notifications off in Settings. */
export const pushWanted = async (): Promise<boolean> => (await SecureStore.getItemAsync(OFF_KEY, KEYCHAIN).catch(() => null)) !== '1';

export async function setPushWanted(wanted: boolean): Promise<void> {
  if (wanted) await SecureStore.deleteItemAsync(OFF_KEY).catch(() => undefined);
  else await SecureStore.setItemAsync(OFF_KEY, '1', KEYCHAIN).catch(() => undefined);
}

/** Show notifications that arrive while the app is open. */
export function showForegroundNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/** Ask for permission (once; iOS remembers a refusal), get the Expo push token and register it with the hub. Never throws. */
export async function enablePush(c: Credentials, fetchImpl?: typeof fetch): Promise<PushStatus> {
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return 'denied';
    const { data: token } = await Notifications.getExpoPushTokenAsync();
    await hubClient(c, fetchImpl).call('register_push_token', { token, platform: 'ios' });
    await SecureStore.setItemAsync(TOKEN_KEY, token, KEYCHAIN);
    return 'on';
  } catch {
    return 'failed';
  }
}

/** Unregister this device's token on the hub and forget it. Best effort: an unreachable hub keeps nothing here. */
export async function disablePush(c: Credentials, fetchImpl?: typeof fetch): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY, KEYCHAIN).catch(() => null);
  if (!token) return;
  try {
    await hubClient(c, fetchImpl).call('unregister_push_token', { token });
  } catch {
    // The hub drops a token Expo reports dead; nothing more to do here.
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
}

/** The item a tapped notification names: the hub's id and repository name (never a path). */
export function tappedItem(response: Notifications.NotificationResponse | null | undefined): { id: string; repoName: string; key: string } | null {
  const data = response?.notification.request.content.data as { id?: unknown; repoName?: unknown } | undefined;
  if (typeof data?.id !== 'string') return null;
  return { id: data.id, repoName: typeof data.repoName === 'string' ? data.repoName : '', key: response!.notification.request.identifier };
}
