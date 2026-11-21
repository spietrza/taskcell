import { createHubClient } from '../../../packages/hub-client/src/client';
import { HUB_TOKEN_HEADER } from '../../../packages/hub-client/src/hub-wire';
import type { Credentials } from './credentials';

/** `host:port` or a full URL → the hub's origin, no trailing slash; null when it is not an http(s) URL. */
export function normalizeHubUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The client for these credentials: the owner token goes in the hub's token header; a signed-in member's
 * bearer session goes in `Authorization` (and no token header, which the hub would read as a wrong token). */
export function hubFetch(c: Credentials, base?: typeof fetch): typeof fetch {
  const origin = withOrigin(c.url, base);
  if (c.user === undefined) return origin;
  return ((input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete(HUB_TOKEN_HEADER);
    headers.set('authorization', `Bearer ${c.token}`);
    return origin(input, { ...init, headers });
  }) as typeof fetch;
}

export const hubClient = (c: Credentials, fetchImpl?: typeof fetch): ReturnType<typeof createHubClient> =>
  createHubClient({ baseUrl: c.url, token: c.user === undefined ? c.token : '', fetch: hubFetch(c, fetchImpl) });

export type ConnectResult = { ok: true; credentials: Credentials } | { ok: false; error: string };

/** The hub rejects a POST without an Origin matching its Host (a browser sends one; React Native's fetch
 * does not), so send the hub's own origin — the same-origin value a browser page served by it would send. */
export const withOrigin = (origin: string, base: typeof fetch = fetch): typeof fetch =>
  ((input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    return base(input, { ...init, headers });
  }) as typeof fetch;

/** True for plain `http://` to a host other than loopback: the owner token would cross the network in cleartext. */
export function isCleartext(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' && !(hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname));
  } catch {
    return false;
  }
}

/** Check a hub URL and token with one read call (`list_projects`) through the shared hub client. */
export async function connectToHub(urlInput: string, tokenInput: string, fetchImpl?: typeof fetch): Promise<ConnectResult> {
  const url = normalizeHubUrl(urlInput);
  if (!url) return { ok: false, error: 'Enter the hub URL, e.g. http://192.168.1.20:7777.' };
  const token = tokenInput.trim();
  if (!token) return { ok: false, error: 'Enter the hub token that taskcell hub prints.' };
  const client = createHubClient({ baseUrl: url, token, fetch: withOrigin(url, fetchImpl) });
  try {
    await client.call('list_projects');
    return { ok: true, credentials: { url, token } };
  } catch (err) {
    return { ok: false, error: `Could not connect to ${url}: ${String(err)}` };
  }
}

export type AuthProvider = 'github' | 'gitlab' | 'google';
export const PROVIDER_LABELS: Record<AuthProvider, string> = { github: 'GitHub', gitlab: 'GitLab', google: 'Google' };
export const NATIVE_REDIRECT = 'taskcell://auth';

/** The sign-in providers a server-mode hub offers; none for a hub without sign-in (or one that cannot be read). */
export async function fetchProviders(urlInput: string, fetchImpl?: typeof fetch): Promise<AuthProvider[]> {
  const url = normalizeHubUrl(urlInput);
  if (!url) return [];
  try {
    const res = await withOrigin(url, fetchImpl)(`${url}/api/auth/native/providers`);
    if (res.status !== 200) return [];
    const { providers } = (await res.json()) as { providers?: unknown };
    return Array.isArray(providers) ? providers.filter((p): p is AuthProvider => p in PROVIDER_LABELS) : [];
  } catch {
    return [];
  }
}

/** Opens the system browser on `url` until it redirects to `redirect` (expo-web-browser's `openAuthSessionAsync`). */
export type OpenAuth = (url: string, redirect: string) => Promise<{ type: string; url?: string }>;

/** Sign in through the hub's own Better Auth flow: the system browser runs the provider's OAuth and ends on
 * `taskcell://auth?ott=…`; that one-time token buys a bearer session, which is what the app keeps. */
export async function signInToHub(urlInput: string, provider: AuthProvider, openAuth: OpenAuth, fetchImpl?: typeof fetch): Promise<ConnectResult> {
  const url = normalizeHubUrl(urlInput);
  if (!url) return { ok: false, error: 'Enter the hub URL, e.g. http://192.168.1.20:7777.' };
  const hubCall = withOrigin(url, fetchImpl);
  try {
    const result = await openAuth(`${url}/api/auth/native/start?provider=${provider}`, NATIVE_REDIRECT);
    if (result.type !== 'success' || !result.url) return { ok: false, error: 'Sign-in was cancelled.' };
    const params = new URL(result.url).searchParams;
    const error = params.get('error');
    if (error) return { ok: false, error };
    const ott = params.get('ott');
    if (!ott) return { ok: false, error: 'Sign-in did not complete. Try again.' };
    const verify = await hubCall(`${url}/api/auth/one-time-token/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ott }) });
    const token = verify.headers.get('set-auth-token');
    if (!token) return { ok: false, error: 'The hub did not accept the sign-in. Try again.' };
    const session = await hubFetch({ url, token, user: '' }, fetchImpl)(`${url}/api/auth/get-session`);
    const me = (await session.json()) as { user?: { name?: string; email?: string } } | null;
    const user = me?.user?.name || me?.user?.email;
    if (!user) return { ok: false, error: 'The hub did not accept the sign-in. Try again.' };
    return { ok: true, credentials: { url, token, user } };
  } catch (err) {
    return { ok: false, error: `Could not sign in to ${url}: ${String(err)}` };
  }
}

/** Revoke a signed-in member's session on the hub. Best effort: an unreachable hub must not trap the user in the app. */
export async function signOutOfHub(c: Credentials, fetchImpl?: typeof fetch): Promise<void> {
  if (c.user === undefined) return;
  await hubFetch(c, fetchImpl)(`${c.url}/api/auth/sign-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
}
