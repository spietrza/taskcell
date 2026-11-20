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
    return { ok: true, credentials: { url, token } };
  } catch (err) {
    return { ok: false, error: `Could not connect to ${url}: ${String(err)}` };
  }
}
