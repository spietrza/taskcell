import type { ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useHub } from './hubContext';
import { useTheme } from './useTheme';

/** Shown by every screen once the hub has refused the session (RPC or stream 401). */
export function RejectedNotice(): ReactNode {
  const { credentials, rejected } = useHub();
  const theme = useTheme();
  if (!rejected) return null;
  return (
    <Text accessibilityRole="alert" style={[styles.notice, { color: theme.destructive }]}>
      {credentials.kind === 'member' ? 'Session ended, sign in again in Settings.' : 'Token rejected, reconnect in Settings.'}
    </Text>
  );
}

const styles = StyleSheet.create({ notice: { paddingHorizontal: 16, paddingBottom: 8 } });
