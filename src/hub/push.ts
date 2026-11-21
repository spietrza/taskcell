// Push notifications (mobile app): the Expo push tokens each hub user registered, and the notifier that sends one
// push per token when an item newly enters "Needs you". Tokens and the already-notified set live in the hub config
// dir. The payload is a title ("<kind>: <title>"), the repository and the item's id — never a credential, a token
// or diff text. See docs/hub.md "Push notifications".
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { NeedsYouItem, RepoStamp } from '../wire.js';
import { repoVisibility, type RepoVisibility } from './callers.js';
import type { Caller } from './teams.js';

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export interface PushRegistration {
  token: string;
  platform: PushPlatform;
  /** The registering hub user's id (`token` for the shared hub token in token-only mode). */
  userId: string;
  /** True when the registering caller is the hub owner (sees every repository). */
  owner: boolean;
}

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,100}\]$/;
const MAX_NOTIFIED = 5000;
const CHUNK = 100;

const tokensFile = (configDir: string): string => join(configDir, 'push-tokens.json');
const notifiedFile = (configDir: string): string => join(configDir, 'push-notified.json');

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}

export async function loadPushTokens(configDir: string): Promise<PushRegistration[]> {
  const raw = await readJson(tokensFile(configDir));
  return Array.isArray(raw)
    ? raw.filter((r): r is PushRegistration => typeof r?.token === 'string' && typeof r.userId === 'string' && typeof r.owner === 'boolean' && PUSH_PLATFORMS.includes(r.platform))
    : [];
}

// Serialises read-modify-write of the token file within this process.
let queue: Promise<unknown> = Promise.resolve();
function edit(configDir: string, change: (all: PushRegistration[]) => PushRegistration[]): Promise<void> {
  const run = queue.then(async () => writeJson(tokensFile(configDir), change(await loadPushTokens(configDir))));
  queue = run.catch(() => undefined);
  return run;
}

/** Validate the RPC arguments: an Expo push token (nothing else is stored or sent to) and a known platform. */
export function parsePushToken(token: unknown): string {
  if (typeof token !== 'string' || !EXPO_TOKEN_RE.test(token)) throw new BadRequestError('token must be an Expo push token (ExponentPushToken[...])');
  return token;
}
export function parsePushPlatform(platform: unknown): PushPlatform {
  if (!PUSH_PLATFORMS.includes(platform as PushPlatform)) throw new BadRequestError(`platform must be one of ${PUSH_PLATFORMS.join(', ')}`);
  return platform as PushPlatform;
}

/** Store `reg` for its user; a token already stored (the same phone, a new sign-in) moves to the new owner. */
export const registerPushToken = (configDir: string, reg: PushRegistration): Promise<void> =>
  edit(configDir, (all) => [...all.filter((r) => r.token !== reg.token), reg]);

/** Remove `token` only when `userId` registered it: nobody unregisters another user's device. */
export const unregisterPushToken = (configDir: string, token: string, userId: string): Promise<void> =>
  edit(configDir, (all) => all.filter((r) => !(r.token === token && r.userId === userId)));

const dropTokens = (configDir: string, dead: ReadonlySet<string>): Promise<void> => edit(configDir, (all) => all.filter((r) => !dead.has(r.token)));

/** What the item is, as the Home screens caption it. */
export function pushKind(item: NeedsYouItem): string {
  if (item.reason === 'changes requested') return 'Changes requested';
  if (item.reason.includes('verify-failed')) return 'Verify failed';
  if (item.kind === 'pr') return 'PR ready';
  return item.ask === 'too-vague' ? 'Too vague' : 'Question';
}

const clip = (s: string, max: number): string => {
  const flat = redactForPublish(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export type WaitingItem = NeedsYouItem & Partial<RepoStamp>;

/** The Expo message for one item: kind, title and repository, plus the ids the app opens the item's sheet by. */
export function pushMessage(to: string, item: WaitingItem): Record<string, unknown> {
  return {
    to,
    title: `${pushKind(item)}: ${clip(item.title, 120)}`,
    body: clip(item.repoSlug || item.repoName || '', 120),
    sound: 'default',
    data: { id: item.id, repoName: item.repoName ?? '' },
  };
}

/** One item notifies once: a repository + id + reason that was already sent (even before a restart) does not again. */
const itemKey = (i: WaitingItem): string => `${i.repoPath ?? ''}|${i.id}|${i.reason}`;

export interface NotifierDeps {
  configDir: string;
  /** Every Needs-you item across the hub's repositories (the owner's view). */
  listWaiting: () => Promise<WaitingItem[]>;
  /** The caller a stored registration stands for; undefined when that user is gone. */
  callerOf: (reg: PushRegistration) => Promise<Caller | undefined>;
  fetchImpl?: typeof fetch;
  /** Expo push endpoint; the real one by default. */
  url?: string;
  /** Expo push access token, when the hub is configured with one. */
  accessToken?: string;
}

let running = false;

/**
 * One notifier pass. The first pass on a hub with registered tokens only records what already waits (no flood);
 * after that each new item is recorded BEFORE it is sent, so a crash or restart never sends one twice.
 * Returns the number of pushes sent.
 */
export async function notifyNewItems(deps: NotifierDeps): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const regs = await loadPushTokens(deps.configDir);
    if (regs.length === 0) return 0;
    const items = await deps.listWaiting();
    const stored = await readJson(notifiedFile(deps.configDir));
    const seen: string[] = Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : [];
    const known = new Set(seen);
    const fresh = items.filter((i) => !known.has(itemKey(i)));
    if (fresh.length === 0 && stored !== undefined) return 0;
    await writeJson(notifiedFile(deps.configDir), [...seen, ...fresh.map(itemKey)].slice(-MAX_NOTIFIED));
    if (stored === undefined) return 0;

    const visible = new Map<string, RepoVisibility | undefined>();
    const messages: Record<string, unknown>[] = [];
    for (const reg of regs) {
      if (!visible.has(reg.userId)) {
        const caller = await deps.callerOf(reg);
        visible.set(reg.userId, caller === undefined ? undefined : await repoVisibility(deps.configDir, caller));
      }
      const mine = visible.get(reg.userId);
      for (const item of fresh) {
        if (mine !== undefined && (await mine.hasResolved(item.repoPath ?? ''))) messages.push(pushMessage(reg.token, item));
      }
    }
    return await send(deps, messages);
  } finally {
    running = false;
  }
}

async function send(deps: NotifierDeps, messages: Record<string, unknown>[]): Promise<number> {
  const dead = new Set<string>();
  let sent = 0;
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    try {
      const res = await (deps.fetchImpl ?? fetch)(deps.url ?? EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(deps.accessToken ? { authorization: `Bearer ${deps.accessToken}` } : {}) },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) {
        console.error(`taskcell-hub: push: Expo answered ${res.status}`);
        continue;
      }
      sent += chunk.length;
      const body = (await res.json().catch(() => undefined)) as { data?: { status?: string; details?: { error?: string } }[] } | undefined;
      body?.data?.forEach((t, n) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') dead.add(chunk[n]!.to as string);
      });
    } catch (e) {
      // The message names the failure class only: never the request (it holds tokens) or the access token.
      console.error(`taskcell-hub: push: could not reach Expo (${e instanceof Error ? e.name : 'error'})`);
    }
  }
  if (dead.size > 0) await dropTokens(deps.configDir, dead);
  return sent;
}
