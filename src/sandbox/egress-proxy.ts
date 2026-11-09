import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ChatgptProxyDep, LlmProxyDep, ProviderProxyDeps } from './llm-proxy.js';
import { SandboxError } from '../core/errors.js';
// Single source of the allow semantics + default allowlist: the same plain-ESM `.mjs` the sidecar
// imports (see egress-allow.mjs). Re-exported below so existing import sites keep working.
import { isAllowed, DEFAULT_EGRESS_ALLOWLIST, resolveConnectTarget, connectOptions } from './egress-allow.mjs';
import { UPSTREAMS, buildCodexAuthJson, CODEX_REFRESH_PATH, CODEX_REVOKE_PATH } from './llm-proxy-rewrite.mjs';

export { isAllowed, DEFAULT_EGRESS_ALLOWLIST };

export interface EgressProxy {
  port: number;
  /** Proxy URL as seen from inside the sandbox (the host is reachable as host.docker.internal). */
  url: string;
  close: () => Promise<void>;
}

/**
 * Sandbox env that routes HTTP(S) through the egress proxy (localhost stays direct). NODE_USE_ENV_PROXY
 * makes Node 24's fetch/undici honor the proxy too, so the agent's own API traffic is covered in the
 * hard (internal-network) enclave, not just shell tools.
 */
export function egressEnv(proxyUrl: string, opts: { noProxy?: readonly string[] } = {}): Record<string, string> {
  const noProxy = ['localhost', '127.0.0.1', ...(opts.noProxy ?? [])].join(',');
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    // Lowercase variants: some CLIs (curl, git) only read these.
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
    // npm/pnpm route through their own config, not the HTTPS_PROXY env, so set it explicitly. Without
    // this, `pnpm install` (e.g. the Proof of Work verify command) cannot reach the registry under the
    // hard egress enclave even though registry.npmjs.org is allowlisted.
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
  };
}

/**
 * The cell's wiring for a ChatGPT-plan Codex run under --llm-proxy: the sidecar's per-run nonce as the
 * model-call credential, its base URL bare (no `/v1` — the sidecar's inbound model path is
 * `/responses`), the IdP overrides that send the CLI's refresh and logout at the sidecar instead of
 * auth.openai.com, and a placeholder `auth.json` carrying ONLY values that are safe inside the sandbox:
 * the nonce as `access_token`, the run-bound refresh placeholder as `refresh_token`, and a synthetic
 * `id_token` built from the (non-secret) account id + plan type. The real access/refresh/id tokens never
 * leave the sidecar: model calls authenticate with the nonce via the provider's `env_key`, and
 * refresh/revoke hit the sidecar's own IdP routes, which swap the placeholder for the real grant.
 */
function chatgptSandboxEnv(chatgptProxy: ChatgptProxyDep): Record<string, string> {
  const { url, nonce, refreshPlaceholder, accountId, planType } = chatgptProxy;
  return {
    OPENAI_API_KEY: nonce,
    VANGUARD_OPENAI_BASE_URL: url,
    CODEX_AUTH_JSON: buildCodexAuthJson(nonce, refreshPlaceholder, accountId, planType),
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${url}${CODEX_REFRESH_PATH}`,
    CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${url}${CODEX_REVOKE_PATH}`,
  };
}

/**
 * Build the sandbox env for a runner: undefined when there's no egress proxy (direct mode); otherwise
 * the egress proxy vars, plus — when an LLM-proxy sidecar owns Claude — its host in NO_PROXY and the
 * ANTHROPIC_BASE_URL/AUTH_TOKEN that point Claude at the sidecar with the per-run nonce (never the real
 * secret). `providerProxies` adds the per-provider sidecars (from startProviderProxies), each of which
 * puts its host in NO_PROXY too:
 * - `openai` (Codex on an API key under --llm-proxy): OPENAI_API_KEY (the per-run nonce, not the real
 *   key) + VANGUARD_OPENAI_BASE_URL pointing CodexProvider at the sidecar's `/v1`.
 * - `chatgpt` (Codex on a ChatGPT plan under --llm-proxy): the nonce, base URL, placeholder
 *   CODEX_AUTH_JSON and IdP overrides of `chatgptSandboxEnv` above. The real credential stays in the
 *   sidecar.
 * The sidecars are independent (and `openai`/`chatgpt` are mutually exclusive — providerSecrets routes a
 * run's codex credential to at most one); any, all, or none may be present alongside the egress proxy.
 * Single source for the nested ternary the runners used to duplicate.
 *
 * @throws SandboxError when a ChatGPT-plan sidecar holds the credential but there is no egress proxy to
 * wire the cell into — the cell would get no credential at all, so fail at dispatch instead of silently.
 */
