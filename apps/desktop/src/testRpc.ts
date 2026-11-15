import { vi } from 'vitest';

/** Serve the hub's `POST /rpc/<cmd>` from `handler` for one test (undo with `vi.unstubAllGlobals()`). */
export function mockRpc(handler: (cmd: string, args: unknown) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      const args: unknown = init?.body === undefined ? {} : JSON.parse(init.body as string);
      const result = handler(cmd, args);
      return new Response(JSON.stringify({ result: result === undefined ? null : result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}
