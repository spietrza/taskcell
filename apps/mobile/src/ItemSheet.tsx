import { useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useHub } from './hubContext';
import { mergeItem, replyItem, type Row } from './needsYou';
import { RerunButton, canRerun, useCapabilities } from './Rerun';
import { useTheme } from './useTheme';

const openUrl = (url: string): void => void Linking.openURL(url).catch(() => undefined);

/** Face ID / passcode; with neither on the device, a plain dialog naming the PR. True only when confirmed. */
async function confirmMerge(title: string): Promise<boolean> {
  // SECRET (passcode only) counts too: authenticateAsync falls back to the passcode.
  if ((await LocalAuthentication.getEnrolledLevelAsync()) > LocalAuthentication.SecurityLevel.NONE) {
    const res = await LocalAuthentication.authenticateAsync({ promptMessage: `Merge: ${title}` });
    return res.success;
  }
  return new Promise<boolean>((resolve) =>
    Alert.alert('Merge pull request?', title, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Merge', style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

export function ItemSheet({ row, onClose, onDone }: {
  row: Row;
  onClose: () => void;
  /** The action succeeded: the parent reloads and shows `message`. */
  onDone: (message: string) => void;
}): ReactNode {
  const theme = useTheme();
  const { client } = useHub();
  const { item } = row;
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // set synchronously: a second tap before `busy` renders sends nothing
  const [error, setError] = useState<string | null>(null);
  const caps = useCapabilities(item.repoPath);
  // Null caps (unread) leaves each action open: the hub still refuses what the caller may not do.
  const canMerge = row.kind === 'PR ready' && item.kind === 'pr' && !item.mergeBlocked && caps?.canMerge.allowed !== false;
  const replyAllowed = caps?.canReply.allowed !== false;
  const canReply = replyAllowed && (row.kind === 'Question' || row.kind === 'Too vague' || row.kind === 'Changes requested');
  // The desktop's "Ask for changes" is `reply_needs_you` on the PR: the hub comments and sets `needs revision`.
  const canRequest = replyAllowed && row.kind === 'PR ready' && item.kind === 'pr';
  // A hub card is listed only while its run failed (src/hub/asking.ts), so it can be retried as well as answered.
  const rerunRepo = item.kind === 'card' && canRerun(item.id, 'failed') ? item.repoPath : undefined;

  const run = async (act: () => Promise<void>, done: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await act();
      onDone(done);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      inFlight.current = false;
      setBusy(false);
    }
  };
  const merge = (): Promise<void> =>
    run(async () => {
      if (!(await confirmMerge(row.title))) throw new Error('Merge not confirmed.');
      await mergeItem(client, item);
    }, 'Merged.');
  const send = async (text: string, empty: string, done: string): Promise<void> => {
    if (!text.trim()) return setError(empty);
    await run(() => replyItem(client, item, text), done);
  };
  const reply = (): Promise<void> => send(body, 'Write a reply first.', 'Reply sent.');
  const requestChanges = (): Promise<void> => send(body.trim(), 'Describe the changes you want first.', 'Changes requested.');

  const button = (label: string, onPress: () => Promise<void>): ReactNode => (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onPress()} style={[styles.button, { backgroundColor: theme.primary }]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View testID="sheet" style={[styles.root, { backgroundColor: theme.background }]}>
        <Text style={[styles.caption, { color: row.alert ? theme.destructive : theme.primary }]}>{row.kind}</Text>
        <Text style={[styles.title, { color: theme.foreground }]}>{row.title}</Text>
        <Text style={{ color: theme.mutedForeground }}>{[row.repo, row.age].filter(Boolean).join(' · ')}</Text>
        <Text style={{ color: theme.foreground }}>{item.lastComment?.body ?? item.reason}</Text>
        {item.mergeBlocked ? <Text style={{ color: theme.destructive }}>{item.mergeBlocked}</Text> : null}
        {row.url ? (
          <Pressable accessibilityRole="link" onPress={() => openUrl(row.url!)}>
            <Text style={{ color: theme.primary }}>Open in GitHub</Text>
          </Pressable>
        ) : null}
        {canReply || canRequest ? (
          <TextInput
            accessibilityLabel={canRequest ? 'Request changes' : 'Reply'}
            placeholder={canRequest ? 'What should change?' : 'Reply'}
            multiline
            value={body}
            onChangeText={setBody}
            style={[styles.input, { color: theme.foreground, borderColor: theme.border }]}
          />
        ) : null}
        {error ? <Text accessibilityRole="alert" style={{ color: theme.destructive }}>{error}</Text> : null}
        {busy ? <ActivityIndicator /> : null}
        {canMerge ? button('Merge', merge) : null}
        {canReply ? button('Send reply', reply) : null}
        {canRequest ? button('Request changes', requestChanges) : null}
        {rerunRepo !== undefined ? <RerunButton repoPath={rerunRepo} taskId={item.id} title={row.title} /> : null}
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
          <Text style={{ color: theme.primary }}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 20, gap: 10 },
  caption: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  title: { fontSize: 20, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 8, minHeight: 80, padding: 10, textAlignVertical: 'top' },
  button: { borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  close: { alignSelf: 'center', padding: 12 },
});
