import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Credentials } from './credentials';
import type { RepoReadFailure } from '../../../packages/hub-client/src/wire';
import { loadWaiting, toRows, watchHub, type Row } from './needsYou';
import { useTheme } from './useTheme';

type State =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  // `error`: the last background reload failed; the rows are the last good list.
  | { status: 'ready'; rows: Row[]; failures: RepoReadFailure[]; error: string | null };

const openUrl = (url: string): void => void Linking.openURL(url).catch(() => undefined);

export function HomeScreen({ credentials, fetchImpl }: { credentials: Credentials; fetchImpl?: typeof fetch }): ReactNode {
  const theme = useTheme();
  // The tab stack hides its header, so Home keeps its heading clear of the status bar itself.
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const busy = useRef(false);
  const again = useRef(false); // a change arrived mid-read: one trailing read
  const generation = useRef(0); // a response for an older credentials/mount is dropped

  const load = useCallback(async (): Promise<void> => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    const mine = generation.current;
    try {
      do {
        again.current = false;
        try {
          const { items, failures } = await loadWaiting(credentials, fetchImpl);
          if (mine !== generation.current) return;
          setState({ status: 'ready', rows: toRows(items), failures, error: null });
        } catch (err) {
          if (mine !== generation.current) return;
          // Keep a good list; only the first load has nothing to keep.
          setState((prev) => (prev.status === 'ready' ? { ...prev, error: String(err) } : { status: 'error', error: String(err) }));
        }
      } while (again.current && mine === generation.current);
    } finally {
      if (mine === generation.current) busy.current = false;
    }
  }, [credentials, fetchImpl]);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setState({ status: 'loading' });
    void load();
    const close = watchHub(credentials, () => void load(), fetchImpl);
    return () => {
      generation.current += 1;
      close();
    };
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
              accessibilityRole={item.url ? 'link' : 'text'}
              disabled={item.url === null}
              onPress={() => item.url && openUrl(item.url)}
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
