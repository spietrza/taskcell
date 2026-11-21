import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Credentials } from './credentials';
import { RerunButton, canRerun } from './Rerun';
import { followRun, loadRunView, loadRuns, type RunRow, type RunView, type RunsData } from './runs';
import { useTheme } from './useTheme';

type State = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: RunsData };

export function RunsScreen({ credentials, fetchImpl }: { credentials: Credentials; fetchImpl?: typeof fetch }): ReactNode {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<RunRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ status: 'ready', data: await loadRuns(credentials, fetchImpl) });
    } catch (err) {
      setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', error: String(err) }));
    }
  }, [credentials, fetchImpl]);

  useEffect(() => {
    setState({ status: 'loading' });
    setOpen(null);
    void load();
  }, [load]);

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

  const body = (): ReactNode => {
    if (open) return <RunDetailView credentials={credentials} row={open} fetchImpl={fetchImpl} onBack={() => setOpen(null)} />;
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
    const { active, recent } = state.data;
    const sections = [
      { title: 'Active', data: active },
      { title: 'Recent', data: recent },
    ].filter((s) => s.data.length > 0);
    return (
      <SectionList
        testID="list"
        sections={sections}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListEmptyComponent={() => message('No runs yet', 'Pull down to refresh.')}
        contentContainerStyle={styles.list}
        renderSectionHeader={({ section }) => <Text style={[styles.section, { color: theme.mutedForeground }]}>{section.title}</Text>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(item)}
            style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Text style={[styles.cardTitle, { color: theme.foreground }]}>{item.title}</Text>
            <Text style={{ color: theme.mutedForeground }}>{[item.repo, item.status, item.cost, item.age].filter(Boolean).join(' · ')}</Text>
          </Pressable>
        )}
      />
    );
  };

  return (
    <View testID="runs" style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top + 16 }]}>
      <Text style={[styles.heading, { color: theme.foreground }]}>Runs</Text>
      {body()}
    </View>
  );
}

function RunDetailView({ credentials, row, fetchImpl, onBack }: { credentials: Credentials; row: RunRow; fetchImpl?: typeof fetch; onBack: () => void }): ReactNode {
  const theme = useTheme();
  const [view, setView] = useState<RunView | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState(row.active);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (row.active) {
      setLive(true);
      return followRun(
        credentials,
        row,
        { onLines: setLines, onEnd: () => setLive(false), onError: setError },
        fetchImpl,
      );
    }
    let cancelled = false;
    loadRunView(credentials, row, fetchImpl).then(
      (v) => !cancelled && setView(v),
      (err) => !cancelled && setError(String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [credentials, row, fetchImpl]);

  const link = (label: string, url: string): ReactNode => (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => undefined)}>
      <Text style={{ color: theme.primary }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView testID="run-view" contentContainerStyle={styles.list}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={{ color: theme.primary }}>‹ Back to runs</Text>
      </Pressable>
      <Text style={[styles.heading, { color: theme.foreground, paddingHorizontal: 0 }]}>{row.title}</Text>
      <Text style={{ color: theme.mutedForeground }}>Repository: {row.repo || 'unknown'}</Text>
      <Text style={{ color: theme.foreground }}>Status: {row.active ? (live ? 'running' : 'ended') : row.status}</Text>
      {row.issueUrl ? link('Open issue', row.issueUrl) : null}
      {!row.active && canRerun(row.taskId, row.status) ? (
        <RerunButton credentials={credentials} repoPath={row.repoPath} taskId={row.taskId} title={row.title} fetchImpl={fetchImpl} />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.destructive }}>
          Could not read the run: {error}
        </Text>
      ) : null}
      {row.active ? (
        <>
          <Text style={[styles.section, { color: theme.mutedForeground }]}>{live ? 'Live transcript' : 'Transcript (run ended)'}</Text>
          {lines.length === 0 ? <Text style={{ color: theme.mutedForeground }}>No events yet.</Text> : null}
          {lines.map((l, i) => (
            <Text key={`${i}-${l}`} style={[styles.mono, { color: theme.foreground }]}>
              {l}
            </Text>
          ))}
        </>
      ) : view ? (
        <>
          <Text style={[styles.section, { color: theme.mutedForeground }]}>Timeline</Text>
          {view.detail.stages.map((s, i) => (
            <Text key={i} style={{ color: theme.foreground }}>
              {`${s.record.stage ?? `stage ${i + 1}`}: ${s.record.completed ? 'completed' : 'did not complete'}${s.record.model ? ` · ${s.record.model}` : ''}`}
            </Text>
          ))}
          <Text style={[styles.section, { color: theme.mutedForeground }]}>Changes</Text>
          <Text style={{ color: theme.foreground }}>
            {view.diff ? `${view.diff.files} files changed, +${view.diff.added} −${view.diff.removed}` : 'No diff recorded.'}
          </Text>
          {view.prUrl ? link('Open pull request', view.prUrl) : null}
          {view.diffUrl ? link('Open files changed', view.diffUrl) : null}
          {view.ciUrl ? link('Open CI run', view.ciUrl) : null}
        </>
      ) : error ? null : (
        <Text style={{ color: theme.mutedForeground }}>Loading…</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  heading: { fontSize: 24, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8 },
  center: { alignItems: 'center', gap: 8, padding: 24 },
  title: { fontSize: 18, fontWeight: '600' },
  retry: { alignSelf: 'center', padding: 12 },
  list: { gap: 10, padding: 16, flexGrow: 1 },
  section: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', paddingTop: 6 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  mono: { fontFamily: 'Menlo', fontSize: 12 },
});
