// Boots the real standalone sidecar (llm-proxy-server.mjs) as a child process and exercises ONLY the
// short-circuit paths (404 disallowed-path gate, 401 wrong-nonce) so no real upstream is contacted.
// This is the regression guard for the module-level `upstreamKind` binding: if it shadowed the
// per-request `upstream` socket again, the request handler would TDZ-crash and the 404 assertion
// (which runs the line-~108 gate) would fail with a connection reset instead of a clean 404.
import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { request, createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'llm-proxy-server.mjs');

// Spawn the sidecar with the test secret file + port. Wrapped so `Child` below captures the exact
// execa generic (its options literal) — typing the field as bare `ResultPromise` clashes under
// exactOptionalPropertyTypes.
function spawnServer(secretFile: string, port: number, extraEnv: Record<string, string> = {}) {
  return execa('node', [serverPath], {
    env: { LLM_PROXY_SECRET_FILE: secretFile, PORT: String(port), ...extraEnv },
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

async function startServer(secretBody: string, extraEnv: Record<string, string> = {}): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'vg-llm-proxy-test-'));
  const secretFile = join(dir, 'secret');
  await writeFile(secretFile, secretBody, 'utf8');
  const port = await freePort();
  const child = spawnServer(secretFile, port, extraEnv);
  await waitUntilUp(port, child);
  return { port, child, dir };
}

/** POST a JSON body and resolve the status + parsed JSON response body. */
function hitJson(port: number, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { ...headers, 'content-type': 'application/json', 'content-length': String(payload.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* no/invalid body */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** A throwaway plain-HTTP fake OpenAI /oauth/token + /oauth/revoke endpoint, for refresh/revoke tests. */
async function fakeOpenAiAuth(): Promise<{ port: number; close: () => Promise<void>; revoked: boolean }> {
  const state = { revoked: false };
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/oauth/revoke') {
        state.revoked = true;
        res.writeHead(200).end();
        return;
      }
      const payload = Buffer.from(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', id_token: 'rotated.id.token' }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
    });
  });
  const port = await freePort();
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', resolve));
  return {
    port,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    get revoked() {
      return state.revoked;
    },
  };
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

  it('codex-chatgpt: 404 on disallowed path, 401 on wrong nonce (no upstream contacted)', async () => {
    const authJson = JSON.stringify({ tokens: { access_token: 'real-at', refresh_token: 'real-rt', id_token: 'h.p.s' } });
    const s = track(await startServer(`UPSTREAM=codex-chatgpt\nNONCE=real-nonce\nAUTH_JSON=${authJson}\n`));
    expect(await hit(s.port, 'POST', '/v1/responses')).toBe(404); // openai path rejected for this upstream
    expect(await hit(s.port, 'GET', '/backend-api/codex/responses')).toBe(404);
    expect(
      await hit(s.port, 'POST', '/backend-api/codex/responses', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
    expect(
      await hit(s.port, 'POST', '/oauth/token', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);

  it('codex-chatgpt refresh: goes through a fake OpenAI endpoint, rotates state, and answers the cell with placeholders only', async () => {
    const fake = await fakeOpenAiAuth();
    try {
      const authJson = JSON.stringify({ tokens: { access_token: 'real-at', refresh_token: 'real-rt-SECRET-VALUE', id_token: 'h.p.s', account_id: 'acct-1' } });
      const s = track(
        await startServer(`UPSTREAM=codex-chatgpt\nNONCE=real-nonce\nAUTH_JSON=${authJson}\n`, {
          LLM_PROXY_CODEX_AUTH_HOST: '127.0.0.1',
          LLM_PROXY_CODEX_AUTH_PORT: String(fake.port),
          LLM_PROXY_CODEX_AUTH_INSECURE: '1',
        }),
      );
      const { status, json } = await hitJson(s.port, '/oauth/token', { authorization: 'Bearer real-nonce' }, { refresh_token: 'cell-does-not-control-this' });
      expect(status).toBe(200);
      const body = json as { access_token: string; refresh_token: string; id_token: string };
      // The cell gets fresh placeholders — never the rotated real tokens the fake endpoint returned.
      expect(body.access_token).not.toBe('rotated-access');
      expect(body.refresh_token).not.toBe('rotated-refresh');
      expect(body.id_token.split('.')).toHaveLength(3);
      expect(body.id_token).not.toBe('rotated.id.token');
    } finally {
      await fake.close();
    }
  }, 60_000);

  it('codex-chatgpt revoke: answered locally with 200 and no body, never reaching the real endpoint', async () => {
    const fake = await fakeOpenAiAuth();
    try {
      const authJson = JSON.stringify({ tokens: { access_token: 'real-at', refresh_token: 'real-rt', id_token: 'h.p.s' } });
      const s = track(
        await startServer(`UPSTREAM=codex-chatgpt\nNONCE=real-nonce\nAUTH_JSON=${authJson}\n`, {
          LLM_PROXY_CODEX_AUTH_HOST: '127.0.0.1',
          LLM_PROXY_CODEX_AUTH_PORT: String(fake.port),
          LLM_PROXY_CODEX_AUTH_INSECURE: '1',
        }),
      );
      const { status, json } = await hitJson(s.port, '/oauth/revoke', { authorization: 'Bearer real-nonce' }, {});
      expect(status).toBe(200);
      expect(json).toBeNull();
      // The cell must not be able to invalidate the host's credential: nothing is forwarded at all.
      expect(fake.revoked).toBe(false);
    } finally {
      await fake.close();
    }
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
