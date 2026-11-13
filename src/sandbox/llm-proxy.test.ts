import { describe, it, expect } from 'vitest';
import { startLlmProxy, startProviderProxies } from './llm-proxy.js';
import { llmProxySandboxEnv } from './egress-proxy.js';
import { providerSecrets } from '../agents/registry.js';
import { SandboxError } from '../core/errors.js';

const ENV_VAR = 'TASKCELL_SANDBOX_IMAGE';

/** A ChatGPT-plan credential as providerSecrets hands it to the sidecar (real token values). */
const REAL_CHATGPT_AUTH = { accessToken: 'real-access', refreshToken: 'real-refresh', accountId: 'acct-real', planType: 'pro' };

function fakeDocker(): { calls: { args: string[]; input?: string }[]; run: (args: string[], opts?: { input?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }> } {
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], opts?: { input?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('startLlmProxy', () => {
  it('delivers the secret off-argv and returns url + nonce', async () => {
    const d = fakeDocker();
    const proxy = await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'subscription', secret: 'OAT-SECRET' },
      docker: d.run,
    });
    expect(proxy.url).toMatch(/^http:\/\/vg-llm-.*:\d+$/);
    expect(proxy.host).toMatch(/^vg-llm-/);
    expect(proxy.url).toContain(proxy.host);
    expect(proxy.nonce.length).toBeGreaterThanOrEqual(16);
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('OAT-SECRET'); // never on argv
    expect(d.calls.some((c) => c.input?.includes('OAT-SECRET'))).toBe(true); // delivered via stdin
    await proxy.destroy();
    expect(d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
  });

  it('labels the sidecar with vanguard.runId and starts the server', async () => {
    const d = fakeDocker();
    await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'api', secret: 'sk-ant-secret' },
      docker: d.run,
    });
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).toMatch(/--label vanguard\.runId=/);
    expect(flat).toContain('node /tmp/llm-proxy.mjs');
    expect(flat).toContain('LLM_PROXY_SECRET_FILE=/run/vanguard-llm/secret');
    // The secret's directory is a dedicated tmpfs, not the container's writable layer.
    expect(flat).toContain('--tmpfs /run/vanguard-llm:rw,noexec,nosuid,mode=1777,size=1m');
    expect(flat).toContain('PORT=8088');
    // The secret travels only via stdin, never via -e or argv.
    expect(flat).not.toContain('sk-ant-secret');
    expect(d.calls.some((c) => c.input?.includes('sk-ant-secret'))).toBe(true);
  });

  it('adds the vanguard.owner label when TASKCELL_OWNER_LABEL is set', async () => {
    const prev = process.env.TASKCELL_OWNER_LABEL;
    process.env.TASKCELL_OWNER_LABEL = 'ci-job-42';
    try {
      const d = fakeDocker();
      await startLlmProxy({
        network: 'vg-egr-x',
        auth: { mode: 'api', secret: 'sk-ant-secret' },
        docker: d.run,
      });
      const runCall = d.calls.find((c) => c.args[0] === 'run');
      expect(runCall?.args).toContain('vanguard.owner=ci-job-42');
    } finally {
      if (prev === undefined) delete process.env.TASKCELL_OWNER_LABEL;
      else process.env.TASKCELL_OWNER_LABEL = prev;
    }
  });

  it('has no vanguard.owner label by default', async () => {
    const d = fakeDocker();
    await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'api', secret: 'sk-ant-secret' },
      docker: d.run,
    });
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('vanguard.owner=');
  });

  it('stands up an OpenAI sidecar tagged UPSTREAM=openai with the real key only via stdin', async () => {
    const d = fakeDocker();
    const proxy = await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'api', secret: 'sk-real-openai' },
      upstream: 'openai',
      docker: d.run,
    });
    expect(d.calls.some((c) => c.input?.includes('UPSTREAM=openai'))).toBe(true);
    // The real key travels only via stdin, never via argv.
    expect(d.calls.some((c) => c.input?.includes('sk-real-openai'))).toBe(true);
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('sk-real-openai');
    expect(proxy.url).toMatch(/^http:\/\/vg-llm-.*:8088$/);
    expect(proxy.host).toMatch(/^vg-llm-/);
    expect(proxy.nonce.length).toBeGreaterThanOrEqual(16);
    await proxy.destroy();
    expect(d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
  });

  it('stands up an OpenRouter sidecar tagged UPSTREAM=openrouter with the real key only via stdin', async () => {
    const d = fakeDocker();
    await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'api', secret: 'sk-real-openrouter' },
      upstream: 'openrouter',
      docker: d.run,
    });
    expect(d.calls.some((c) => c.input?.includes('UPSTREAM=openrouter'))).toBe(true);
    expect(d.calls.some((c) => c.input?.includes('sk-real-openrouter'))).toBe(true);
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('sk-real-openrouter');
  });

  it('defaults the upstream to anthropic and tags UPSTREAM=anthropic', async () => {
    const d = fakeDocker();
    await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'subscription', secret: 'OAT-SECRET' },
      docker: d.run,
    });
    expect(d.calls.some((c) => c.input?.includes('UPSTREAM=anthropic'))).toBe(true);
  });

  it('returns a random nonce per run', async () => {
    const d = fakeDocker();
    const a = await startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: d.run });
    const b = await startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: d.run });
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('runs the sidecar on TASKCELL_SANDBOX_IMAGE when set — it is the sandbox image, not a dedicated proxy image', async () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'sha256:deadbeef';
    try {
      const d = fakeDocker();
      await startLlmProxy({ network: 'vg-egr-x', auth: { mode: 'api', secret: 's' }, docker: d.run });
      const runCall = d.calls.find((c) => c.args[0] === 'run');
      expect(runCall?.args).toContain('sha256:deadbeef');
      expect(runCall?.args).not.toContain('vanguard-sandbox:latest');
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it('an explicit image option still wins over TASKCELL_SANDBOX_IMAGE', async () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'sha256:deadbeef';
    try {
      const d = fakeDocker();
      await startLlmProxy({ network: 'vg-egr-x', auth: { mode: 'api', secret: 's' }, image: 'custom:1', docker: d.run });
      const runCall = d.calls.find((c) => c.args[0] === 'run');
      expect(runCall?.args).toContain('custom:1');
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it('a non-zero docker exit (the production failure shape) tears down and throws instead of returning a dead proxy URL', async () => {
    const removed: string[][] = [];
    const run = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (args[0] === 'rm') removed.push(args);
      if (args[0] === 'cp') return { exitCode: 1, stdout: '', stderr: 'no such file' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(
      startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: run }),
    ).rejects.toThrow(/Failed to start llm proxy/);
    expect(removed.some((a) => a.includes('-f'))).toBe(true);
  });

  it('tears down the sidecar and wraps failures in SandboxError', async () => {
    const removed: string[][] = [];
    const run = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (args[0] === 'network' && args[1] === 'connect') throw new Error('boom');
      if (args[0] === 'rm') removed.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(
      startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: run }),
    ).rejects.toThrow(/Failed to start llm proxy/);
    expect(removed.some((a) => a.includes('-f'))).toBe(true);
  });
});

