import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { DeviceAuth, handleDevice, type DeviceRouteAuth } from './device-auth.js';
import type { HubIdentity, HubUser } from './auth.js';
import type { RpcContext } from './rpc.js';

const BASE = 'https://hub.example.com';
const USER: HubUser = { id: 'u1', email: 'u1@example.com', name: 'Una' };

interface Reply {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function setup(now: () => number = Date.now, signedIn: HubUser | null = USER) {
  const auth: DeviceRouteAuth = { device: new DeviceAuth(now), trustProxy: false };
  const identity = {
    baseURL: BASE,
    sessionUser: async () => signedIn ?? undefined,
    userById: async (id: string) => (id === USER.id ? USER : undefined),
    issueDeviceSession: async (id: string) => `tcd_${id}`,
  } as unknown as HubIdentity;
  const call = async (method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const req = Object.assign(Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body)]), {
      method,
      headers: { host: 'hub.example.com', ...(method === 'POST' ? { origin: BASE } : {}), ...opts.headers },
      socket: { remoteAddress: '203.0.113.9' },
    }) as unknown as IncomingMessage;
    const reply: Reply = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status: number, headers: Record<string, unknown> = {}) {
        reply.status = status;
        reply.headers = headers;
        return res;
      },
      end(chunk?: string) {
        reply.body += chunk ?? '';
      },
    } as unknown as ServerResponse;
    await handleDevice({} as RpcContext, auth, identity, req, res, path, BASE, undefined);
    return reply;
  };
  const issue = async (): Promise<{ device_code: string; user_code: string }> =>
    JSON.parse((await call('POST', '/api/device/code')).body) as { device_code: string; user_code: string };
  const csrf = async (): Promise<string> => /taskcell_device_csrf=(\w+)/.exec(String((await call('GET', '/device')).headers['set-cookie']))![1]!;
  const form = (fields: Record<string, string>, token: string, cookie = token): { body: string; headers: Record<string, string> } => ({
    body: new URLSearchParams({ csrf: token, ...fields }).toString(),
    headers: { cookie: `taskcell_device_csrf=${cookie}` },
  });
  const poll = async (device_code: string): Promise<Reply> => call('POST', '/api/device/token', { body: JSON.stringify({ device_code }) });
  return { call, issue, csrf, form, poll };
}

describe('device sign-in routes', () => {
  test('code issue returns codes and the verification uri', async () => {
    const { call } = setup();
    const r = await call('POST', '/api/device/code');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body).toMatchObject({ verification_uri: `${BASE}/device`, interval: 5 });
    expect(typeof body.device_code).toBe('string');
    expect(typeof body.user_code).toBe('string');
  });

  test('the /device page sets a Secure CSRF cookie; signed-out users go to sign-in', async () => {
    expect(String((await setup().call('GET', '/device')).headers['set-cookie'])).toMatch(/Path=\/device; HttpOnly; SameSite=Strict; Secure/);
    const out = await setup(Date.now, null).call('GET', '/device');
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe('/sign-in?next=device');
  });

  test('approve with CSRF: the poll then yields a session', async () => {
    const t = setup();
    const c = await t.issue();
    const token = await t.csrf();
    const review = await t.call('POST', '/device', t.form({ user_code: c.user_code, action: 'review' }, token));
    expect(review.status).toBe(200);
    expect(review.body).toContain('Approve');
    const done = await t.call('POST', '/device', t.form({ user_code: c.user_code, action: 'approve' }, token));
    expect(done.status).toBe(200);
    expect(done.body).toContain('Approved');
    const polled = await t.poll(c.device_code);
    expect(polled.status).toBe(200);
    expect(JSON.parse(polled.body)).toEqual({ access_token: 'tcd_u1', token_type: 'session' });
  });

  test('deny: the poll gets access_denied', async () => {
    const t = setup();
    const c = await t.issue();
    const token = await t.csrf();
    const done = await t.call('POST', '/device', t.form({ user_code: c.user_code, action: 'deny' }, token));
    expect(done.body).toContain('Denied');
    const polled = await t.poll(c.device_code);
    expect(polled.status).toBe(400);
    expect(JSON.parse(polled.body).error).toBe('access_denied');
  });

  test('a wrong or missing CSRF token is rejected and nothing is approved', async () => {
    const t = setup();
    const c = await t.issue();
    const token = await t.csrf();
    const wrong = await t.call('POST', '/device', t.form({ user_code: c.user_code, action: 'approve' }, token, 'other'));
    expect(wrong.status).toBe(403);
    const none = await t.call('POST', '/device', { body: `user_code=${c.user_code}&action=approve` });
    expect(none.status).toBe(403);
    expect(JSON.parse((await t.poll(c.device_code)).body).error).toBe('authorization_pending');
  });

  test('poll: pending, then expired', async () => {
    let now = 1_000_000;
    const t = setup(() => now);
    const c = await t.issue();
    const pending = await t.poll(c.device_code);
    expect(pending.status).toBe(400);
    expect(JSON.parse(pending.body).error).toBe('authorization_pending');
    now += 11 * 60_000;
    expect(JSON.parse((await t.poll(c.device_code)).body).error).toBe('expired_token');
  });

  test('a browser-style request cannot start the app steps', async () => {
    const r = await setup().call('POST', '/api/device/code', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(r.status).toBe(403);
  });
});
