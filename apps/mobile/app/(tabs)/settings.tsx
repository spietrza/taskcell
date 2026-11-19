import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Placeholder } from '../../src/Placeholder';
import { useSession } from '../../src/session';
import { useTheme } from '../../src/useTheme';

export default function Settings(): ReactNode {
  const theme = useTheme();
  const { credentials, disconnect } = useSession();
  return (
    <Placeholder title="Settings">
      <Text style={{ color: theme.caption }}>{credentials?.url}</Text>
      <Pressable accessibilityRole="button" onPress={() => void disconnect()} style={[styles.button, { borderColor: theme.destructive }]}>
        <Text style={{ color: theme.destructive, fontWeight: '600' }}>Disconnect</Text>
      </Pressable>
    </Placeholder>
  );
}

const styles = StyleSheet.create({
  button: { borderWidth: 1, borderRadius: 6, paddingVertical: 12, paddingHorizontal: 20 },
});
