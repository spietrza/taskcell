// The hub RPC client shared by the desktop UI and the mobile app: `POST /rpc/<cmd>` and the `/events`
// SSE stream over `fetch`, against a configurable base URL and hub token. Runs in React Native, so it
// imports nothing from the DOM, Tauri or Node and touches no `window`/`document`.
import { decodeEvent, decodeResponse, HUB_TOKEN_HEADER, STREAM_RESET_EVENT } from './hub-wire.js';

export interface HubClientOptions {
  /** Origin of the hub, e.g. `http://127.0.0.1:4317`; '' (default) is same-origin. No trailing slash. */
  baseUrl?: string;
  /** The hub token, or a function read on every request (a page that may swap it). */
  token: string | (() => string);
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface HubResponse {
  status: number;
  body: unknown;
}

export interface HubStreamHandlers {
  /** One named event with its decoded payload. */
  onEvent: (name: string, payload: unknown) => void;
  /** `stream-reset`: a reconnect gap the hub could not replay — re-fetch snapshots. */
  onReset?: () => void;
  /** The stream failed (non-2xx status or a network error); it is not retried. */
  onError?: (message: string) => void;
}

export interface HubClient {
  /** POST `/rpc/<cmd>`; resolves the raw status and parsed body. Rejects with a string on a network failure. */
  request(cmd: string, args?: Record<string, unknown>): Promise<HubResponse>;
  /** `request` + `decodeResponse`: resolves the result, rejects with the hub's error message string. */
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Stream `/events` (token sent as a header). Returns a function that closes it. */
  subscribe(handlers: HubStreamHandlers): () => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createHubClient(options: HubClientOptions): HubClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch = (input: string, init: RequestInit): Promise<Response> => (options.fetch ?? fetch)(input, init);
  const token = (): string => (typeof options.token === 'function' ? options.token() : options.token);

  async function request(cmd: string, args?: Record<string, unknown>): Promise<HubResponse> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/rpc/${cmd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HUB_TOKEN_HEADER]: token() },
        body: JSON.stringify(args ?? {}),
      });
    } catch (err) {
      // Network failure (server unreachable, CORS, etc.) — reject with a string, as a hub error does.
      throw message(err);
    }
    try {
      return { status: response.status, body: await response.json() };
    } catch (err) {
      throw message(err);
    }
  }

  async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { status, body } = await request(cmd, args);
    return decodeResponse<T>(status, body);
  }

  function subscribe(handlers: HubStreamHandlers): () => void {
    const abort = new AbortController();
    const dispatch = (frame: string): void => {
      let name = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length === 0 && name !== STREAM_RESET_EVENT) return; // a comment / keep-alive frame
      const decoded = decodeEvent(name, data.join('\n'));
      if (decoded.reset) handlers.onReset?.();
      else handlers.onEvent(name, decoded.payload);
    };
    void (async () => {
      try {
        const response = await doFetch(`${baseUrl}/events`, { method: 'GET', headers: { [HUB_TOKEN_HEADER]: token(), accept: 'text/event-stream' }, signal: abort.signal });
        if (!response.ok || !response.body) return handlers.onError?.(`request failed with status ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
          let end = buffer.indexOf('\n\n');
          while (end !== -1) {
            dispatch(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
          }
        }
        handlers.onError?.('event stream closed');
      } catch (err) {
        if (!abort.signal.aborted) handlers.onError?.(message(err));
      }
    })();
    return () => abort.abort();
  }

  return { request, call, subscribe };
}
