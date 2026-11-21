import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { connectToHub, hubHasSignIn, isCleartext, normalizeHubUrl, pollDeviceSignIn, startDeviceSignIn, type DeviceSignIn, type PollOptions } from './connect';
import { useSession } from './session';
import { useTheme } from './useTheme';

export function ConnectScreen({ fetchImpl, sleep }: { fetchImpl?: typeof fetch; sleep?: PollOptions['sleep'] }): ReactNode {
  const theme = useTheme();
  const { connect } = useSession();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signInOffered, setSignInOffered] = useState(false);
  const [flow, setFlow] = useState<DeviceSignIn | null>(null);
  const cancel = useRef<AbortController | null>(null);

  // Offer Sign in only when the hub has server-mode sign-in (debounced: the URL is being typed).
  useEffect(() => {
    setSignInOffered(false);
    if (normalizeHubUrl(url) === null) return;
    let live = true;
    const timer = setTimeout(() => void hubHasSignIn(url, fetchImpl).then((yes) => live && setSignInOffered(yes)), 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [url, fetchImpl]);
  useEffect(() => () => cancel.current?.abort(), []);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const started = await startDeviceSignIn(url, fetchImpl);
    if (!started.ok) {
      setError(started.error);
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    cancel.current = abort;
    setFlow(started.flow);
    // The page carries no code, session or token: the member signs in there and types the code shown here.
    void Linking.openURL(started.flow.verificationUri).catch(() => undefined);
    const result = await pollDeviceSignIn(started.flow, { fetchImpl, signal: abort.signal, ...(sleep ? { sleep } : {}) });
    if (abort.signal.aborted) return;
    setFlow(null);
    if (result.ok) {
      try {
        await connect(result.credentials);
      } catch {
        setError('Could not save the connection to the keychain.');
      }
    } else {
      setError(result.error);
    }
    setBusy(false);
  };
  const cancelSignIn = (): void => {
    cancel.current?.abort();
    setFlow(null);
    setBusy(false);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await connectToHub(url, token, fetchImpl);
    if (result.ok) {
      try {
        await connect(result.credentials);
      } catch {
        setError('Could not save the connection to the keychain.');
      }
    } else {
      setError(result.error);
    }
    setBusy(false);
  };

  const normalized = normalizeHubUrl(url);
  const cleartext = normalized !== null && isCleartext(normalized);
  const input = [styles.input, { color: theme.foreground, backgroundColor: theme.muted, borderColor: theme.input }];
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.foreground }]}>Connect to a hub</Text>
      <Text style={[styles.caption, { color: theme.caption }]}>Run taskcell hub and enter its URL and token, or sign in if the hub offers it</Text>
      <TextInput
        accessibilityLabel="Hub URL"
        placeholder="http://192.168.1.20:7777"
        placeholderTextColor={theme.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="none"
        autoComplete="off"
        value={url}
        onChangeText={setUrl}
        style={input}
      />
      <TextInput
        accessibilityLabel="Hub token"
        placeholder="Hub token"
        placeholderTextColor={theme.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        textContentType="none"
        autoComplete="off"
        value={token}
        onChangeText={setToken}
        style={input}
      />
      {cleartext ? (
        <Text accessibilityRole="alert" style={{ color: theme.destructive }}>
          Cleartext warning: http:// sends the hub token unencrypted over the network. Use https:// unless this is a network you trust.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.destructive }}>
          {error}
        </Text>
      ) : null}
      {flow ? (
        <>
          <Text style={{ color: theme.foreground }}>Sign in in the browser, then type this code on the page:</Text>
          <Text accessibilityLabel="Sign-in code" selectable style={[styles.code, { color: theme.foreground }]}>
            {`${flow.userCode.slice(0, 4)}-${flow.userCode.slice(4)}`}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => void Linking.openURL(flow.verificationUri).catch(() => undefined)}>
            <Text style={{ color: theme.primary }}>Open {flow.verificationUri} again</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={cancelSignIn}>
            <Text style={{ color: theme.destructive }}>Cancel sign-in</Text>
          </Pressable>
        </>
      ) : signInOffered ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void signIn()} style={[styles.button, { borderWidth: 1, borderColor: theme.primary, opacity: busy ? 0.6 : 1 }]}>
          <Text style={[styles.buttonText, { color: theme.primary }]}>Sign in</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void submit()} style={[styles.button, { backgroundColor: theme.primary, opacity: busy ? 0.6 : 1 }]}>
        {busy ? <ActivityIndicator color={theme.primaryForeground} /> : <Text style={[styles.buttonText, { color: theme.primaryForeground }]}>Connect</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  caption: { fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 6, padding: 12, fontSize: 16 },
  button: { borderRadius: 6, padding: 14, alignItems: 'center' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 4, textAlign: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
