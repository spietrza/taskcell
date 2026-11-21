import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { showForegroundNotifications, tappedItem } from '../src/push';
import { SessionProvider, useSession } from '../src/session';

function Routes(): ReactNode {
  const { ready, credentials } = useSession();
  const router = useRouter();
  const tapped = tappedItem(Notifications.useLastNotificationResponse());
  // A tapped notification opens Home with that item's sheet (also when the tap launched the app).
  useEffect(() => {
    if (ready && credentials && tapped) router.navigate({ pathname: '/', params: { open: tapped.id, repoName: tapped.repoName, nk: tapped.key } });
  }, [ready, credentials, tapped?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready) return null;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={credentials !== null}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={credentials === null}>
        <Stack.Screen name="connect" />
      </Stack.Protected>
    </Stack>
  );
}

showForegroundNotifications();

export default function RootLayout(): ReactNode {
  return (
    <SessionProvider>
      <StatusBar style="auto" />
      <Routes />
    </SessionProvider>
  );
}
