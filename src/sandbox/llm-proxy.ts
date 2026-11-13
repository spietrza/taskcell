import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';
import { startSidecar } from './sidecar.js';
import type { DockerRunner } from './sidecar.js';
import type { ProviderProxySecrets } from '../agents/registry.js';
import type { Upstream } from './llm-proxy-rewrite.mjs';

export type { DockerRunner } from './sidecar.js';

const PROXY_PORT = 8088;
// Its own directory: startSidecar mounts the secret's directory as a dedicated in-RAM tmpfs.
const SECRET_FILE = '/run/vanguard-llm/secret';
// Chatgpt-plan sidecars only: where the sidecar persists its own rotated copy of the real credential
// (resolveUpstream in llm-proxy-server.mjs requires AUTH_FILE to sit inside this same tmpfs
// directory). Never read back by this run — see llm-proxy-server.mjs's persistChatgptAuth doc.
const CHATGPT_AUTH_FILE = '/run/vanguard-llm/auth.json';
// Resolves to dist/sandbox/llm-proxy-server.mjs (built) or src/... (tsx) — next to this module.
const PROXY_SCRIPT = fileURLToPath(new URL('./llm-proxy-server.mjs', import.meta.url));
// Shared pure logic the server imports via a relative `./llm-proxy-rewrite.mjs`; cp'd into the SAME
// /tmp dir so that relative import resolves inside the container.
const PROXY_LOGIC = fileURLToPath(new URL('./llm-proxy-rewrite.mjs', import.meta.url));

/** A fresh credential-shaped token (hyphen-free uuid): the sandbox-facing nonce, the refresh placeholder. */
const randomToken = (): string => randomUUID().replace(/-/g, '');

export interface LlmProxy {
  /** Proxy URL reachable from inside the internal network (by container name). */
  url: string;
  /** Per-run nonce the sandbox presents as ANTHROPIC_AUTH_TOKEN; the proxy validates it. */
  nonce: string;
  /** Sidecar container name (the `vg-llm-<id>` host inside the url) — also the NO_PROXY entry. */
  host: string;
  /** Chatgpt-plan sidecars only: the refresh-grant placeholder credential the cell's generated
   *  auth.json carries as `tokens.refresh_token` (see llm-proxy-rewrite.mjs's REFRESH_PLACEHOLDER). */
  refreshPlaceholder?: string;
  /** Chatgpt-plan sidecars only: the real account id, passed straight through (not a secret) so the
   *  cell's placeholder auth.json and synthetic id_token can be built without re-decoding the real one. */
  accountId?: string;
  /** Chatgpt-plan sidecars only: the real plan type, same rationale as accountId. */
  planType?: string;
  destroy: () => Promise<void>;
}

/** The per-source LLM-proxy wiring threaded into a runner when `--llm-proxy` is active. */
export interface LlmProxyDep {
  /** Proxy URL the sandbox uses as ANTHROPIC_BASE_URL. */
  url: string;
  /** Per-run nonce the sandbox presents as ANTHROPIC_AUTH_TOKEN. */
  nonce: string;
  /** Sidecar container name (added to NO_PROXY so the sandbox reaches it directly). */
  host: string;
}

/** The chatgpt sidecar's wiring: LlmProxyDep plus the extra fields `llmProxySandboxEnv` needs to
 *  assemble the cell's generated placeholder auth.json. */
export interface ChatgptProxyDep extends LlmProxyDep {
  refreshPlaceholder: string;
  accountId: string;
  planType: string;
}

/** The real ChatGPT-plan credential fields startLlmProxy needs to front the subscription — the shape
 *  `ChatgptProxyAuth` (from agents/registry.ts) is handed in as, tagged so the auth union discriminates. */
export interface ChatgptSidecarAuth {
  kind: 'chatgpt';
  accessToken: string;
  refreshToken: string;
  accountId: string;
  planType: string;
}

