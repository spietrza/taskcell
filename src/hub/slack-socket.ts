// Slack answers: a reply in the thread of a posted question becomes its answer, over Socket Mode (outbound websocket,
// no public endpoint). A mapped Slack user acts as that hub user with a NON-owner caller, through the same dispatchRpc
// call the UI makes (visibility, write gate, audit). Server mode only. See docs/hub.md "Slack".
import { setTimeout as sleep } from 'node:timers/promises';
import type { Caller } from './teams.js';
import { dispatchRpc, type RpcContext } from './rpc.js';
import type { Actor } from './audit.js';
import { redactForPublish } from '../core/secret-scan.js';
import { classifyError } from './command-kit.js';
import { findSlackThread, slackEscape } from './slack.js';

const MAX_ANSWER = 10_000;
const MAX_SEEN = 1000;
const TIMEOUT_MS = 15_000;
const REPLY_TIMEOUT_MS = 120_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export interface SlackAnswerConfig {
  appToken: string;
  botToken: string;
  channel: string;
  /** `U123=<hubUserId>,U456=<hubUserId>` (TASKCELL_SLACK_USERS). */
  users: string | undefined;
  configDir: string;
  /** The hub context; each answer runs with `user` and `actor` set to the mapped user, as handleRequest does. */
  ctx: RpcContext;
  ofRegistration(reg: { userId: string; owner: boolean }): Promise<Caller | undefined>;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  /** First reconnect delay (tests); doubles to 60 s. */
  backoffStartMs?: number;
  /** Longest one reply may hold its thread's queue (tests); 120 s by default. */
  replyTimeoutMs?: number;
}

/** A note for the channel never shows a server path. */
const stripPaths = (s: string): string => s.replace(/\b[A-Za-z]:\\[^\s'"`]+/g, '[path]').replace(/(?<![\w/:])\/[^\s'"`/]+(?:\/[^\s'"`]*)+/g, '[path]');

export function parseSlackUsers(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=');
    const slack = part.slice(0, i).trim();
    const hub = part.slice(i + 1).trim();
    if (i > 0 && slack && hub) map.set(slack, hub);
  }
  return map;
}

interface SlackEvent {
  type?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
  channel?: unknown;
  thread_ts?: unknown;
  ts?: unknown;
  user?: unknown;
  text?: unknown;
}

/** Start the Socket Mode client; `close` stops it for good. Never throws. */
export function startSlackAnswers(cfg: SlackAnswerConfig): { close(): void } {
  const base = cfg.apiUrl ?? 'https://slack.com/api';
  const doFetch = cfg.fetchImpl ?? fetch;
  const WS = cfg.WebSocketImpl ?? globalThis.WebSocket;
  const users = parseSlackUsers(cfg.users);
  const seen = new Set<string>();
  let stopped = false;
  const chains = new Map<string, Promise<void>>(); // per thread, one reply at a time (the next sees the previous answer, unless that one timed out)
  const replyTimeout = cfg.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
  let ws: WebSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  const start = cfg.backoffStartMs ?? BACKOFF_START_MS;
  let delay = start;

  const api = async (method: string, token: string, body?: unknown): Promise<{ ok?: boolean; url?: string }> => {
    const res = await doFetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return ((await res.json().catch(() => undefined)) ?? {}) as { ok?: boolean; url?: string };
  };
  const note = async (channel: string, threadTs: string, text: string): Promise<void> => {
    await api('chat.postMessage', cfg.botToken, { channel, thread_ts: threadTs, text: slackEscape(text), mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false }).catch(() => undefined);
  };

  const handle = async (ev: SlackEvent): Promise<void> => {
    if (ev.type !== 'message' || ev.subtype !== undefined || ev.bot_id !== undefined) return;
    if (ev.channel !== cfg.channel || typeof ev.thread_ts !== 'string' || typeof ev.text !== 'string') return;
    const text = ev.text.trim().slice(0, MAX_ANSWER);
    if (text === '') return;
    const thread = await findSlackThread(cfg.configDir, cfg.channel, ev.thread_ts);
    if (thread === undefined || (thread.kind !== 'issue' && thread.kind !== 'pr' && thread.kind !== 'card')) return;
    const { repoPath, id, kind } = thread;
    const hubUserId = typeof ev.user === 'string' ? users.get(ev.user) : undefined;
    const caller = hubUserId === undefined ? undefined : await cfg.ofRegistration({ userId: hubUserId, owner: false }).catch(() => undefined);
    if (caller === undefined) {
      await note(cfg.channel, ev.thread_ts, 'Your Slack user is not mapped to a hub user, so this reply was not used as an answer.');
      return;
    }
    // Never an owner, whatever the mapping or the user's stored flag: the answer runs with the user's own reach.
    const user = caller.user;
    const actor: Actor = { login: user.email, admin: false, id: user.id, name: user.name };
    try {
      await dispatchRpc({ ...cfg.ctx, user, actor }, 'reply_needs_you', { repoPath, id, kind, body: text }, { ...caller, owner: false });
    } catch (e) {
      // Only a caller-correctable refusal (bad request, forbidden) shows the hub's words; an internal fault stays in the hub.
      const { kind: errKind, message } = classifyError(e);
      await note(cfg.channel, ev.thread_ts, errKind === 'bad-request' ? stripPaths(redactForPublish(message)) : 'the hub could not take this answer');
    }
  };

  const onMessage = (data: unknown): void => {
    let env: { envelope_id?: unknown; type?: unknown; payload?: { event_id?: unknown; event?: SlackEvent } };
    try {
      env = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof env.envelope_id === 'string') ws?.send(JSON.stringify({ envelope_id: env.envelope_id }));
    if (env.type === 'hello') delay = start;
    else if (env.type === 'disconnect') ws?.close();
    else if (env.type === 'events_api' && env.payload?.event !== undefined) {
      const eventId = env.payload.event_id;
      if (typeof eventId === 'string') {
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string);
      }
      const event = env.payload.event;
      const key = typeof event.thread_ts === 'string' ? event.thread_ts : '';
      // A hung reply holds only its own thread, and only until the timeout (a timed-out reply is abandoned, not cancelled).
      const run = async (): Promise<void> => {
        const ac = new AbortController();
        const limit = sleep(replyTimeout, undefined, { signal: ac.signal, ref: false }).catch(() => undefined);
        await Promise.race([handle(event), limit]).finally(() => ac.abort());
      };
      const next = (chains.get(key) ?? Promise.resolve()).then(run).catch(() => undefined);
      chains.set(key, next);
      void next.then(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    }
  };

  const reconnect = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void connect(), delay);
    timer.unref();
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  };
  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      const open = await api('apps.connections.open', cfg.appToken);
      if (open.ok !== true || typeof open.url !== 'string') throw new Error('rejected');
      if (stopped) return;
      const sock = new WS(open.url);
      ws = sock;
      sock.addEventListener('message', (e) => onMessage(e.data));
      sock.addEventListener('close', () => {
        if (ws === sock) reconnect();
      });
      sock.addEventListener('error', () => undefined);
    } catch (e) {
      console.error(`taskcell-hub: slack: socket mode connect failed (${e instanceof Error ? e.name : 'error'})`);
      reconnect();
    }
  };
  void connect();
  return {
    close: () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
