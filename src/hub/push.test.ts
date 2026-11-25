import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AuditLog } from './audit.js';
import { loadPushTokens, notifyNewItems, type NotifierDeps, type WaitingItem } from './push.js';
import { savePaths } from './projects.js';
import { saveTeams, type Caller } from './teams.js';
import { dispatchRpc, makeCtx, tmpGitRepo } from './test-kit.js';

const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const ann: Caller = { user: { id: 'ann', email: 'ann@x.test', name: 'ann' }, owner: false };
const mia: Caller = { user: { id: 'mia', email: 'mia@x.test', name: 'mia' }, owner: false };

const item = (repoPath: string, n: number, extra: Partial<WaitingItem> = {}): WaitingItem => ({
  id: `o/r#${n}`, kind: 'pr', number: n, repoSlug: 'o/r', title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, reason: 'taskcell:review', repoPath, repoName: 'r', ...extra,
});

async function setup() {
  const repo = await tmpGitRepo();
  const { ctx } = await makeCtx(repo);
  ctx.audit = new AuditLog(ctx.configDir);
  await savePaths(ctx.configDir, [repo]);
  await saveTeams(ctx.configDir, [{ id: 't', name: 'T', members: [{ login: 'ann', role: 'admin' }, { login: 'mia', role: 'member' }], repositories: [repo] }]);
  return { ctx, repo };
}

function fakeExpo() {
  const sent: Record<string, unknown>[] = [];
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    sent.push(...(JSON.parse(String(init.body)) as Record<string, unknown>[]));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, bodies, fetchImpl };
}

describe('push token RPCs', () => {
  test('are stored per user, audited without the token, and a user cannot remove another user\'s token', async () => {
    const { ctx } = await setup();
    await dispatchRpc(ctx, 'register_push_token', { token: T1, platform: 'ios' }, ann);
    await dispatchRpc(ctx, 'register_push_token', { token: T2, platform: 'ios' }, mia);
    expect((await loadPushTokens(ctx.configDir)).map((r) => [r.token, r.userId])).toEqual([[T1, 'ann'], [T2, 'mia']]);
    // mia names ann's token: nothing is removed.
    await dispatchRpc(ctx, 'unregister_push_token', { token: T1 }, mia);
    expect(await loadPushTokens(ctx.configDir)).toHaveLength(2);
    await dispatchRpc(ctx, 'unregister_push_token', { token: T1 }, ann);
    expect((await loadPushTokens(ctx.configDir)).map((r) => r.token)).toEqual([T2]);
    const log = await ctx.audit!.read();
    expect(log.filter((e) => e.action === 'push-register')).toHaveLength(2);
    expect(log.filter((e) => e.action === 'push-unregister')).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain('ExponentPushToken');
  });

  test('a token that is not an Expo push token is refused', async () => {
    const { ctx } = await setup();
    await expect(dispatchRpc(ctx, 'register_push_token', { token: 'https://evil.test', platform: 'ios' }, ann)).rejects.toThrow(/Expo push token/);
    await expect(dispatchRpc(ctx, 'register_push_token', { token: T1, platform: 'web' }, ann)).rejects.toThrow(/platform/);
  });
});

describe('notifyNewItems', () => {

  test('one push per token for a new item, none again after a restart, no secret or diff in the payload', async () => {
    const { ctx, repo } = await setup();
    await dispatchRpc(ctx, 'register_push_token', { token: T1, platform: 'ios' }, ann);
    await dispatchRpc(ctx, 'register_push_token', { token: T2, platform: 'ios' }, mia);
    const expo = fakeExpo();
    let waiting: WaitingItem[] = [item(repo, 1)];
    const deps = (): NotifierDeps => ({
      configDir: ctx.configDir,
      listWaiting: async () => waiting,
      callerOf: async (r) => (r.userId === 'ann' ? ann : mia),
      fetchImpl: expo.fetchImpl,
      url: 'http://expo.test/send',
      accessToken: 'SECRET-ACCESS',
    });
    expect(await notifyNewItems(deps())).toBe(0); // first pass: what already waits is only recorded
    waiting = [item(repo, 1), item(repo, 2, { title: 'Fix token sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', lastComment: { author: 'bot', body: 'diff --git a/x b/x\n+secret' } })];
    expect(await notifyNewItems(deps())).toBe(2);
    expect(expo.sent.map((m) => m.to).sort()).toEqual([T1, T2]);
    expect(expo.sent[0]).toMatchObject({ body: 'o/r', title: expect.stringMatching(/^PR ready: Fix token /) });
    const payload = expo.bodies.join('');
    expect(payload).not.toMatch(/sk-ant|diff --git|\+secret|SECRET-ACCESS/);
    expect(await notifyNewItems(deps())).toBe(0); // same item again: not notified
    expect(await notifyNewItems(deps())).toBe(0); // (a fresh process reads the same files)
    expect(expo.sent).toHaveLength(2);
    expect(await readFile(join(ctx.configDir, 'push-notified.json'), 'utf8')).not.toContain('ExponentPushToken');
  });

  test('a user gets pushes only for repositories of their teams; a dead token is dropped', async () => {
    const { ctx, repo } = await setup();
    const other = await tmpGitRepo();
    await savePaths(ctx.configDir, [repo, other]);
    await dispatchRpc(ctx, 'register_push_token', { token: T1, platform: 'ios' }, ann);
    let waiting: WaitingItem[] = [];
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const msgs = JSON.parse(String(init.body)) as { to: string }[];
      sent.push(...msgs.map((m) => m.to));
      return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = (): NotifierDeps => ({ configDir: ctx.configDir, listWaiting: async () => waiting, callerOf: async () => ann, fetchImpl });
    await notifyNewItems(deps());
    waiting = [item(other, 1)];
    expect(await notifyNewItems(deps())).toBe(0);
    waiting = [item(other, 1), item(repo, 2)];
    expect(await notifyNewItems(deps())).toBe(1);
    expect(sent).toEqual([T1]);
    expect(await loadPushTokens(ctx.configDir)).toEqual([]);
  });
});

describe('a failing push pass', () => {
  test('is logged and does not skip the Slack post for the same items', async () => {
    const { ctx, repo } = await setup();
    await dispatchRpc(ctx, 'register_push_token', { token: T1, platform: 'ios' }, ann);
    const slackPosts: Record<string, unknown>[] = [];
    const slack = {
      token: 't',
      channel: 'C1',
      fetchImpl: (async (_u: string, init: RequestInit) => {
        slackPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: '1.2', channel: 'C1' }), { status: 200 });
      }) as unknown as typeof fetch,
    };
    const callerOf = vi.fn(async (): Promise<Caller | undefined> => { throw new Error('users store unreadable'); });
    const deps = (items: WaitingItem[]): NotifierDeps => ({ configDir: ctx.configDir, listWaiting: async () => items, callerOf, slack });
    // The first pass only records what waits; the second one has a new item and fails while resolving who sees it.
    await notifyNewItems(deps([]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const asking = item(repo, 9, { kind: 'card', reason: 'asking', ask: 'question', lastComment: { author: 'a', body: 'which file?' } });
    await expect(notifyNewItems(deps([asking]))).resolves.toBe(0);
    expect(callerOf).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('push: pass failed'));
    expect(slackPosts).toHaveLength(1);
    error.mockRestore();
  });
});