describe('startProviderProxies', () => {
  it('starts no sidecar and no-op destroys when no codex key is proxied', async () => {
    const d = fakeDocker();
    const proxies = await startProviderProxies({ proxySecrets: {}, network: 'vg-egr-x', docker: d.run });
    expect(proxies.openai).toBeUndefined();
    await proxies.destroy();
    expect(d.calls).toHaveLength(0);
  });

  it('stands up an OpenAI sidecar with the real key only via stdin and destroys it', async () => {
    const d = fakeDocker();
    const proxies = await startProviderProxies({ proxySecrets: { codex: 'sk-real-codex' }, network: 'vg-egr-x', docker: d.run });
    expect(proxies.openai).toBeDefined();
    expect(proxies.openai?.url).toMatch(/^http:\/\/vg-llm-.*:8088$/);
    expect(proxies.openai?.host).toMatch(/^vg-llm-/);
    expect(proxies.openai?.nonce.length).toBeGreaterThanOrEqual(16);
    // The real key + UPSTREAM=openai travel only via stdin, never argv.
    expect(d.calls.some((c) => c.input?.includes('UPSTREAM=openai'))).toBe(true);
    expect(d.calls.some((c) => c.input?.includes('sk-real-codex'))).toBe(true);
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('sk-real-codex');
    await proxies.destroy();
    expect(d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
  });

  it('throws SandboxError when a codex key is proxied without a network', async () => {
    const d = fakeDocker();
    await expect(startProviderProxies({ proxySecrets: { codex: 'sk-real-codex' }, docker: d.run })).rejects.toBeInstanceOf(SandboxError);
    expect(d.calls).toHaveLength(0);
  });

  it('stands up a ChatGPT sidecar with the real credential only via stdin, and returns the cell wiring', async () => {
    const d = fakeDocker();
    const proxies = await startProviderProxies({ proxySecrets: { codexChatgpt: REAL_CHATGPT_AUTH }, network: 'vg-egr-x', docker: d.run });
    expect(proxies.openai).toBeUndefined(); // mutually exclusive with the API-key sidecar
    expect(proxies.chatgpt?.url).toMatch(/^http:\/\/vg-llm-.*:8088$/);
    expect(proxies.chatgpt?.host).toMatch(/^vg-llm-/);
    expect(proxies.chatgpt?.nonce.length).toBeGreaterThanOrEqual(16);
    // The refresh placeholder is a fresh per-run value, never the real refresh token.
    expect(proxies.chatgpt?.refreshPlaceholder.length).toBeGreaterThanOrEqual(16);
    expect(proxies.chatgpt?.refreshPlaceholder).not.toBe(REAL_CHATGPT_AUTH.refreshToken);
    // The non-secret routing fields pass straight through for the cell's placeholder auth.json.
    expect(proxies.chatgpt?.accountId).toBe('acct-real');
    expect(proxies.chatgpt?.planType).toBe('pro');
    // UPSTREAM + the real tokens travel only via stdin, never argv.
    expect(d.calls.some((c) => c.input?.includes('UPSTREAM=chatgpt'))).toBe(true);
    expect(d.calls.some((c) => c.input?.includes('ACCESS_TOKEN=real-access'))).toBe(true);
    expect(d.calls.some((c) => c.input?.includes('REFRESH_TOKEN=real-refresh'))).toBe(true);
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('real-access');
    expect(flat).not.toContain('real-refresh');
    await proxies.destroy();
    expect(d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
  });

  it('throws SandboxError when a chatgpt credential is proxied without a network', async () => {
    const d = fakeDocker();
    await expect(startProviderProxies({ proxySecrets: { codexChatgpt: REAL_CHATGPT_AUTH }, docker: d.run })).rejects.toBeInstanceOf(SandboxError);
    expect(d.calls).toHaveLength(0);
  });
});

/**
 * End-to-end over the whole ChatGPT-plan path a `--llm-proxy` run actually walks: a real
 * `CODEX_AUTH_JSON` in the host env → providerSecrets → startProviderProxies → the cell's env. The
 * assertion that matters: the cell gets a loadable placeholder auth.json and NOTHING in its env carries
 * a real token.
 */
describe('codex chatgpt credential, host env to cell (proxy mode)', () => {
  const idToken = (claims: unknown): string => `e30.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
  const REAL_ID_TOKEN = idToken({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', email: 'real@example.com' } });
  const hostEnv = {
    CODEX_AUTH_JSON: JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'real-access', refresh_token: 'real-refresh', account_id: 'acct-real', id_token: REAL_ID_TOKEN },
    }),
  } as NodeJS.ProcessEnv;

  it('gives the cell a placeholder auth.json and keeps every real token out of its env', async () => {
    // 1. The real credential is routed to the sidecar bucket, never into the sandbox secrets.
    const { sandboxSecrets, proxySecrets } = providerSecrets(['codex'], hostEnv, { proxyMode: true });
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets.codexChatgpt).toEqual({ accessToken: 'real-access', refreshToken: 'real-refresh', accountId: 'acct-real', planType: 'pro' });

    // 2. The sidecar takes it off-argv (stdin only).
    const d = fakeDocker();
    const proxies = await startProviderProxies({ proxySecrets, network: 'vg-egr-x', docker: d.run });
    expect(d.calls.flatMap((c) => c.args).join(' ')).not.toContain('real-');

    // 3. The cell's env: a placeholder auth.json pointing at that sidecar.
    const env = llmProxySandboxEnv('http://host.docker.internal:1234', undefined, proxies);
    const auth = JSON.parse(env?.CODEX_AUTH_JSON ?? '{}') as {
      auth_mode: string;
      tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string };
    };
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.tokens.access_token).toBe(proxies.chatgpt?.nonce);
    expect(auth.tokens.refresh_token).toBe(proxies.chatgpt?.refreshPlaceholder);
    expect(auth.tokens.id_token.split('.')).toHaveLength(3); // loadable shape; synthetic claims
    expect(auth.tokens.id_token).not.toBe(REAL_ID_TOKEN);
    expect(env?.NO_PROXY).toContain(proxies.chatgpt?.host);

    // No real token anywhere in the cell's env — not in auth.json, not in a base URL, not in the nonce.
    const cellEnv = JSON.stringify(env);
    expect(cellEnv).not.toContain('real-access');
    expect(cellEnv).not.toContain('real-refresh');
    expect(cellEnv).not.toContain(REAL_ID_TOKEN);
    expect(cellEnv).not.toContain('real@example.com');
    await proxies.destroy();
  });
});
