import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Credentials } from './credentials';
import type { RepoReadFailure } from '../../../packages/hub-client/src/wire';
import { COLUMNS, loadBoard, type Card } from './board';
import { watchHub } from './needsYou';
import { useTheme } from './useTheme';

type State =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  // `error`: the last background reload failed; the cards are the last good board.
  | { status: 'ready'; cards: Card[]; failures: RepoReadFailure[]; capped: boolean; error: string | null };

export function BoardScreen({ credentials, fetchImpl }: { credentials: Credentials; fetchImpl?: typeof fetch }): ReactNode {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [column, setColumn] = useState<string>(COLUMNS[0].key);
  const [openId, setOpenId] = useState<string | null>(null);

  const busy = useRef(false);
  const again = useRef(false); // a change arrived mid-read: one trailing read
  const running = useRef<Promise<void> | null>(null);
  const generation = useRef(0);

  const load = useCallback((): Promise<void> => {
    if (busy.current) {
      again.current = true;
      return running.current ?? Promise.resolve();
    }
    busy.current = true;
    const mine = generation.current;
    const read = (async (): Promise<void> => {
      try {
        do {
          again.current = false;
          try {
            const { cards, failures, capped } = await loadBoard(credentials, fetchImpl);
            if (mine !== generation.current) return;
            setState({ status: 'ready', cards, failures, capped, error: null });
          } catch (err) {
            if (mine !== generation.current) return;
            setState((prev) => (prev.status === 'ready' ? { ...prev, error: String(err) } : { status: 'error', error: String(err) }));
          }
        } while (again.current && mine === generation.current);
      } finally {
        if (mine === generation.current) busy.current = false;
      }
    })();
    running.current = read;
    return read;
  }, [credentials, fetchImpl]);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setState({ status: 'loading' });
    setRejected(false);
    setOpenId(null);
    void load();
    const close = watchHub(credentials, () => void load(), fetchImpl, () => setRejected(true));
    return () => {
      generation.current += 1;
      close();
    };
  }, [credentials, fetchImpl, load]);

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
  const open = (url: string): void => void Linking.openURL(url).catch(() => undefined);
  const link = (label: string, url: string): ReactNode => (
    <Pressable accessibilityRole="link" onPress={() => open(url)}>
      <Text style={{ color: theme.primary }}>{label}</Text>
    </Pressable>
  );

  const body = (): ReactNode => {
    if (state.status === 'loading') return message('Loading…');
    if (state.status === 'error') {
      return (
        <>
          {message('Hub unreachable', `Could not reach ${credentials.url}: ${state.error}`)}
          <Pressable accessibilityRole="button" onPress={() => void refresh()} style={styles.retry}>
            <Text style={{ color: theme.primary }}>Try again</Text>
          </Pressable>
        </>
      );
    }
    const card = openId === null ? undefined : state.cards.find((c) => c.id === openId);
    if (card) {
      return (
        <ScrollView testID="card-view" contentContainerStyle={styles.list}>
          <Pressable accessibilityRole="button" onPress={() => setOpenId(null)}>
            <Text style={{ color: theme.primary }}>‹ Back to the board</Text>
          </Pressable>
          <Text style={[styles.heading, { color: theme.foreground, paddingHorizontal: 0 }]}>{card.title}</Text>
          <Text style={{ color: theme.mutedForeground }}>Repository: {card.repo || 'unknown'}</Text>
          <Text style={{ color: theme.foreground }}>Status: {card.status}</Text>
          <Text style={{ color: theme.foreground }}>Latest run: {card.runStatus ?? 'no run yet'}</Text>
          {card.task.stage ? <Text style={{ color: theme.mutedForeground }}>Stage: {card.task.stage}</Text> : null}
          {card.task.schedule ? <Text style={{ color: theme.mutedForeground }}>{card.task.schedule.label}</Text> : null}
          {card.labels.length > 0 ? <Text style={{ color: theme.mutedForeground }}>Labels: {card.labels.join(', ')}</Text> : null}
          {card.prUrl ? link('Open pull request', card.prUrl) : null}
          {card.issueUrl ? link('Open issue', card.issueUrl) : null}
        </ScrollView>
      );
    }
    const shown = state.cards.filter((c) => c.column === column);
    return (
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
        {state.capped ? <Text style={[styles.notice, { color: theme.mutedForeground }]}>Some cards are missing: a repository hit the card limit.</Text> : null}
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segments}>
            {COLUMNS.map((c) => {
              const n = state.cards.filter((x) => x.column === c.key).length;
              const on = c.key === column;
              return (
                <Pressable
                  key={c.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setColumn(c.key)}
                  style={[styles.segment, { borderColor: theme.border, backgroundColor: on ? theme.primary : theme.card }]}
                >
                  <Text style={{ color: on ? theme.background : theme.foreground }}>{`${c.label} ${n}`}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        <FlatList
          testID="list"
          data={shown}
          keyExtractor={(c) => c.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListEmptyComponent={() =>
            state.cards.length === 0
              ? state.failures.length > 0
                ? message('No readable cards', 'Some repositories could not be read.')
                : message('No cards yet', 'Pull down to refresh.')
              : message('No cards in this column')
          }
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpenId(item.id)}
              style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={[styles.cardTitle, { color: theme.foreground }]}>{item.title}</Text>
              <Text style={{ color: theme.mutedForeground }}>{[item.repo, item.status, item.age].filter(Boolean).join(' · ')}</Text>
              {item.prUrl ? link('Open pull request', item.prUrl) : null}
            </Pressable>
          )}
        />
      </>
    );
  };

  return (
    <View testID="board" style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top + 16 }]}>
      <Text style={[styles.heading, { color: theme.foreground }]}>Board</Text>
      {rejected ? (
        <Text accessibilityRole="alert" style={[styles.notice, { color: theme.destructive }]}>
          Token rejected, reconnect in Settings.
        </Text>
      ) : null}
      {body()}
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
  segments: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  segment: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  list: { gap: 10, padding: 16, flexGrow: 1 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
});
