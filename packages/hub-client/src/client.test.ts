import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHubClient } from './client.js';
import { encodeError, encodeEvent, encodeResult, HUB_TOKEN_HEADER } from './hub-wire.js';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

// Typecheck-only (never called): `call` is typed from `Commands`.
export const _typed = (c: ReturnType<typeof createHubClient>): void => {
  // @ts-expect-error -- unknown command name
  void c.call('nope', {});
  // @ts-expect-error -- wrong arg shape
  void c.call('read_app_config', { repoPath: 1 });
};

describe('hub client', () => {
  it('POSTs /rpc/<cmd> with the JSON body and token header and returns the result', async () => {
    const fake = vi.fn(async (_url: string, _init?: RequestInit) => json(200, encodeResult({ ok: 1 })));
    const client = createHubClient({ baseUrl: 'http://hub:1', token: () => 'tok', fetch: fake as unknown as typeof fetch });
    await expect(client.call('read_app_config', { repoPath: 'r' })).resolves.toEqual({ ok: 1 });
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('http://hub:1/rpc/read_app_config');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"repoPath":"r"}');
    expect((init?.headers as Record<string, string>)[HUB_TOKEN_HEADER]).toBe('tok');
  });

  it('rejects with the hub error message, and with a string on a network failure', async () => {
    const bad = encodeError({ message: 'nope', kind: 'bad-request' });
    const c1 = createHubClient({ token: 't', fetch: (async () => json(bad.status, bad.body)) as typeof fetch });
    await expect(c1.call('caller_capabilities')).rejects.toBe('nope');
    const c2 = createHubClient({ token: 't', fetch: (async () => { throw new Error('down'); }) as typeof fetch });
    await expect(c2.call('caller_capabilities')).rejects.toBe('down');
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

  const streamOf = (chunks: Uint8Array[], status = 200): Response =>
    new Response(new ReadableStream<Uint8Array>({ start(c) { for (const k of chunks) c.enqueue(k); c.close(); } }), { status });
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const run = async (res: Response): Promise<{ events: unknown[]; sub: { lastEventId: string | undefined } }> => {
    const client = createHubClient({ token: 't', fetch: (async () => res) as typeof fetch });
    const events: unknown[] = [];
    let sub!: { lastEventId: string | undefined };
    await new Promise<void>((resolve) => { sub = client.subscribe({ onEvent: (n, p) => events.push([n, p]), onError: () => resolve() }); });
    return { events, sub };
  };

  it("a CRLF split across two chunks is not a frame boundary", async () => {
    const { events } = await run(streamOf([enc("event: a\r\ndata: 1\r"), enc("\n\r\nevent: b\r\ndata: 2\r\n\r\n")]));
    expect(events).toEqual([["a", 1], ["b", 2]]);
  });

  it("a lone CR split from its LF yields one event", async () => {
    const { events } = await run(streamOf([enc("event: a\ndata: 1\r"), enc("\n\r"), enc("\n")]));
    expect(events).toEqual([["a", 1]]);
  });

  it("cancels the body on a non-2xx response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const client = createHubClient({ token: 't', fetch: (async () => new Response(body, { status: 500 })) as typeof fetch });
    const msg = await new Promise<string>((resolve) => { client.subscribe({ onEvent: () => undefined, onError: resolve }); });
    expect(msg).toContain("500");
    expect(cancel).toHaveBeenCalled();
  });

  it("decodes a multibyte character split across chunks", async () => {
    const bytes = enc("event: a\ndata: \"é€\"\n\n");
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
    const { events } = await run(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(events).toEqual([["a", "é€"]]);
  });

  it("exposes the last event id", async () => {
    const { sub } = await run(streamOf([enc("id: 4\nevent: a\ndata: 1\n\nid: 7\nevent: a\ndata: 2\n\n")]));
    expect(sub.lastEventId).toBe("7");
  });

  it('imports nothing from the DOM or Tauri and uses no window/document', () => {
    for (const f of ['client.ts', 'hub-wire.ts', 'wire.ts', 'index.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src).not.toMatch(/react-dom|@tauri-apps/);
      expect(src.replace(/'<script>[^']*<\/script>'/g, '')).not.toMatch(/\b(window|document)\b/);
    }
  });
});
