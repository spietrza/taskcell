import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { notifyNewItems, type WaitingItem } from './push.js';
import { slackText, takeSlackConfig } from './slack.js';

const q = (n: number, body: string, extra: Partial<WaitingItem> = {}): WaitingItem => ({
  id: `hub-${n}`, kind: 'card', number: n, repoSlug: 'o/r', title: `T${n}`, url: '', reason: 'asking', ask: 'question', repoPath: '/r', repoName: 'r', lastComment: { author: 'a', body }, ...extra,
});

function fakeSlack(ok = true) {
  const calls: { auth: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls.push({ auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(ok ? { ok: true, ts: '1.2', channel: 'C1' } : { ok: false, error: 'no' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('slack questions', () => {
  test('posts a new question once, escaped, only ask=question, and not again after restart', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'slack-'));
    const s = fakeSlack();
    const items = [q(1, '<!channel> <@U1> <http://x|y> a&b'), q(2, 'vague', { ask: 'too-vague' }), { ...q(4, 'n'), ask: undefined } as unknown as WaitingItem];
    const listWaiting = vi.fn(async () => items);
    const deps = { configDir, listWaiting, callerOf: async () => undefined, slack: { token: 'xoxb-secret', channel: 'C1', fetchImpl: s.fetchImpl } };
    expect(await notifyNewItems(deps)).toBe(0);
    await notifyNewItems(deps);
    expect(listWaiting).toHaveBeenCalledTimes(2);
    expect(s.calls).toHaveLength(1);
    const { body, auth } = s.calls[0]!;
    expect(auth).toBe('Bearer xoxb-secret');
    expect(body).toMatchObject({ channel: 'C1', mrkdwn: false, link_names: false });
    expect(body.text).toContain('&lt;!channel&gt; &lt;@U1&gt; &lt;http://x|y&gt; a&amp;b');
    expect(body.text).not.toContain('<');
    expect(JSON.parse(await readFile(join(configDir, 'slack-threads.json'), 'utf8'))['/r|hub-1|asking']).toEqual({ channel: 'C1', ts: '1.2' });
  });

  test('a rejected call logs one warning without the token and does not throw', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'slack-'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = fakeSlack(false);
    await expect(notifyNewItems({ configDir, listWaiting: async () => [q(1, 'x'), q(2, 'y')], callerOf: async () => undefined, slack: { token: 'xoxb-secret', channel: 'C1', fetchImpl: s.fetchImpl } })).resolves.toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0])).not.toContain('xoxb-secret');
    err.mockRestore();
  });

  test('takeSlackConfig removes the token from env; off when either is missing', () => {
    const env: NodeJS.ProcessEnv = { TASKCELL_SLACK_BOT_TOKEN: 't' };
    expect(takeSlackConfig(env)).toBeUndefined();
    expect(env.TASKCELL_SLACK_BOT_TOKEN).toBeUndefined();
    const both: NodeJS.ProcessEnv = { TASKCELL_SLACK_BOT_TOKEN: 't', TASKCELL_SLACK_CHANNEL: 'C' };
    expect(takeSlackConfig(both)).toEqual({ token: 't', channel: 'C' });
    expect(both.TASKCELL_SLACK_BOT_TOKEN).toBeUndefined();
  });

  test('truncates the question to 3000 characters', () => {
    expect(slackText(q(1, 'a'.repeat(5000))).length).toBeLessThan(3100);
  });
});

describe('hub start', () => {
  test('removes the Slack bot token from process.env and childEnv()', async () => {
    const { createHubServer } = await import('./server.js');
    const { createCredentialService } = await import('./credentials.js');
    const d = await mkdtemp(join(tmpdir(), 'slack-hub-'));
    process.env.TASKCELL_SLACK_BOT_TOKEN = 'xoxb-secret';
    process.env.TASKCELL_SLACK_CHANNEL = 'C1';
    const h = createHubServer({ uiDir: d, configDir: d, browseRoot: d, bind: { isLoopback: true, allowAdd: false }, seedRepoPath: d, deps: {} as never, token: 't'.repeat(64) });
    try {
      expect(process.env.TASKCELL_SLACK_BOT_TOKEN).toBeUndefined();
      expect(createCredentialService(d).childEnv().TASKCELL_SLACK_BOT_TOKEN).toBeUndefined();
      expect(createCredentialService(d).childEnv('claude').TASKCELL_SLACK_BOT_TOKEN).toBeUndefined();
    } finally {
      delete process.env.TASKCELL_SLACK_CHANNEL;
      await h.close();
    }
  });
});
