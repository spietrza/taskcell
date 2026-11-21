import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadWaiting, toRows, type Row } from './needsYou';
import { useHub } from './hubContext';
import { useHubQuery } from './useHubQuery';
import { RejectedNotice } from './RejectedNotice';
import { ItemSheet } from './ItemSheet';
import { useTheme } from './useTheme';

export function HomeScreen({ openItem }: {
  /** A tapped notification's item: its sheet opens once, when the list holds it. */
  openItem?: { id: string; repoName: string; key: string };
}): ReactNode {
  const theme = useTheme();
  // The tab stack hides its header, so Home keeps its heading clear of the status bar itself.
  const insets = useSafeAreaInsets();
  const { credentials } = useHub();
  const { state, reload: load } = useHubQuery(async (client) => {
    const { items, failures } = await loadWaiting(client);
    return { rows: toRows(items), failures };
  });
  const [refreshing, setRefreshing] = useState(false);

  const [open, setOpen] = useState<Row | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!openItem || opened.current === openItem.key || state.status !== 'ready') return;
    const row = state.rows.find((r) => r.item.id === openItem.id && (!openItem.repoName || r.item.repoName === openItem.repoName));
    opened.current = openItem.key;
    if (row) setOpen(row);
  }, [openItem, state]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const message = (text: string, detail?: string): ReactNode => (
    <View style={styles.center}>
      <Text style={[styles.title, { color: theme.foreground }]}>{text}</Text>
      {detail ? <Text style={{ color: theme.mutedForeground }}>{detail}</Text> : null}
    </View>
  );

  return (
    <View testID="home" style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top + 16 }]}>
      <Text style={[styles.heading, { color: theme.foreground }]}>Waiting for you</Text>
      {credentials.kind === 'member' && credentials.name ? <Text style={[styles.notice, { color: theme.mutedForeground }]}>Signed in as {credentials.name}</Text> : null}
      <RejectedNotice />
      {notice ? <Text style={[styles.notice, { color: theme.primary }]}>{notice}</Text> : null}
      {open ? (
        <ItemSheet
          row={open}
          gone={state.status === 'ready' && !state.rows.some((r) => r.id === open.id)}
          onClose={() => setOpen(null)}
          onDone={(text) => {
            setOpen(null);
            setNotice(text);
            void load();
          }}
        />
      ) : null}
      {state.status === 'loading' ? (
        message('Loading…')
      ) : state.status === 'error' ? (
        <>
          {message('Hub unreachable', `Could not reach ${credentials.url}: ${state.error}`)}
          <Pressable accessibilityRole="button" onPress={() => void refresh()} style={styles.retry}>
            <Text style={{ color: theme.primary }}>Try again</Text>
          </Pressable>
        </>
      ) : (
        <>
          {state.error ? (
            <Text accessibilityRole="alert" style={[styles.notice, { color: theme.destructive }]}>
              Could not refresh from {credentials.url}: {state.error}
            </Text>
          ) : null}
          {state.failures.map((f) => (
            <Text key={f.repoPath} accessibilityRole="alert" style={[styles.notice, { color: theme.destructive }]}>
              Could not read {f.repoName || f.repoPath}: {f.error}
            </Text>
          ))}
        <FlatList
          testID="list"
          data={state.rows}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListEmptyComponent={() =>
            state.failures.length > 0
              ? message('Nothing readable is waiting for you', 'Some repositories could not be read.')
              : message('Nothing is waiting for you', 'Pull down to refresh.')
          }
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setNotice(null);
                setOpen(item);
              }}
              style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={[styles.caption, { color: item.alert ? theme.destructive : theme.primary }]}>{item.kind}</Text>
              <Text style={[styles.cardTitle, { color: theme.foreground }]}>{item.title}</Text>
              <Text style={{ color: theme.mutedForeground }}>{[item.repo, item.age].filter(Boolean).join(' · ')}</Text>
            </Pressable>
          )}
        />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  heading: { fontSize: 24, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8 },
  center: { alignItems: 'center', gap: 8, padding: 24 },
  title: { fontSize: 18, fontWeight: '600' },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
  retry: { alignSelf: 'center', padding: 12 },
  list: { gap: 10, padding: 16, flexGrow: 1 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  caption: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
});
