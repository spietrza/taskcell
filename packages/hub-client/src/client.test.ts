import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHubClient } from './client.js';
import { encodeError, encodeEvent, encodeResult, HUB_TOKEN_HEADER } from './hub-wire.js';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

describe('hub client', () => {
  it('POSTs /rpc/<cmd> with the JSON body and token header and returns the result', async () => {
    const fake = vi.fn(async (_url: string, _init?: RequestInit) => json(200, encodeResult({ ok: 1 })));
    const client = createHubClient({ baseUrl: 'http://hub:1', token: () => 'tok', fetch: fake as unknown as typeof fetch });
    await expect(client.call('listRuns', { a: 1 })).resolves.toEqual({ ok: 1 });
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('http://hub:1/rpc/listRuns');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    expect((init?.headers as Record<string, string>)[HUB_TOKEN_HEADER]).toBe('tok');
  });

  it('rejects with the hub error message, and with a string on a network failure', async () => {
    const bad = encodeError({ message: 'nope', kind: 'bad-request' });
    const c1 = createHubClient({ token: 't', fetch: (async () => json(bad.status, bad.body)) as typeof fetch });
    await expect(c1.call('x')).rejects.toBe('nope');
    const c2 = createHubClient({ token: 't', fetch: (async () => { throw new Error('down'); }) as typeof fetch });
    await expect(c2.call('x')).rejects.toBe('down');
  });

  it('streams /events with the token header and decodes events and resets', async () => {
    const fake = vi.fn(async (_url: string, _init?: RequestInit) => new Response(encodeEvent(1, 'run-update', { id: 'r' }) + encodeEvent(undefined, 'stream-reset', null)));
    const client = createHubClient({ baseUrl: 'http://hub:1', token: 'tok', fetch: fake as unknown as typeof fetch });
    const events: unknown[] = [];
    const reset = vi.fn();
    await new Promise<void>((resolve) => {
      client.subscribe({ onEvent: (n, p) => events.push([n, p]), onReset: reset, onError: () => resolve() });
    });
    expect(fake.mock.calls[0]![0]).toBe('http://hub:1/events');
    expect((fake.mock.calls[0]![1]?.headers as Record<string, string>)[HUB_TOKEN_HEADER]).toBe('tok');
    expect(events).toEqual([['run-update', { id: 'r' }]]);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('imports nothing from the DOM or Tauri and uses no window/document', () => {
    for (const f of ['client.ts', 'hub-wire.ts', 'wire.ts', 'index.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src).not.toMatch(/react-dom|@tauri-apps/);
      expect(src.replace(/'<script>[^']*<\/script>'/g, '')).not.toMatch(/\b(window|document)\b/);
    }
  });
});
