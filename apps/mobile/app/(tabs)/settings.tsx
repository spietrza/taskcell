import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { disablePush, enablePush, pushWanted, setPushWanted } from '../../src/push';
import { Placeholder } from '../../src/Placeholder';
import { useSession } from '../../src/session';
import { useTheme } from '../../src/useTheme';

export default function Settings(): ReactNode {
  const theme = useTheme();
  const { credentials, disconnect } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [notify, setNotify] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  useEffect(() => void pushWanted().then(setNotify), []);
  const toggleNotify = async (on: boolean): Promise<void> => {
    if (!credentials) return;
    setPushNote(null);
    if (!on) {
      setNotify(false);
      await setPushWanted(false);
      await disablePush(credentials);
      return;
    }
    const status = await enablePush(credentials);
    setNotify(status === 'on');
    await setPushWanted(status === 'on');
    if (status === 'denied') setPushNote('Notifications are turned off for Taskcell in iOS Settings.');
    else if (status === 'failed') setPushNote('Could not turn notifications on. Try again.');
  };
  const confirmDisconnect = async (): Promise<void> => {
    setError(null);
    try {
      await disconnect();
    } catch {
      setError('Could not remove the connection from the keychain. You are still connected.');
    }
  };
  return (
    <Placeholder title="Settings">
      <Text style={{ color: theme.caption }}>{credentials?.url}</Text>
      {credentials?.kind === 'member' && credentials.name ? <Text style={{ color: theme.caption }}>Signed in as {credentials.name}</Text> : null}
      <View style={styles.row}>
        <Text style={{ color: theme.foreground }}>Notifications</Text>
        <Switch accessibilityLabel="Notifications" value={notify} onValueChange={(on) => void toggleNotify(on)} />
      </View>
      {pushNote ? <Text style={{ color: theme.caption }}>{pushNote}</Text> : null}
      <Pressable accessibilityRole="button" onPress={() => void confirmDisconnect()} style={[styles.button, { borderColor: theme.destructive }]}>
        <Text style={{ color: theme.destructive, fontWeight: '600' }}>Disconnect</Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.destructive }}>
          {error}
        </Text>
      ) : null}
    </Placeholder>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  button: { borderWidth: 1, borderRadius: 6, paddingVertical: 12, paddingHorizontal: 20 },
});
