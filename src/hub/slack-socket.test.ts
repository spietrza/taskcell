import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCredentialService } from './credentials.js';
import { startSlackAnswers } from './slack-socket.js';
import { takeSlackAppToken } from './slack.js';
import type { RpcContext } from './rpc.js';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('./rpc.js', () => ({ dispatchRpc: dispatch }));

class FakeWS {
  static all: FakeWS[] = [];
  sent: string[] = [];
  closed = false;
  private l: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  addEventListener(t: string, f: (e: { data?: unknown }) => void): void {
    (this.l[t] ??= []).push(f);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.l.close?.forEach((f) => f({}));
  }
  push(o: unknown): void {
    this.l.message?.forEach((f) => f({ data: JSON.stringify(o) }));
  }
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ev = (extra: Record<string, unknown> = {}, id = 'Ev1'): unknown => ({
  envelope_id: `e-${id}`, type: 'events_api', payload: { event_id: id, event: { type: 'message', channel: 'C1', thread_ts: '1.2', user: 'U1', text: 'yes', ts: '1.3', ...extra } },
});

let posts: { method: string; body: Record<string, unknown> }[];
let configDir: string;
const fetchImpl = (async (url: string, init: RequestInit) => {
  const method = url.split('/').pop()!;
  posts.push({ method, body: init.body ? JSON.parse(String(init.body)) : {} });
  return new Response(JSON.stringify({ ok: true, url: 'wss://fake' }), { status: 200 });
}) as unknown as typeof fetch;
const notes = (): string[] => posts.filter((p) => p.method === 'chat.postMessage').map((p) => String(p.body.text));
const user = { id: 'h1', email: 'a@b.c', name: 'A' };

const start = (over: Record<string, unknown> = {}): { close(): void } =>
  startSlackAnswers({
    appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C1', users: 'U1=h1', configDir, ctx: {} as RpcContext,
    ofRegistration: async (r) => (r.userId === 'h1' ? { user, owner: false } : undefined),
    fetchImpl, WebSocketImpl: FakeWS as unknown as typeof WebSocket, backoffStartMs: 5, ...over,
  });

beforeEach(async () => {
  FakeWS.all = [];
  posts = [];
  dispatch.mockReset();
  dispatch.mockResolvedValue(null);
  configDir = await mkdtemp(join(tmpdir(), 'slack-sock-'));
  await writeFile(join(configDir, 'slack-threads.json'), JSON.stringify({ '/r|hub-1|asking': { channel: 'C1', ts: '1.2', kind: 'card' } }));
});
afterEach(() => vi.restoreAllMocks());

describe('slack answers', () => {
  test('a mapped user\'s reply dispatches reply_needs_you with a non-owner caller', async () => {
    const h = start();
    await tick();
    FakeWS.all[0]!.push(ev());
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [ctx, cmd, args, caller] = dispatch.mock.calls[0]!;
    expect(cmd).toBe('reply_needs_you');
    expect(args).toEqual({ repoPath: '/r', id: 'hub-1', kind: 'card', body: 'yes' });
    expect(caller).toEqual({ user, owner: false });
    expect(ctx.actor).toMatchObject({ id: 'h1', admin: false });
    expect(notes()).toEqual([]);
    h.close();
  });

  test('unmapped user: no answer, one note', async () => {
    const h = start();
    await tick();
    FakeWS.all[0]!.push(ev({ user: 'U9' }));
    await tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(1);
    h.close();
  });

  test('a gone hub user counts as unmapped', async () => {
    const h = start({ ofRegistration: async () => undefined });
    await tick();
    FakeWS.all[0]!.push(ev());
    await tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(1);
    h.close();
  });

  test.each(['repository is not visible to you', 'this hub does not accept writes', 'hub-1 is not waiting for an answer'])('a refusal (%s) becomes one thread note', async (msg) => {
    dispatch.mockRejectedValue(new Error(msg));
    const h = start();
    await tick();
    FakeWS.all[0]!.push(ev());
    await tick();
    expect(notes()).toEqual([msg]);
    expect(posts.find((p) => p.method === 'chat.postMessage')!.body).toMatchObject({ channel: 'C1', thread_ts: '1.2' });
    h.close();
  });

  test('a second reply after the item was answered gets the refusal and answers nothing more', async () => {
    dispatch.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('already answered'));
    const h = start();
    await tick();
    FakeWS.all[0]!.push(ev({}, 'A'));
    FakeWS.all[0]!.push(ev({ text: 'again' }, 'B'));
    await tick();
    expect(notes()).toEqual(['already answered']);
    h.close();
  });

  test.each([
    ['bot message', { bot_id: 'B1' }],
    ['edit', { subtype: 'message_changed' }],
    ['delete', { subtype: 'message_deleted' }],
    ['other channel', { channel: 'C2' }],
    ['non-thread', { thread_ts: undefined }],
    ['unknown thread', { thread_ts: '9.9' }],
    ['empty text', { text: '  ' }],
  ])('ignores %s', async (_n, extra) => {
    const h = start();
    await tick();
    FakeWS.all[0]!.push(ev(extra));
    await tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(notes()).toEqual([]);
    h.close();
  });

  test('caps the answer at 10000 characters', async () => {
    const h = start();
    await tick();
    FakeWS.all[0]!.push(ev({ text: 'x'.repeat(20000) }));
    await tick();
    expect(dispatch.mock.calls[0]![2].body).toHaveLength(10000);
    h.close();
  });

  test('acks envelopes, ignores duplicate event_ids, reconnects after a disconnect', async () => {
    const h = start();
    await tick();
    const first = FakeWS.all[0]!;
    first.push(ev({}, 'D'));
    first.push(ev({}, 'D'));
    await tick();
    expect(first.sent).toEqual([JSON.stringify({ envelope_id: 'e-D' }), JSON.stringify({ envelope_id: 'e-D' })]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    first.push({ type: 'disconnect', reason: 'refresh_requested' });
    await tick(60);
    expect(first.closed).toBe(true);
    expect(FakeWS.all).toHaveLength(2);
    expect(posts.filter((p) => p.method === 'apps.connections.open')).toHaveLength(2);
    h.close();
  });
});

describe('app token', () => {
  test('is removed from process.env and childEnv()', () => {
    process.env.TASKCELL_SLACK_APP_TOKEN = 'xapp-secret';
    expect(takeSlackAppToken()).toBe('xapp-secret');
    expect(process.env.TASKCELL_SLACK_APP_TOKEN).toBeUndefined();
    expect(JSON.stringify(createCredentialService(configDir, [], 'secret').childEnv())).not.toContain('xapp-secret');
  });
});