/**
 * Starts the trusted LLM reverse-proxy sidecar holding the real provider credential. Serves either
 * the Anthropic or OpenAI upstream depending on `opts.upstream` (default `'anthropic'`); for OpenAI
 * the real OpenAI key is the `auth.secret`. The sidecar runs on the default bridge (has internet) and
 * is also joined to the given internal enclave network so the sandbox can reach it by name. The real
 * secret reaches the sidecar ONLY via stdin into an in-RAM tmpfs file (umask 077) — never via `-e` or
 * argv, so `docker inspect` cannot reveal it. The sandbox authenticates with the returned per-run
 * nonce; the proxy swaps in the real auth upstream.
 */
export async function startLlmProxy(opts: {
  network: string;
  auth: { mode: 'subscription' | 'api'; secret: string } | ChatgptSidecarAuth;
  upstream?: Upstream;
  image?: string;
  docker?: DockerRunner;
}): Promise<LlmProxy> {
  const upstream: Upstream = opts.upstream ?? 'anthropic';
  const id = randomUUID().slice(0, 8);
  const name = `vg-llm-${id}`;
  const nonce = randomToken();
  const auth = opts.auth;
  // Chatgpt-plan sidecars carry the real access/refresh/account/plan fields instead of a single
  // SECRET, plus a second placeholder (REFRESH_PLACEHOLDER) the cell's refresh/revoke calls present —
  // see llm-proxy-rewrite.mjs's resolveUpstream for the shape this is read back into.
  let secretBody: string;
  let chatgptFields: Pick<ChatgptProxyDep, 'refreshPlaceholder' | 'accountId' | 'planType'> | undefined;
  if ('kind' in auth) {
    const refreshPlaceholder = randomToken();
    secretBody = `UPSTREAM=${upstream}\nNONCE=${nonce}\nACCESS_TOKEN=${auth.accessToken}\nREFRESH_TOKEN=${auth.refreshToken}\nACCOUNT_ID=${auth.accountId}\nPLAN_TYPE=${auth.planType}\nREFRESH_PLACEHOLDER=${refreshPlaceholder}\nAUTH_FILE=${CHATGPT_AUTH_FILE}\n`;
    chatgptFields = { refreshPlaceholder, accountId: auth.accountId, planType: auth.planType };
  } else {
    secretBody = `MODE=${auth.mode}\nSECRET=${auth.secret}\nNONCE=${nonce}\nUPSTREAM=${upstream}\n`;
  }
  try {
    // The existing reapContainers (label vanguard.runId) already reaps this sidecar on gc — no gc change.
    const sidecar = await startSidecar({
      name,
      runId: id,
      ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      // Sidecar on the default bridge (has internet), then also joined to the internal enclave network.
      network: opts.network,
      files: [
        { src: PROXY_SCRIPT, dest: '/tmp/llm-proxy.mjs' },
        // The shared logic must sit next to the server so its relative import resolves.
        { src: PROXY_LOGIC, dest: '/tmp/llm-proxy-rewrite.mjs' },
      ],
      // The real secret reaches the sidecar ONLY via stdin into an in-RAM file (umask 077).
      secret: { path: SECRET_FILE, body: secretBody },
      env: { LLM_PROXY_SECRET_FILE: SECRET_FILE, PORT: String(PROXY_PORT) },
      cmd: ['node', '/tmp/llm-proxy.mjs'],
    });
    return {
      url: `http://${name}:${PROXY_PORT}`,
      nonce,
      host: name,
      ...chatgptFields,
      destroy: sidecar.destroy,
    };
  } catch (cause) {
    // The sidecar runs the sandbox image (startSidecar's default), so a missing/stale build is the
    // common cause — name it instead of leaving a bare container id for the user to puzzle over.
    throw new SandboxError(
      `Failed to start llm proxy ${id}: rebuild the sandbox image (docker/build.sh builds taskcell-sandbox:latest), or check TASKCELL_SANDBOX_IMAGE if set.`,
      { cause },
    );
  }
}

