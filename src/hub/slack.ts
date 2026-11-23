// Slack notifier (outbound only): posts each new agent question to one channel with chat.postMessage. The bot token
// is read once at hub start and removed from process.env (takeSlackConfig), so no child process inherits it; it is
// never logged. Posted keys and Slack's message ts live in <config dir>/slack-threads.json. See docs/hub.md "Slack".
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactForPublish } from '../core/secret-scan.js';
import { readEnv } from '../core/env.js';
import type { WaitingItem } from './push.js';

export interface SlackConfig {
  token: string;
  channel: string;
  /** The hub's public origin, for the link in each message. */
  hubUrl?: string;
  /** Slack API base; the real one by default. */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SlackThread {
  channel: string;
  ts: string;
}

const MAX_THREADS = 5000;
const MAX_TEXT = 3000;
const TIMEOUT_MS = 15_000;
const threadsFile = (configDir: string): string => join(configDir, 'slack-threads.json');

/** Both values, read once and then removed from `env`; undefined (feature off) when either is missing. */
export function takeSlackConfig(env: NodeJS.ProcessEnv = process.env): Pick<SlackConfig, 'token' | 'channel'> | undefined {
  // The token never had a VANGUARD_ name: read only the new one, and drop a stray legacy copy so no child inherits it.
  const token = env.TASKCELL_SLACK_BOT_TOKEN?.trim();
  const channel = readEnv('TASKCELL_SLACK_CHANNEL', env)?.trim();
  delete env.TASKCELL_SLACK_BOT_TOKEN;
  delete env.VANGUARD_SLACK_BOT_TOKEN;
  return token && channel ? { token, channel } : undefined;
}

/** Slack's control-character escapes: nothing else makes `<...>` a mention or link. */
export const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const itemKey = (i: WaitingItem): string => `${i.repoPath ?? ''}|${i.id}|${i.reason}`;

async function loadThreads(configDir: string): Promise<Record<string, SlackThread>> {
  try {
    const raw: unknown = JSON.parse(await readFile(threadsFile(configDir), 'utf8'));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, SlackThread>) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return {};
    throw e;
  }
}

async function saveThreads(configDir: string, threads: Record<string, SlackThread>): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const tmp = `${threadsFile(configDir)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(threads), { mode: 0o600 });
  await rename(tmp, threadsFile(configDir));
}

export function slackText(item: WaitingItem, hubUrl?: string): string {
  const body = redactForPublish(item.lastComment?.body ?? '').trim();
  const question = body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT - 1)}…` : body;
  const project = item.repoSlug || item.repoName || '';
  const lines = [`${project}: ${item.title}`, question, hubUrl ? `${hubUrl.replace(/\/+$/, '')}/` : ''];
  return slackEscape(lines.filter((l) => l !== '').join('\n'));
}

let running = false;

/**
 * Post each `ask: 'question'` item not posted before. The key is stored BEFORE the post (a crash never posts twice);
 * a rejected call logs one warning (the failure class only) and is swallowed. Never throws.
 */
export async function postQuestions(configDir: string, items: WaitingItem[], cfg: SlackConfig): Promise<void> {
  if (running) return;
  running = true;
  try {
    const threads = await loadThreads(configDir);
    const fresh = items.filter((i) => i.ask === 'question' && !(itemKey(i) in threads));
    let failed = 0;
    for (const item of fresh) {
      const key = itemKey(item);
      threads[key] = { channel: cfg.channel, ts: '' };
      const entries = Object.entries(threads);
      for (const [k] of entries.slice(0, Math.max(0, entries.length - MAX_THREADS))) delete threads[k];
      await saveThreads(configDir, threads);
      try {
        const res = await (cfg.fetchImpl ?? fetch)(`${cfg.apiUrl ?? 'https://slack.com/api'}/chat.postMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify({ channel: cfg.channel, text: slackText(item, cfg.hubUrl), mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const out = (await res.json().catch(() => undefined)) as { ok?: boolean; ts?: string; channel?: string } | undefined;
        if (!res.ok || out?.ok !== true || typeof out.ts !== 'string') throw new Error('rejected');
        threads[key] = { channel: typeof out.channel === 'string' ? out.channel : cfg.channel, ts: out.ts };
        await saveThreads(configDir, threads);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) console.error(`taskcell-hub: slack: ${failed} question post(s) failed`);
  } catch (e) {
    console.error(`taskcell-hub: slack: ${e instanceof Error ? e.name : 'error'}`);
  } finally {
    running = false;
  }
}
