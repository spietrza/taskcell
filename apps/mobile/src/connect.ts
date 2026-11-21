import { createHubClient } from '../../../packages/hub-client/src/client';
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
    return { ok: true, credentials: { url, token, kind: 'owner' } };
  } catch (err) {
    return { ok: false, error: `Could not connect to ${url}: ${String(err)}` };
  }
}

/** True when the hub has server-mode sign-in (its `/sign-in` page exists; a local-mode hub answers 404). */
export async function hubHasSignIn(urlInput: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const url = normalizeHubUrl(urlInput);
  if (!url) return false;
  try {
    return (await (fetchImpl ?? fetch)(`${url}/sign-in`, { method: 'HEAD' })).status === 200;
  } catch {
    return false;
  }
}

export interface DeviceSignIn {
  url: string;
  deviceCode: string;
  /** Shown to the member, who types it on the hub's verification page. */
  userCode: string;
  /** The hub's verification page. It carries no code, session or token. */
  verificationUri: string;
  intervalS: number;
  expiresInS: number;
}

const post = async (url: string, path: string, body: unknown, fetchImpl?: typeof fetch): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await withOrigin(url, fetchImpl)(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
};

/** Step 1 of the device flow: ask the hub for a `device_code` (kept secret in the app) and a `user_code` (shown). */
export async function startDeviceSignIn(urlInput: string, fetchImpl?: typeof fetch): Promise<{ ok: true; flow: DeviceSignIn } | { ok: false; error: string }> {
  const url = normalizeHubUrl(urlInput);
  if (!url) return { ok: false, error: 'Enter the hub URL, e.g. http://192.168.1.20:7777.' };
  try {
    const { status, json } = await post(url, '/api/device/code', {}, fetchImpl);
    const { device_code, user_code, verification_uri, interval, expires_in } = json;
    if (status !== 200 || typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') {
      return { ok: false, error: `${url} did not start a sign-in: ${String(json.error_description ?? status)}` };
    }
    return { ok: true, flow: { url, deviceCode: device_code, userCode: user_code, verificationUri: verification_uri, intervalS: Number(interval) || 5, expiresInS: Number(expires_in) || 600 } };
  } catch (err) {
    return { ok: false, error: `Could not connect to ${url}: ${String(err)}` };
  }
}

export interface PollOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/** Step 2: poll until the member approves in the browser. Resolves the member session, or the hub's reason it was refused. */
export async function pollDeviceSignIn(flow: DeviceSignIn, { fetchImpl, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: PollOptions = {}): Promise<ConnectResult> {
  let intervalMs = flow.intervalS * 1000;
  let waited = 0;
  try {
    while (waited <= flow.expiresInS * 1000) {
      await sleep(intervalMs);
      waited += intervalMs;
      if (signal?.aborted) return { ok: false, error: 'Sign-in cancelled.' };
      const { status, json } = await post(flow.url, '/api/device/token', { device_code: flow.deviceCode }, fetchImpl);
      if (status === 200 && typeof json.access_token === 'string') {
        const token = json.access_token;
        const me = await withOrigin(flow.url, fetchImpl)(`${flow.url}/api/device/me`, { headers: { 'x-vanguard-hub-token': token } });
        const who = (await me.json().catch(() => ({}))) as { name?: unknown };
        return { ok: true, credentials: { url: flow.url, token, kind: 'member', ...(typeof who.name === 'string' ? { name: who.name } : {}) } };
      }
      if (json.error === 'slow_down') intervalMs += 5000;
      else if (json.error !== 'authorization_pending') return { ok: false, error: String(json.error_description ?? json.error ?? `Sign-in failed (${status}).`) };
    }
    return { ok: false, error: 'The code expired. Start sign-in again.' };
  } catch (err) {
    return { ok: false, error: `Could not connect to ${flow.url}: ${String(err)}` };
  }
}

/** Ends a member session on the hub. The owner token is not revoked (it is the hub's own). Best effort: offline still disconnects. */
export async function revokeSession(credentials: Credentials, fetchImpl?: typeof fetch): Promise<void> {
  if (credentials.kind !== 'member') return;
  try {
    await withOrigin(credentials.url, fetchImpl)(`${credentials.url}/api/device/revoke`, { method: 'POST', headers: { 'x-vanguard-hub-token': credentials.token } });
  } catch {
    // The hub is unreachable: the session still expires on its own; the keychain is cleared regardless.
  }
}
