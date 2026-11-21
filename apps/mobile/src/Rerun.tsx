import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import type { CallerCapabilities } from '../../../packages/hub-client/src/wire';
import { useHub } from './hubContext';
import { loadCapabilities, rerunTask } from './needsYou';
import { useTheme } from './useTheme';

/** The caller's capabilities on a project; null until read (every action then stays open and the hub's refusal shows). */
export function useCapabilities(repoPath: string | undefined): CallerCapabilities['project'] | null {
  const { client } = useHub();
  const [caps, setCaps] = useState<CallerCapabilities['project'] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCaps(null);
    if (repoPath !== undefined) void loadCapabilities(client, repoPath).then((c) => !cancelled && setCaps(c));
    return () => {
      cancelled = true;
    };
  }, [client, repoPath]);
  return caps;
}

/** Whether the hub's retry accepts `taskId` in `status`, as the desktop offers it: a hub card (`hub-N`) only once failed
 * (`hub_task_retry`), a GitHub task (`gh-N`) only while paused by a provider limit (`retry_paused_task`). No other id has a retry. */
export const canRerun = (taskId: string, status: string): boolean =>
  /^hub-[1-9]\d{0,8}$/.test(taskId) ? status === 'failed' : /^gh-\d+$/.test(taskId) && status === 'stopped: provider limit';

/** "Re-run" for a failed or paused task, after a dialog naming it. Hidden when the caller may not start tasks. */
export function RerunButton({ repoPath, taskId, title }: {
  repoPath: string;
  taskId: string;
  title: string;
}): ReactNode {
  const theme = useTheme();
  const { client } = useHub();
  const caps = useCapabilities(repoPath);
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: string | null }>({ busy: false, message: null, error: null });
  const inFlight = useRef(false);
  if (caps?.canStartTask.allowed === false) return null;

  const go = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ busy: true, message: null, error: null });
    try {
      await rerunTask(client, repoPath, taskId);
      setState({ busy: false, message: 'Re-run requested.', error: null });
    } catch (err) {
      setState({ busy: false, message: null, error: String(err instanceof Error ? err.message : err) });
    } finally {
      inFlight.current = false;
    }
  };
  const confirm = (): void =>
    Alert.alert('Re-run task?', title, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Re-run', onPress: () => void go() },
    ], { cancelable: true });

  return (
    <>
      <Pressable accessibilityRole="button" disabled={state.busy} onPress={confirm} style={[styles.button, { backgroundColor: theme.primary }]}>
        <Text style={styles.buttonText}>Re-run</Text>
      </Pressable>
      {state.message ? <Text style={{ color: theme.foreground }}>{state.message}</Text> : null}
      {state.error ? <Text accessibilityRole="alert" style={{ color: theme.destructive }}>{state.error}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