export function llmProxySandboxEnv(
  proxyUrl: string | undefined,
  llmProxy: LlmProxyDep | undefined,
  providerProxies: ProviderProxyDeps = {},
): Record<string, string> | undefined {
  const { openai: openaiProxy, chatgpt: chatgptProxy } = providerProxies;
  if (proxyUrl === undefined) {
    if (chatgptProxy !== undefined) {
      throw new SandboxError('Codex ChatGPT-plan proxy needs the egress enclave to reach the sandbox');
    }
    return undefined;
  }
  const noProxy = [llmProxy?.host, openaiProxy?.host, chatgptProxy?.host].filter((h): h is string => h !== undefined);
  return {
    ...egressEnv(proxyUrl, noProxy.length > 0 ? { noProxy } : {}),
    ...(llmProxy !== undefined ? { ANTHROPIC_BASE_URL: llmProxy.url, ANTHROPIC_AUTH_TOKEN: llmProxy.nonce } : {}),
    // Neither codex nonce is secret — each only authenticates against its own sidecar, never upstream.
    ...(openaiProxy !== undefined ? { OPENAI_API_KEY: openaiProxy.nonce, VANGUARD_OPENAI_BASE_URL: `${openaiProxy.url}/v1` } : {}),
    ...(chatgptProxy !== undefined ? chatgptSandboxEnv(chatgptProxy) : {}),
  };
}

/** Returns the allowlist minus exact matches of `host` (e.g. drop api.anthropic.com when a trusted sidecar owns it). */
export function allowlistWithout(list: readonly string[], host: string): string[] {
  return list.filter((entry) => entry !== host);
}

/** Upstream API hosts owned by trusted sidecars in --llm-proxy mode — removed from the sandbox allowlist
 *  (the sidecars reach these directly; the sandbox reaches the sidecars by name via NO_PROXY). Derived
 *  from the single UPSTREAMS source so adding an upstream there drops its host from the allowlist too. */
export const LLM_PROXY_UPSTREAM_HOSTS = Object.values(UPSTREAMS).map((u) => u.host);

/** The sandbox egress allowlist under --llm-proxy: the base allowlist minus every sidecar-owned upstream host. */
export function llmProxyEgressAllowlist(base: readonly string[] = DEFAULT_EGRESS_ALLOWLIST): string[] {
  return LLM_PROXY_UPSTREAM_HOSTS.reduce<string[]>((list, host) => allowlistWithout(list, host), [...base]);
}

/**
 * A forward proxy that only tunnels HTTPS CONNECT to allowlisted domains (others get 403). Phase 1
 * (soft) egress control: point the sandbox's HTTPS_PROXY at this. It does not block a sandbox that
 * bypasses the proxy — kernel-level enforcement is phase 2.
 */
export async function startEgressProxy(
  opts: { allowlist?: readonly string[]; trusted?: readonly string[]; port?: number } = {},
): Promise<EgressProxy> {
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const trusted = (opts.trusted ?? []).map((h) => h.toLowerCase());
  const server = createServer((_req, res) => {
    res.writeHead(405).end('This proxy only supports HTTPS CONNECT.');
  });

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    // Same rule as the enclave sidecar: port 443, public addresses, unless the host is trusted.
    resolveConnectTarget(req.url ?? '', allowlist, trusted).then((dest) => {
      if (dest === undefined) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      if (clientSocket.destroyed) return;
      const upstream = connect(connectOptions(dest), () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    }, () => clientSocket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://host.docker.internal:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
