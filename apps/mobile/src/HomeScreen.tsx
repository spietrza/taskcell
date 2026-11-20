import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Credentials } from './credentials';
import { loadWaiting, toRows, watchHub, type Row } from './needsYou';
import { useTheme } from './useTheme';

type State = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; rows: Row[] };

export function HomeScreen({ credentials, fetchImpl }: { credentials: Credentials; fetchImpl?: typeof fetch }): ReactNode {
  const theme = useTheme();
  // The tab stack hides its header, so Home keeps its heading clear of the status bar itself.
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ status: 'ready', rows: toRows(await loadWaiting(credentials, fetchImpl)) });
    } catch (err) {
      setState({ status: 'error', error: String(err) });
    }
  }, [credentials, fetchImpl]);

  useEffect(() => {
    void load();
    return watchHub(credentials, () => void load(), fetchImpl);
  }, [credentials, fetchImpl, load]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
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
        <FlatList
          data={state.rows}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListEmptyComponent={() => message('Nothing is waiting for you', 'Pull down to refresh.')}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole={item.url ? 'link' : 'text'}
              disabled={item.url === null}
              onPress={() => item.url && void Linking.openURL(item.url)}
              style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={[styles.caption, { color: item.alert ? theme.destructive : theme.primary }]}>{item.kind}</Text>
              <Text style={[styles.cardTitle, { color: theme.foreground }]}>{item.title}</Text>
              <Text style={{ color: theme.mutedForeground }}>{[item.repo, item.age].filter(Boolean).join(' · ')}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  heading: { fontSize: 24, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8 },
  center: { alignItems: 'center', gap: 8, padding: 24 },
  title: { fontSize: 18, fontWeight: '600' },
  retry: { alignSelf: 'center', padding: 12 },
  list: { gap: 10, padding: 16, flexGrow: 1 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  caption: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
});
