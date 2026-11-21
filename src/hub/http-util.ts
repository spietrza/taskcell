// Request helpers shared by the hub's route modules (server.ts, device-auth.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { encodeError } from '../hub-wire.js';
import { writeJson } from './json-response.js';

export function methodNotAllowed(res: ServerResponse, allow: string): void {
  const encoded = encodeError({ message: 'method not allowed', kind: 'bad-request' }, 405);
  writeJson(res, encoded.status, encoded.body, { allow });
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Same-origin check for mutating routes: the Origin header is required — every browser sends it on
 * a POST, and a script can send one itself, and so does the one non-browser RPC client, the
 * mobile app (apps/mobile `withOrigin`, which sends the hub's own origin: React Native's fetch sends none) — and must match
 * the request's own Host, or the request is cross-origin. Do not tighten this (e.g. to browser-only Origins) without
 * updating the phone app. This
 * guards against cross-site requests by host, not by scheme, so an HTTPS reverse proxy in front of
 * the hub (the VPS deployment) works with no extra configuration: the browser's `https://` Origin
 * still matches the `Host` header the hub sees, provided the proxy preserves the public Host. */
export function sameOriginOk(req: IncomingMessage): boolean {
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined) return false;
  const host = req.headers.host;
  if (host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

export class BodyTooLargeError extends Error {}

/**
 * Reads the full body before deciding, even once over `maxBytes` (dropping further chunks rather
 * than buffering them): destroying the socket mid-upload would race the client's own write and can
 * surface as a connection-reset instead of the 413 response. Draining to `end` lets the 413 (or any
 * other response) always reach the client cleanly.
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(new BodyTooLargeError('request body too large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
