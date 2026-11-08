// Boots the real standalone sidecar (llm-proxy-server.mjs) as a child process and exercises ONLY the
// short-circuit paths (404 disallowed-path gate, 401 wrong-nonce) so no real upstream is contacted.
// This is the regression guard for the module-level `upstreamKind` binding: if it shadowed the
// per-request `upstream` socket again, the request handler would TDZ-crash and the 404 assertion
// (which runs the line-~108 gate) would fail with a connection reset instead of a clean 404.
import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { request, createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLlmProxyServer } from './llm-proxy-server.mjs';
import { CODEX_CLIENT_ID } from './llm-proxy-rewrite.mjs';

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

/**
 * Boot the sidecar on a fresh temp directory. `secretBody` may be a builder taking that directory:
 * the chatgpt kind requires AUTH_FILE to sit in the sidecar's own credential directory, which is the
 * secret file's directory — known only once this helper has created it.
 */
async function startServer(secretBody: string | ((dir: string) => string)): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'vg-llm-proxy-test-'));
  const secretFile = join(dir, 'secret');
  await writeFile(secretFile, typeof secretBody === 'string' ? secretBody : secretBody(dir), 'utf8');
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
    const s = track(await startServer((dir) => chatgptSecretText(dir).text));
    // chatgpt model calls arrive at the bare /responses path, not /v1/responses or /v1/messages.
    expect(await hit(s.port, 'POST', '/v1/responses')).toBe(404);
    expect(await hit(s.port, 'POST', '/v1/messages')).toBe(404);
    expect(
      await hit(s.port, 'POST', '/responses', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);
});

interface FakeIdp {
  port: number;
  server: ReturnType<typeof createServer>;
  refreshCalls: () => number;
  revokeCalls: () => number;
  /** Every body the IdP was handed, parsed — so a test can assert the EXACT upstream refresh body. */
  bodies: () => unknown[];
}

/** A tiny local http server standing in for the real auth.openai.com, so the chatgpt refresh/revoke
 *  tests never need (or could even accidentally make) a real network call. `hold`, when given, gates
 *  the refresh response so a test can keep calls in flight. */
function startFakeIdp(
  behavior: { refreshStatus?: number; refreshBody?: () => string; revokeStatus?: number; hold?: Promise<void> } = {},
): Promise<FakeIdp> {
  let refreshCalls = 0;
  let revokeCalls = 0;
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push(raw);
      }
      if (req.url === '/oauth/token') {
        refreshCalls += 1;
        const respond = (): void => {
          res.writeHead(behavior.refreshStatus ?? 200, { 'content-type': 'application/json' });
          res.end(behavior.refreshBody?.() ?? JSON.stringify({
            access_token: `real-access-${randomUUID()}`,
            refresh_token: `real-refresh-${randomUUID()}`,
            id_token: `real-id-token-${randomUUID()}`,
          }));
        };
        if (behavior.hold !== undefined) void behavior.hold.then(respond);
        else respond();
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
      resolve({ port, server, refreshCalls: () => refreshCalls, revokeCalls: () => revokeCalls, bodies: () => bodies });
    });
  });
}

