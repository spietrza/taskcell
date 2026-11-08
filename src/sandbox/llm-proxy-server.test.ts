// Boots the real standalone sidecar (llm-proxy-server.mjs) as a child process and exercises ONLY the
// short-circuit paths (404 disallowed-path gate, 401 wrong-nonce) so no real upstream is contacted.
// This is the regression guard for the module-level `upstreamKind` binding: if it shadowed the
// per-request `upstream` socket again, the request handler would TDZ-crash and the 404 assertion
// (which runs the line-~108 gate) would fail with a connection reset instead of a clean 404.
import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { request, createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLlmProxyServer } from './llm-proxy-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'llm-proxy-server.mjs');

// Spawn the sidecar with the test secret file + port. Wrapped so `Child` below captures the exact
// execa generic (its options literal) — typing the field as bare `ResultPromise` clashes under
// exactOptionalPropertyTypes.
function spawnServer(secretFile: string, port: number) {
  return execa('node', [serverPath], {
    env: { LLM_PROXY_SECRET_FILE: secretFile, PORT: String(port) },
    stdio: 'pipe',
    reject: false,
  });
}
type Child = ReturnType<typeof spawnServer>;

type Started = { port: number; child: Child; dir: string };

/** GET an ephemeral port that is almost certainly free by binding :0 via a throwaway listener. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Fire one HTTP request to the sidecar and resolve with the status code (body ignored). */
function hit(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolve true if a bare TCP connect to the port succeeds (listener is up); false otherwise. */
async function tcpUp(port: number): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const sock = connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll (bare TCP, no HTTP — so this probe never runs the path gate and can't itself trip the bug)
 * until the child server is listening. The TDZ crash, if present, surfaces later in the test body's
 * HTTP calls as a connection reset → a clear assertion failure rather than this helper hanging.
 */
async function waitUntilUp(port: number, child: Child, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // If the child dies during boot, surface that immediately instead of timing out.
  let exited = false;
  child.catch(() => {
    exited = true;
  });
  for (;;) {
    if (exited) throw new Error('llm-proxy child exited during boot');
    if (await tcpUp(port)) return;
    if (Date.now() > deadline) throw new Error('llm-proxy did not start listening in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startServer(secretBody: string): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'vg-llm-proxy-test-'));
  const secretFile = join(dir, 'secret');
  await writeFile(secretFile, secretBody, 'utf8');
  const port = await freePort();
  const child = spawnServer(secretFile, port);
  await waitUntilUp(port, child);
  return { port, child, dir };
}

describe('llm-proxy-server (booted child)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  function track(s: Started): Started {
    cleanups.push(async () => {
      s.child.kill('SIGKILL');
      await s.child.catch(() => {});
      await rm(s.dir, { recursive: true, force: true });
    });
    return s;
  }

  it('anthropic: 404 on disallowed path and 401 on wrong nonce (no upstream contacted)', async () => {
    const s = track(await startServer('UPSTREAM=anthropic\nMODE=api\nSECRET=sk-ant-test\nNONCE=real-nonce\n'));
    // Disallowed path runs the path gate (the line that TDZ-crashed under the shadowing bug).
    expect(await hit(s.port, 'POST', '/v1/models')).toBe(404);
    expect(await hit(s.port, 'GET', '/nope')).toBe(404);
    // Allowed path but wrong nonce → 401, short-circuits before any forward.
    expect(
      await hit(s.port, 'POST', '/v1/messages', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);

  it('refuses an encoded body it cannot inspect for egress tools with 415 (no upstream contacted)', async () => {
    const s = track(await startServer('UPSTREAM=anthropic\nMODE=api\nSECRET=sk-ant-test\nNONCE=real-nonce\n'));
    expect(
      await hit(s.port, 'POST', '/v1/messages', { authorization: 'Bearer real-nonce', 'content-encoding': 'gzip' }),
    ).toBe(415);
  }, 60_000);

  it('openai: 404 on disallowed path and 401 on wrong nonce (no upstream contacted)', async () => {
    const s = track(await startServer('UPSTREAM=openai\nSECRET=sk-openai-test\nNONCE=real-nonce\n'));
    expect(await hit(s.port, 'POST', '/v1/models')).toBe(404);
    expect(await hit(s.port, 'POST', '/v1/messages')).toBe(404); // openai rejects anthropic path
    expect(
      await hit(s.port, 'POST', '/v1/responses', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);

  it('zai: allows the anthropic-compatible /v1/messages path, rejects openai paths and wrong nonce', async () => {
    const s = track(await startServer('UPSTREAM=zai\nSECRET=zai-test-key\nNONCE=real-nonce\n'));
    // z.ai's coding endpoint is Anthropic-Messages-compatible: /v1/messages is allowed, /v1/responses is not.
    expect(await hit(s.port, 'POST', '/v1/responses')).toBe(404);
    expect(await hit(s.port, 'POST', '/v1/models')).toBe(404);
    // Allowed path but wrong nonce -> 401, short-circuits before any forward to api.z.ai.
    expect(
      await hit(s.port, 'POST', '/v1/messages', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);

  it('chatgpt: 404 on disallowed path and 401 on wrong nonce (no upstream contacted)', async () => {
    const s = track(await startServer(chatgptSecretText().text));
    // chatgpt model calls arrive at the bare /responses path, not /v1/responses or /v1/messages.
    expect(await hit(s.port, 'POST', '/v1/responses')).toBe(404);
    expect(await hit(s.port, 'POST', '/v1/messages')).toBe(404);
    expect(
      await hit(s.port, 'POST', '/responses', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);
});

/** A tiny local http server standing in for the real auth.openai.com, so the chatgpt refresh/revoke
 *  tests never need (or could even accidentally make) a real network call. */
function startFakeIdp(behavior: { refreshStatus?: number; refreshBody?: () => string; revokeStatus?: number } = {}): Promise<{
  port: number;
  server: ReturnType<typeof createServer>;
  refreshCalls: () => number;
  revokeCalls: () => number;
}> {
  let refreshCalls = 0;
  let revokeCalls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/oauth/token') {
        refreshCalls += 1;
        res.writeHead(behavior.refreshStatus ?? 200, { 'content-type': 'application/json' });
        res.end(behavior.refreshBody?.() ?? JSON.stringify({
          access_token: `real-access-${randomUUID()}`,
          refresh_token: `real-refresh-${randomUUID()}`,
          id_token: `real-id-token-${randomUUID()}`,
        }));
        return;
      }
      if (req.url === '/oauth/revoke') {
        revokeCalls += 1;
        res.writeHead(behavior.revokeStatus ?? 200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, server, refreshCalls: () => refreshCalls, revokeCalls: () => revokeCalls });
    });
  });
}

/** Starts a given in-process http.Server and resolves once it is accepting connections, returning its port. */
function listenOn(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/** Secret-file text for a chatgpt-plan sidecar; values are built at runtime, never hardcoded literals. */
function chatgptSecretText(
  overrides: Record<string, string> = {},
): { text: string; authFile: string; nonce: string; refreshPlaceholder: string } {
  const defaults = {
    UPSTREAM: 'chatgpt',
    NONCE: `nonce-${randomUUID()}`,
    ACCESS_TOKEN: 'a'.repeat(40),
    REFRESH_TOKEN: 'r'.repeat(40),
    ACCOUNT_ID: 'acct_real_123',
    PLAN_TYPE: 'pro',
    REFRESH_PLACEHOLDER: 'p'.repeat(32),
    AUTH_FILE: join(tmpdir(), `vg-chatgpt-auth-${randomUUID()}.json`),
  };
  const fields = { ...defaults, ...overrides };
  const text = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  return { text, authFile: fields.AUTH_FILE, nonce: fields.NONCE, refreshPlaceholder: fields.REFRESH_PLACEHOLDER };
}

describe('llm-proxy-server chatgpt auth kind (in-process factory, fake IdP/upstream)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('refresh: works without the nonce header given this run\'s placeholder refresh token, refused with any other', async () => {
    const idp = await startFakeIdp();
    cleanups.push(async () => { await closeServer(idp.server); });
    const { text, authFile, refreshPlaceholder } = chatgptSecretText();
    const server = createLlmProxyServer(text, { idpBaseUrl: `http://127.0.0.1:${idp.port}` });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(authFile, { force: true });
    });

    // No Authorization header at all — the real Codex client never sends the sidecar nonce here.
    const ok = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }),
    });
    expect(ok.status).toBe(200);
    expect(idp.refreshCalls()).toBe(1);

    const bad = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'some-other-token-value' }),
    });
    expect(bad.status).toBe(401);
    expect(idp.refreshCalls()).toBe(1); // the rejected attempt never reaches the IdP
  });

  it('revoke: follows the same rules as refresh (no nonce needed, bound to the placeholder)', async () => {
    const idp = await startFakeIdp();
    cleanups.push(async () => { await closeServer(idp.server); });
    const { text, authFile, refreshPlaceholder } = chatgptSecretText();
    const server = createLlmProxyServer(text, { idpBaseUrl: `http://127.0.0.1:${idp.port}` });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(authFile, { force: true });
    });

    const ok = await fetch(`http://127.0.0.1:${port}/oauth/revoke`, {
      method: 'POST',
      body: JSON.stringify({ token: refreshPlaceholder, token_type_hint: 'refresh_token' }),
    });
    expect(ok.status).toBe(200);
    expect(idp.revokeCalls()).toBe(1);

    const bad = await fetch(`http://127.0.0.1:${port}/oauth/revoke`, {
      method: 'POST',
      body: JSON.stringify({ token: 'some-other-token-value' }),
    });
    expect(bad.status).toBe(401);
    expect(idp.revokeCalls()).toBe(1);
  });

  it('refresh response holds only placeholders + a synthetic id_token; the real tokens never reach the cell, and the rotated real tokens land on AUTH_FILE', async () => {
    const idp = await startFakeIdp();
    cleanups.push(async () => { await closeServer(idp.server); });
    const { text, authFile, nonce, refreshPlaceholder } = chatgptSecretText();
    const server = createLlmProxyServer(text, { idpBaseUrl: `http://127.0.0.1:${idp.port}` });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(authFile, { force: true });
    });

    const res = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }),
    });
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { access_token: string; refresh_token: string; id_token: string };
    expect(parsed.access_token).toBe(nonce);
    expect(parsed.refresh_token).toBe(refreshPlaceholder);
    const idSegments = parsed.id_token.split('.');
    expect(idSegments).toHaveLength(3);
    for (const seg of idSegments) expect(seg.length).toBeGreaterThan(0);
    const idPayload = JSON.parse(Buffer.from(idSegments[1] ?? '', 'base64url').toString('utf8'));
    expect(idPayload).toEqual({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_real_123', chatgpt_plan_type: 'pro' } });

    // The real tokens the fake IdP minted are never present anywhere in the cell-facing response.
    const persisted = JSON.parse(await readFile(authFile, 'utf8')) as { tokens: { access_token: string; refresh_token: string; id_token: string } };
    expect(raw).not.toContain(persisted.tokens.access_token);
    expect(raw).not.toContain(persisted.tokens.refresh_token);
    expect(persisted.tokens.id_token).toBe(parsed.id_token);
    expect(persisted.tokens.access_token).toMatch(/^real-access-/);
    expect(persisted.tokens.refresh_token).toMatch(/^real-refresh-/);
  });

  it('refresh floor: repeated refreshes inside the window make exactly one upstream call, including concurrent ones', async () => {
    const idp = await startFakeIdp();
    cleanups.push(async () => { await closeServer(idp.server); });
    const { text, authFile, refreshPlaceholder } = chatgptSecretText();
    const server = createLlmProxyServer(text, { idpBaseUrl: `http://127.0.0.1:${idp.port}`, refreshFloorMs: 60_000 });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(authFile, { force: true });
    });

    const call = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }),
    });
    // Two concurrent calls (neither has settled when the other starts) dedup to one upstream call...
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // ...and a third, sequential call still inside the floor window reuses the cached result.
    const c = await call();
    expect(c.status).toBe(200);
    expect(idp.refreshCalls()).toBe(1);
  });

  it.each(['{}', 'null', '{"access_token":""}', JSON.stringify({ access_token: 'bad\ntoken' }),
    '{"access_token":"valid","refresh_token":42}'])('rejects invalid refresh credentials without persisting: %s', async (refreshBody) => {
    const idp = await startFakeIdp({ refreshBody: () => refreshBody });
    cleanups.push(async () => { await closeServer(idp.server); });
    const { text, authFile } = chatgptSecretText();
    const server = createLlmProxyServer(text, { idpBaseUrl: 'http://127.0.0.1:' + idp.port });
    const port = await listenOn(server);
    cleanups.push(async () => { await closeServer(server); await rm(authFile, { force: true }); });
    const res = await fetch('http://127.0.0.1:' + port + '/oauth/token', {
      method: 'POST', body: JSON.stringify({ refresh_token: 'p'.repeat(32) }),
    });
    expect(res.status).toBe(502);
    await expect(readFile(authFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an oversized IdP response instead of buffering it', async () => {
    const idp = await startFakeIdp({ refreshBody: () => 'x'.repeat(2 * 1024 * 1024) });
    cleanups.push(async () => { await closeServer(idp.server); });
    const { text, authFile, refreshPlaceholder } = chatgptSecretText();
    const server = createLlmProxyServer(text, { idpBaseUrl: `http://127.0.0.1:${idp.port}` });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(authFile, { force: true });
    });

    const res = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }),
    });
    expect(res.status).toBe(502);
  });

  it('model calls: the upstream always sees the host account id and real access token, even when the cell forges its own', async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    const fakeUpstream = createServer((req, res) => {
      seenHeaders = req.headers;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const upstreamPort = await listenOn(fakeUpstream);
    cleanups.push(async () => { await closeServer(fakeUpstream); });

    const accessToken = 'a'.repeat(40);
    const { text, authFile, nonce } = chatgptSecretText({ ACCESS_TOKEN: accessToken, ACCOUNT_ID: 'acct_real_123' });
    const server = createLlmProxyServer(text, { forwardTo: { host: '127.0.0.1', port: upstreamPort, protocol: 'http' } });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(authFile, { force: true });
    });

    const res = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${nonce}`, 'chatgpt-account-id': 'acct_forged_by_cell', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(seenHeaders['chatgpt-account-id']).toBe('acct_real_123');
    expect(seenHeaders['authorization']).toBe(`Bearer ${accessToken}`);
  });

  it('without a chatgpt-plan credential, an anthropic sidecar still behaves exactly as before', async () => {
    const text = 'UPSTREAM=anthropic\nMODE=api\nSECRET=sk-ant-test\nNONCE=real-nonce\n';
    const server = createLlmProxyServer(text);
    const port = await listenOn(server);
    cleanups.push(async () => { await closeServer(server); });

    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: 'POST' });
    expect(res.status).toBe(404);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-nonce' },
    });
    expect(unauthorized.status).toBe(401);
  });
});


describe('llm-proxy-server (execa 10 handle)', () => {
  it('exposes the Node ChildProcess via nodeChildProcess and reports a SIGKILL teardown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-handle-'));
    const secretFile = join(dir, 'secret');
    await writeFile(secretFile, 'nonce\n');
    const child = spawnServer(secretFile, await freePort());
    try {
      expect(child.nodeChildProcess.pid).toBe(child.pid);
      expect(child.nodeChildProcess.exitCode).toBeNull();
      child.kill('SIGKILL');
      const result = await child;
      expect(result.isTerminated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
