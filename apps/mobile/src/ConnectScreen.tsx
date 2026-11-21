import { useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { connectToHub, fetchProviders, isCleartext, normalizeHubUrl, PROVIDER_LABELS, signInToHub, type AuthProvider, type OpenAuth } from './connect';
import { useSession } from './session';
import { useTheme } from './useTheme';

const systemBrowser: OpenAuth = (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect);

export function ConnectScreen({ fetchImpl, openAuth = systemBrowser }: { fetchImpl?: typeof fetch; openAuth?: OpenAuth }): ReactNode {
  const theme = useTheme();
  const { connect } = useSession();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<AuthProvider[]>([]);

  // A server-mode hub reports its sign-in providers; one without sign-in reports none and keeps the token form only.
  const lookUpProviders = async (): Promise<void> => setProviders(await fetchProviders(url, fetchImpl));

  const submit = async (provider?: AuthProvider): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = provider ? await signInToHub(url, provider, openAuth, fetchImpl) : await connectToHub(url, token, fetchImpl);
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
      <Text style={[styles.caption, { color: theme.caption }]}>Run taskcell hub and enter its URL and token, or sign in</Text>
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
        onChangeText={(v) => {
          setUrl(v);
          setProviders([]);
        }}
        onBlur={() => void lookUpProviders()}
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
      {providers.map((p) => (
        <Pressable key={p} accessibilityRole="button" disabled={busy} onPress={() => void submit(p)} style={[styles.button, { backgroundColor: theme.primary, opacity: busy ? 0.6 : 1 }]}>
          <Text style={[styles.buttonText, { color: theme.primaryForeground }]}>Sign in with {PROVIDER_LABELS[p]}</Text>
        </Pressable>
      ))}
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
  buttonText: { fontSize: 16, fontWeight: '600' },
});
