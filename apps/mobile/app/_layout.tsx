import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { SessionProvider, useSession } from '../src/session';

function Routes(): ReactNode {
  const { ready, credentials } = useSession();
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

export default function RootLayout(): ReactNode {
  return (
    <SessionProvider>
      <StatusBar style="auto" />
      <Routes />
    </SessionProvider>
  );
}
