import { NativeTabs } from 'expo-router/native-tabs';
import type { ReactNode } from 'react';
import { useTheme } from '../../src/useTheme';

// The hub's four places, in its top-bar order.
export default function TabsLayout(): ReactNode {
  const theme = useTheme();
  return (
    <NativeTabs tintColor={theme.primary} backgroundColor={theme.background}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="board">
        <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.grid.2x2" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="runs">
        <NativeTabs.Trigger.Label>Runs</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="play.circle" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
