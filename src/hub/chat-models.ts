// Settings → Doc chat model → "Fetch models": the model ids the saved endpoint or provider offers, read on the hub so
// a provider key (named by `keyEnv`) never reaches the browser.
import { baseUrlRefusal, CHAT_ALLOWED_ORIGINS_ENV } from '../api/complete.js';
import { readEnv } from '../core/env.js';
import { loadCustomProviders } from '../agents/custom.js';
import { CHAT_MODELS, type ChatModelList } from '../wire.js';
import type { AppConfig } from './app-config.js';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_MODELS = 1000;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
/** Operator-local list (comma-separated origins) of keyless proxies the hub may fetch from, e.g. a LAN proxy. */
export const CHAT_LOCAL_ORIGINS_ENV = 'TASKCELL_CHAT_LOCAL_ORIGINS';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

type Source = { kind: 'openrouter' } | { kind: 'endpoint'; baseUrl: string; keyEnv?: string } | { kind: 'static' };

const trimSlash = (u: string): string => u.replace(/\/+$/, '');
const originOf = (u: string): string | undefined => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};

const originList = (list: string | undefined): string[] => (list ?? '').split(',').flatMap((e) => originOf(e.trim()) ?? []);

/** Link-local and cloud-metadata hosts: never fetched, even when listed. */
function isMetadataHost(url: string): boolean {
  const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return /^169\.254\./.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^::ffff:a9fe:/.test(h) || h === 'fd00:ec2::254' || h === 'metadata.google.internal' || h === 'metadata';
}

/**
 * Where the list comes from, from the saved config only (the caller never names a URL or a key): the doc chat's own
 * `chatBaseUrl` first (OpenRouter's origin, or an endpoint whose key is the `keyEnv` of the custom provider saved with
 * the same URL), then the project's `provider` when it is `openrouter` or a custom provider, else the static list.
 */
export async function chatModelSource(repoPath: string, cfg: AppConfig): Promise<Source> {
  const customs = (await loadCustomProviders(repoPath)).flatMap((e) => (e.spec !== undefined ? [e.spec] : []));
  const chat = typeof cfg.chatBaseUrl === 'string' && cfg.chatBaseUrl.trim() !== '' ? cfg.chatBaseUrl.trim() : undefined;
  if (chat !== undefined) {
    if (originOf(chat) === 'https://openrouter.ai') return { kind: 'openrouter' };
    const match = customs.find((c) => trimSlash(c.baseUrl) === trimSlash(chat));
    return { kind: 'endpoint', baseUrl: chat, ...(match?.keyEnv !== undefined ? { keyEnv: match.keyEnv } : {}) };
  }
  if (cfg.provider === 'openrouter') return { kind: 'openrouter' };
  const custom = customs.find((c) => c.name === cfg.provider);
  if (custom !== undefined) return { kind: 'endpoint', baseUrl: custom.baseUrl, ...(custom.keyEnv !== undefined ? { keyEnv: custom.keyEnv } : {}) };
  return { kind: 'static' };
}

/** Model ids from an OpenAI/Anthropic-style `{ data: [{ id }] }` body: well-formed ids only, deduplicated, capped. */
export function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string' && MODEL_ID.test(id));
  return [...new Set(ids)].slice(0, MAX_MODELS);
}

/** Lists the models of the repository's saved chat source. A failure comes back as `error` with no models, never thrown.
 * `withKey: false` (a caller other than the hub owner) asks without the `keyEnv` key. */
export async function listChatModels(repoPath: string, cfg: AppConfig, fetchImpl: typeof fetch = fetch, opts: { withKey?: boolean } = {}): Promise<ChatModelList> {
  const source = await chatModelSource(repoPath, cfg);
  if (source.kind === 'static') return { source: 'static', models: [...CHAT_MODELS] };
  const url = source.kind === 'openrouter' ? OPENROUTER_MODELS : `${trimSlash(source.baseUrl)}/v1/models`;
  const origin = originOf(url);
  if (origin === undefined || !/^https?:$/.test(new URL(url).protocol)) return { source: source.kind, models: [], error: 'the endpoint URL is not an absolute http(s) URL' };
  // A key travels over TLS only: a plain-http endpoint (a keyless LAN proxy such as Meridian) is asked without one.
  const keyEnv = source.kind === 'endpoint' ? source.keyEnv : undefined;
  const plain = new URL(url).protocol !== 'https:';
  const withKey = opts.withKey !== false;
  const key = keyEnv !== undefined && !plain && withKey ? process.env[keyEnv] || undefined : undefined;
  // The endpoint comes from repo content: a hub key goes only to an origin the operator allowed for chat, else no request is made.
  const refused = baseUrlRefusal(url, readEnv(CHAT_ALLOWED_ORIGINS_ENV));
  if (key !== undefined && refused !== undefined) return { source: source.kind, models: [], error: refused.replace('doc chat refused: ', '').replace('your Anthropic credential', `the ${keyEnv} key`) };
  // Even keyless, only a chat-allowed or owner-marked local origin is fetched (no blind SSRF).
  if (source.kind === 'endpoint') {
    const permitted = !isMetadataHost(url) && (refused === undefined || originList(readEnv(CHAT_LOCAL_ORIGINS_ENV)).includes(origin));
    if (!permitted) return { source: source.kind, models: [], error: `chatBaseUrl origin ${origin} is not allowed; add it to ${CHAT_ALLOWED_ORIGINS_ENV} or, for a local keyless proxy, ${CHAT_LOCAL_ORIGINS_ENV} (comma-separated origins) in the hub's environment` };
  }
  // OpenRouter answers an `anthropic-version` request with its small Anthropic-compatible list: ask it plainly.
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(source.kind === 'endpoint' ? { 'anthropic-version': '2023-06-01' } : {}),
    ...(key !== undefined ? { 'x-api-key': key, Authorization: `Bearer ${key}` } : {}),
  };
  const base = { source: source.kind, origin };
  try {
    // No redirects: a redirect would carry the key to wherever the endpoint points.
    const res = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      const unset = keyEnv === undefined || key !== undefined ? '' : !withKey ? ` (${keyEnv} is sent on the hub owner's fetch only)` : plain ? ` (${keyEnv} is sent to https:// endpoints only)` : ` (${keyEnv} is not set on the hub)`;
      return { ...base, models: [], error: `${origin} answered HTTP ${res.status}${unset}` };
    }
    const models = modelIds(await res.json());
    return models.length > 0 ? { ...base, models } : { ...base, models: [], error: `${origin} listed no models` };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ...base, models: [], error: timedOut ? `${origin} did not answer in ${FETCH_TIMEOUT_MS / 1000} s` : `${origin} could not be reached` };
  }
}
