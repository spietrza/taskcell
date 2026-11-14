import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { writeAppConfig } from '../app-config.js';
import type { ChildProcess } from 'node:child_process';
import { FakeChild, dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

describe('complete', () => {
  test('T-61 api_complete strips a client baseUrl, substitutes chatBaseUrl, and forces assetRoot', async () => {
    const repo = await tmpRepo();
    await writeAppConfig(repo, { chatBaseUrl: 'https://proxy.internal' });
    const fake = new FakeChild();
    let sent = '';
    fake.stdin.on('data', (c: Buffer) => {
      sent += c.toString('utf8');
    });
    const { ctx } = await makeCtx(repo, { spawnComplete: () => fake as unknown as ChildProcess });
    const promise = dispatchRpc(ctx, 'api_complete', {
      repoPath: repo,
      req: { messages: [], model: 'm', baseUrl: 'https://attacker.example', assetRoot: '/' },
    });
    await vi.waitFor(() => expect(fake.stdin.writableEnded).toBe(true));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const payload = JSON.parse(sent.trim()) as Record<string, unknown>;
    expect(payload.baseUrl).toBe('https://proxy.internal');
    expect(payload.assetRoot).toBe(join(repo, '.taskcell', 'drafts'));
  });

  test('T-62 api_complete forwards only the CompleteParams allowlist fields', async () => {
    const repo = await tmpRepo();
    const fake = new FakeChild();
    let sent = '';
    fake.stdin.on('data', (c: Buffer) => {
      sent += c.toString('utf8');
    });
    const { ctx } = await makeCtx(repo, { spawnComplete: () => fake as unknown as ChildProcess });
    const promise = dispatchRpc(ctx, 'api_complete', {
      repoPath: repo,
      req: { messages: [{ role: 'user', content: 'hi' }], model: 'm', system: 's', attachments: ['a'], evilExtra: 'drop me' },
    });
    await vi.waitFor(() => expect(fake.stdin.writableEnded).toBe(true));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const payload = JSON.parse(sent.trim()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('evilExtra');
    expect(payload.system).toBe('s');
    expect(payload.attachments).toEqual(['a']);
  });
});