/** The per-run provider-sidecar handles plus a single teardown for whatever was started. */
export interface ProviderProxies {
  /** OpenAI/Codex API-key sidecar dep, present only when a Codex API key was proxied. */
  openai?: LlmProxyDep;
  /** Codex ChatGPT-plan sidecar dep, present only when a chatgpt-plan credential was proxied.
   *  Mutually exclusive with `openai`: `providerSecrets` routes a given run's codex credential to
   *  at most one of `proxySecrets.codex` / `proxySecrets.codexChatgpt`. */
  chatgpt?: ChatgptProxyDep;
  /** Tear down every sidecar started here. Safe to call when none were started. */
  destroy: () => Promise<void>;
}

/** The provider-sidecar handles alone (ProviderProxies minus its teardown) — what the sandbox env is
 *  built from, so `llmProxySandboxEnv` takes the whole set rather than one positional dep per sidecar. */
export type ProviderProxyDeps = Omit<ProviderProxies, 'destroy'>;

/**
 * Start the per-run provider proxy sidecars implied by `proxySecrets` (from SelectedAgents): an OpenAI
 * upstream sidecar when a Codex API key was proxied, and/or a chatgpt upstream sidecar when a Codex
 * ChatGPT-plan credential was proxied (Codex in --llm-proxy mode, either way). This is the one place
 * that maps a proxied provider credential to its sidecar, so adding a future proxyable provider is
 * local to here. The real credential reaches each sidecar only via startLlmProxy's stdin tmpfs
 * delivery — never the sandbox. Requires the enclave `network` when either is present; throws a clear
 * SandboxError otherwise.
 */
export async function startProviderProxies(opts: {
  /** Proxied provider keys held by sidecars (from SelectedAgents.proxySecrets). */
  proxySecrets: ProviderProxySecrets;
  network?: string;
  image?: string;
  docker?: DockerRunner;
}): Promise<ProviderProxies> {
  const openaiKey = opts.proxySecrets.codex;
  const chatgptAuth = opts.proxySecrets.codexChatgpt;
  if (openaiKey === undefined && chatgptAuth === undefined) {
    return { destroy: async (): Promise<void> => {} };
  }
  if (opts.network === undefined) {
    throw new SandboxError('Codex provider proxy needs the egress enclave network');
  }
  const extra = {
    ...(opts.image !== undefined ? { image: opts.image } : {}),
    ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
  };
  const destroys: Array<() => Promise<void>> = [];
  let openai: LlmProxyDep | undefined;
  let chatgpt: ChatgptProxyDep | undefined;
  if (openaiKey !== undefined) {
    const proxy = await startLlmProxy({ network: opts.network, auth: { mode: 'api', secret: openaiKey }, upstream: 'openai', ...extra });
    openai = { url: proxy.url, nonce: proxy.nonce, host: proxy.host };
    destroys.push(proxy.destroy);
  }
  if (chatgptAuth !== undefined) {
    const proxy = await startLlmProxy({ network: opts.network, auth: { kind: 'chatgpt', ...chatgptAuth }, upstream: 'chatgpt', ...extra });
    const { refreshPlaceholder, accountId, planType } = proxy;
    if (refreshPlaceholder === undefined || accountId === undefined || planType === undefined) {
      // Unreachable: startLlmProxy fills these for every 'chatgpt' auth. Checked rather than cast so a
      // future refactor fails HERE, at dispatch, instead of silently handing the cell an auth.json with
      // no usable refresh placeholder in it.
      await proxy.destroy();
      for (const d of destroys) await d();
      throw new SandboxError('ChatGPT provider proxy did not return its placeholder credential wiring');
    }
    chatgpt = { url: proxy.url, nonce: proxy.nonce, host: proxy.host, refreshPlaceholder, accountId, planType };
    destroys.push(proxy.destroy);
  }
  return {
    ...(openai !== undefined ? { openai } : {}),
    ...(chatgpt !== undefined ? { chatgpt } : {}),
    destroy: async (): Promise<void> => {
      for (const d of destroys) await d();
    },
  };
}