/** POST a JSON body on its OWN connection (agent: false) and resolve with the status + body text. */
function postJson(port: number, path: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Resolve once the server holds `count` open connections (used to know requests are in flight). */
async function waitForConnections(server: ReturnType<typeof createServer>, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const open = await new Promise<number>((resolve) => server.getConnections((_e, n) => resolve(n ?? 0)));
    if (open >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${open} of ${count} connections opened in time`);
    await new Promise((r) => setTimeout(r, 10));
  }
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

interface ChatgptFixture {
  text: string;
  authFile: string;
  nonce: string;
  refreshPlaceholder: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Secret-file text for a chatgpt-plan sidecar; every credential value is built at runtime, never a
 * hardcoded literal. AUTH_FILE defaults into `credentialDir` because the sidecar refuses to persist
 * anywhere outside its own credential directory.
 */
function chatgptSecretText(credentialDir: string, overrides: Record<string, string> = {}): ChatgptFixture {
  const defaults = {
    UPSTREAM: 'chatgpt',
    NONCE: `nonce-${randomUUID()}`,
    ACCESS_TOKEN: 'a'.repeat(40),
    REFRESH_TOKEN: 'r'.repeat(40),
    ACCOUNT_ID: 'acct_real_123',
    PLAN_TYPE: 'pro',
    REFRESH_PLACEHOLDER: 'p'.repeat(32),
    AUTH_FILE: join(credentialDir, 'codex-auth.json'),
  };
  const fields = { ...defaults, ...overrides };
  const text = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  return {
    text,
    authFile: fields.AUTH_FILE,
    nonce: fields.NONCE,
    refreshPlaceholder: fields.REFRESH_PLACEHOLDER,
    accessToken: fields.ACCESS_TOKEN,
    refreshToken: fields.REFRESH_TOKEN,
  };
}

describe('llm-proxy-server chatgpt auth kind (in-process factory, fake IdP/upstream)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  type Booted = ChatgptFixture & { port: number; credentialDir: string; server: ReturnType<typeof createServer> };

  /** Boots an in-process chatgpt sidecar on a fresh credential directory; teardown is registered. */
  async function bootChatgpt(options: {
    idpPort?: number;
    refreshFloorMs?: number;
    forwardTo?: { host: string; port: number; protocol: 'http' | 'https' };
    overrides?: Record<string, string>;
  } = {}): Promise<Booted> {
    const credentialDir = await mkdtemp(join(tmpdir(), 'vg-chatgpt-cred-'));
    const fixture = chatgptSecretText(credentialDir, options.overrides ?? {});
    const server = createLlmProxyServer(fixture.text, {
      credentialDir,
      ...(options.idpPort !== undefined ? { idpBaseUrl: `http://127.0.0.1:${options.idpPort}` } : {}),
      ...(options.refreshFloorMs !== undefined ? { refreshFloorMs: options.refreshFloorMs } : {}),
      ...(options.forwardTo !== undefined ? { forwardTo: options.forwardTo } : {}),
    });
    const port = await listenOn(server);
    cleanups.push(async () => {
      await closeServer(server);
      await rm(credentialDir, { recursive: true, force: true });
    });
    return { ...fixture, port, credentialDir, server };
  }

  /** Starts a fake IdP whose teardown is registered with this describe's cleanups. */
  async function bootIdp(behavior: Parameters<typeof startFakeIdp>[0] = {}): Promise<FakeIdp> {
    const idp = await startFakeIdp(behavior);
    cleanups.push(async () => { await closeServer(idp.server); });
    return idp;
  }

  it('refresh: works without the nonce header given this run\'s placeholder refresh token, refused with any other', async () => {
    const idp = await bootIdp();
    const { port, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });

    // No Authorization header at all — the real Codex client never sends the sidecar nonce here.
    const ok = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    expect(ok.status).toBe(200);
    expect(idp.refreshCalls()).toBe(1);

    const bad = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'some-other-value' }));
    expect(bad.status).toBe(401);
    expect(idp.refreshCalls()).toBe(1); // the rejected attempt never reaches the IdP
  });

  it('the upstream refresh body is built from fixed fields only — nothing the cell sent is forwarded', async () => {
    const idp = await bootIdp();
    const { port, refreshPlaceholder, refreshToken } = await bootChatgpt({ idpPort: idp.port });

    // Everything here beyond the placeholder is cell-controlled junk: a different grant, a forged
    // client id, an extra scope, an audience. None of it may appear in what the IdP receives.
    const ok = await postJson(port, '/oauth/token', JSON.stringify({
      grant_type: 'client_credentials',
      refresh_token: refreshPlaceholder,
      client_id: 'client-id-forged-by-cell',
      scope: 'openid profile email offline_access',
      audience: 'https://evil.example',
    }));
    expect(ok.status).toBe(200);
    // The fake IdP asserts the EXACT body it received: three fixed fields, the real refresh token.
    expect(idp.bodies()).toEqual([
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CODEX_CLIENT_ID },
    ]);
  });

  it('revoke is answered locally: zero upstream calls, the host credential file untouched, and the placeholder dropped', async () => {
    const idp = await bootIdp();
    const { port, authFile, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port, refreshFloorMs: 60_000 });

    // Refresh first so there is a persisted host credential (and a cached refresh) to protect.
    const refreshed = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    expect(refreshed.status).toBe(200);
    const before = await readFile(authFile, 'utf8');

    const revoked = await postJson(port, '/oauth/revoke', JSON.stringify({ token: refreshPlaceholder, token_type_hint: 'refresh_token' }));
    expect(revoked.status).toBe(200);
    // The real /oauth/revoke is never called — a run's cell cannot log the host's account out...
    expect(idp.revokeCalls()).toBe(0);
    // ...and nothing else reached the IdP either (only the one refresh above).
    expect(idp.refreshCalls()).toBe(1);
    // ...and the host credential file is byte-for-byte what it was.
    expect(await readFile(authFile, 'utf8')).toBe(before);

    // The run's binding state is gone: the placeholder no longer works on either route, and the
    // cached refresh response it would otherwise have replayed is cleared with it.
    const afterRefresh = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    expect(afterRefresh.status).toBe(401);
    expect(afterRefresh.text).not.toContain('id_token');
    const afterRevoke = await postJson(port, '/oauth/revoke', JSON.stringify({ token: refreshPlaceholder }));
    expect(afterRevoke.status).toBe(401);
    expect(idp.refreshCalls()).toBe(1);
    expect(idp.revokeCalls()).toBe(0);
  });

  it('revoke: refused (and still local) when the body does not carry this run\'s placeholder', async () => {
    const idp = await bootIdp();
    const { port, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });

    const bad = await postJson(port, '/oauth/revoke', JSON.stringify({ token: 'some-other-value' }));
    expect(bad.status).toBe(401);
    expect(idp.revokeCalls()).toBe(0);
    // The refused attempt did not drop the binding either: the real placeholder still refreshes.
    const ok = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    expect(ok.status).toBe(200);
  });

  it('refresh response holds only placeholders + a synthetic id_token; the real tokens never reach the cell, and the rotated real tokens land on AUTH_FILE', async () => {
    const idp = await bootIdp();
    const { port, authFile, credentialDir, nonce, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });

    const res = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { access_token: string; refresh_token: string; id_token: string };
    expect(parsed.access_token).toBe(nonce);
    expect(parsed.refresh_token).toBe(refreshPlaceholder);
    const idSegments = parsed.id_token.split('.');
    expect(idSegments).toHaveLength(3);
    for (const seg of idSegments) expect(seg.length).toBeGreaterThan(0);
    const idPayload = JSON.parse(Buffer.from(idSegments[1] ?? '', 'base64url').toString('utf8'));
    expect(idPayload).toEqual({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_real_123', chatgpt_plan_type: 'pro' } });

    // The real tokens the fake IdP minted are never present anywhere in the cell-facing response.
    const persisted = JSON.parse(await readFile(authFile, 'utf8')) as { tokens: { access_token: string; refresh_token: string; id_token: string } };
    expect(res.text).not.toContain(persisted.tokens.access_token);
    expect(res.text).not.toContain(persisted.tokens.refresh_token);
    expect(persisted.tokens.id_token).toBe(parsed.id_token);
    expect(persisted.tokens.access_token).toMatch(/^real-access-/);
    expect(persisted.tokens.refresh_token).toMatch(/^real-refresh-/);
    // Written via a temp file renamed into place, mode 0600, with no leftover temp file.
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(credentialDir)).toEqual([basename(authFile)]);
  });

  it('refuses an AUTH_FILE outside the sidecar\'s own credential directory', async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), 'vg-chatgpt-cred-'));
    cleanups.push(async () => { await rm(credentialDir, { recursive: true, force: true }); });

    const outside = chatgptSecretText(credentialDir, { AUTH_FILE: join(tmpdir(), `vg-outside-${randomUUID()}.json`) });
    expect(() => createLlmProxyServer(outside.text, { credentialDir })).toThrow(/AUTH_FILE/);
    // A traversal path that resolves out of the directory is refused the same way.
    const climb = chatgptSecretText(credentialDir, { AUTH_FILE: join(credentialDir, '..', 'escape.json') });
    expect(() => createLlmProxyServer(climb.text, { credentialDir })).toThrow(/AUTH_FILE/);
    // Control characters in AUTH_FILE are rejected with every other credential field.
    const ctrl = chatgptSecretText(credentialDir, { AUTH_FILE: join(credentialDir, 'codex\u0001auth.json') });
    expect(() => createLlmProxyServer(ctrl.text, { credentialDir })).toThrow(/control characters/);
    // The in-directory default is accepted.
    const inside = chatgptSecretText(credentialDir);
    expect(() => createLlmProxyServer(inside.text, { credentialDir })).not.toThrow();
  });

  it('refresh floor: repeated refreshes inside the window make exactly one upstream call, including concurrent ones', async () => {
    const idp = await bootIdp();
    const { port, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port, refreshFloorMs: 60_000 });

    const call = (): Promise<{ status: number; text: string }> =>
      postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    // Two concurrent calls (neither has settled when the other starts) dedup to one upstream call...
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // ...and a third, sequential call still inside the floor window reuses the cached result.
    const c = await call();
    expect(c.status).toBe(200);
    expect(idp.refreshCalls()).toBe(1);
  });

  it('IdP routes hold a concurrency slot: the MAX_CONCURRENT-th+1 in-flight refresh gets 503', async () => {
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const idp = await bootIdp({ hold });
    const { port, server, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });

    const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder });
    // MAX_CONCURRENT (8) refreshes, each on its own connection, all parked on the gated IdP call.
    const parked = Array.from({ length: 8 }, () => postJson(port, '/oauth/token', body));
    await waitForConnections(server, 8);

    const overflow = await postJson(port, '/oauth/token', body);
    expect(overflow.status).toBe(503);

    release();
    for (const res of await Promise.all(parked)) expect(res.status).toBe(200);
    // Slots are released once the parked requests finish, so the next refresh is served again.
    expect((await postJson(port, '/oauth/token', body)).status).toBe(200);
  });

  it.each(['{}', 'null', '{"access_token":""}', JSON.stringify({ access_token: 'bad\ntoken' }),
    '{"access_token":"valid","refresh_token":42}'])('rejects invalid refresh credentials without persisting: %s', async (refreshBody) => {
    const idp = await bootIdp({ refreshBody: () => refreshBody });
    const { port, authFile, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });
    const res = await postJson(port, '/oauth/token', JSON.stringify({ refresh_token: refreshPlaceholder }));
    expect(res.status).toBe(502);
    await expect(readFile(authFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an oversized IdP response instead of buffering it', async () => {
    const idp = await bootIdp({ refreshBody: () => 'x'.repeat(2 * 1024 * 1024) });
    const { port, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });

    const res = await postJson(port, '/oauth/token', JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshPlaceholder }));
    expect(res.status).toBe(502);
  });

  it('answers an oversized IdP request body with a real 413 (not a bare connection reset)', async () => {
    const idp = await bootIdp();
    const { port, refreshPlaceholder } = await bootChatgpt({ idpPort: idp.port });

    // Just past the 64 KiB IdP-request cap, so the whole body is on the wire before the 413 lands.
    const oversized = JSON.stringify({ refresh_token: refreshPlaceholder, pad: 'x'.repeat(70 * 1024) });
    const res = await postJson(port, '/oauth/token', oversized);
    expect(res.status).toBe(413);
    expect(idp.refreshCalls()).toBe(0);
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

    const { port, nonce, accessToken } = await bootChatgpt({
      forwardTo: { host: '127.0.0.1', port: upstreamPort, protocol: 'http' },
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
