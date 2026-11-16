import { startEgressEnclave } from './egress-network.js';
import { claudeCliKeyEnv, providerUpstream, requiresApiKey } from '../agents/registry.js';
import { CliUsageError } from '../core/errors.js';
import { startLlmProxy } from './llm-proxy.js';
import { llmProxyEgressAllowlist } from './egress-proxy.js';
import { DEFAULT_EGRESS_ALLOWLIST } from './egress-allow.mjs';
import { resolveSandboxProfile } from './limits.js';
import { llmProxyAuth } from '../agents/auth.js';
import type { LlmProxyDep } from './llm-proxy.js';
import type { Upstream } from './llm-proxy-rewrite.mjs';
import type { AgentAuth } from '../agents/auth.js';

/**
 * The sandbox-side wiring shared by `taskcell run` and `taskcell watch`: the egress enclave's proxy
 * URL + network, and (when `--llm-proxy` is active) the trusted LLM-proxy sidecar's url/nonce/host.
 * `destroy()` tears the whole thing down in the right order.
 */
/** Display name for each llm-proxy upstream, used in the sidecar-credential log line. */
const UPSTREAM_LABEL: Record<Upstream, string> = { anthropic: 'Claude', openai: 'OpenAI', zai: 'z.ai', openrouter: 'OpenRouter', chatgpt: 'ChatGPT' };

export interface SandboxContext {
  /** Egress proxy URL the sandbox routes through (absent when no enclave was created). */
  proxyUrl?: string;
  /** Internal docker network the sandbox joins (absent when no enclave was created). */
  network?: string;
  /** LLM-proxy sidecar wiring (absent unless `--llm-proxy`). */
  llmProxy?: LlmProxyDep;
  /**
   * Whether `--llm-proxy` was requested, so providers select in proxy mode. Recorded here, once: it can
   * be true while `llmProxy` is absent (every credential routes to a per-provider sidecar the caller starts).
   */
  proxyMode: boolean;
  destroy: () => Promise<void>;
}

/** The sandbox wiring a session or runner consumes: a {@link SandboxContext} without its teardown. */
export type SandboxWiring = Omit<SandboxContext, 'destroy'>;

/** Options for {@link startSandboxContext}. */
export interface SandboxContextOptions {
  egress: boolean;
  llmProxy: boolean;
  /**
   * The primary sidecar's credential. For Anthropic (default) this is the Claude subscription/API auth;
   * for Zai/OpenRouter it is the provider key carried as an api-mode auth. Absent when no
   * Anthropic-family credential is needed (under --llm-proxy that is an error unless `skipPrimarySidecar`).
   */
  auth?: AgentAuth;
  /** Provider whose primary LLM sidecar to start under --llm-proxy (default 'claude' → Anthropic).
   *  Widened to string for S6 customs — they never reach the llm-proxy branch (directOnly rejects
   *  the combination at dispatch) and direct mode returns before reading this. */
  provider?: string;
  /** `--llm-proxy` needs no primary sidecar: every credential routes to a sidecar the caller starts itself
   *  (see `llmProxyNeedsNoPrimarySidecar`), so a missing `auth` is not an error and none is started. */
  skipPrimarySidecar?: boolean;
  /** Extra egress-enclave allowlist hosts (S6 custom endpoints), computed at dispatch. */
  extraEgressHosts?: string[];
}

/**
 * Provision the sandbox context once for a command. Builds the egress enclave when `egress` or
 * `llmProxy` is set (dropping the sidecar-owned upstream hosts from the allowlist in llm-proxy mode,
 * so the sandbox has no direct route to those providers), and starts the LLM-proxy sidecar on that
 * enclave's network when requested — holding the real provider credential outside the sandbox. The
 * primary sidecar's upstream follows the provider: Anthropic by default, z.ai for `--provider zai`,
 * OpenRouter for `--provider openrouter`. With neither flag, no enclave or env is created and
 * `destroy()` is a no-op.
 */
const llmProxyCredentialError = (provider: string): CliUsageError =>
  new CliUsageError(
    !requiresApiKey(provider) || claudeCliKeyEnv(provider) !== undefined
      ? `llm-proxy needs a primary-sidecar credential for provider "${provider}" (set CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY, ZAI_API_KEY, or OPENROUTER_API_KEY).`
      : `llm-proxy cannot keep provider "${provider}"'s credential out of the sandbox (no sidecar fronts it, or it is missing): run without --llm-proxy.`,
  );

/** Print a `resolveSandboxProfile(...).note` at the level (`warn`/`log`) it asks for. */
const logRootfsNote = (note: { warn: boolean; message: string }): void => (note.warn ? console.warn : console.log)(note.message);

export async function startSandboxContext(opts: SandboxContextOptions): Promise<SandboxContext> {
  // --llm-proxy implies the egress enclave; in that mode the sandbox loses its direct route to the
  // sidecar-owned upstream providers.
  if (!opts.egress && !opts.llmProxy) {
    // A read-only rootfs can be opted into without --egress/--llm-proxy too (TASKCELL_SANDBOX_READONLY=1
    // alone): that run gets no other sandbox-posture log line, so report the decision here as well.
    const profile = resolveSandboxProfile(process.env);
    if (profile.security.readOnlyRootfs) logRootfsNote(profile.note);
    return { proxyMode: false, destroy: async (): Promise<void> => {} };
  }

  // The primary sidecar's upstream follows the provider; the credential comes uniformly from `auth`.
  // Checked before the enclave exists: a throw after startEgressEnclave would leave the network and
  // proxy container behind until `taskcell gc` (a codex/cursor-only run under --llm-proxy hits this).
  const provider = opts.provider ?? 'claude';
  if (opts.llmProxy && opts.auth === undefined && opts.skipPrimarySidecar !== true) throw llmProxyCredentialError(provider);

  // Custom-provider hosts (S6) extend the allowlist here, at enclave creation — the list is baked
  // into the proxy container's env at start, so it cannot be widened later in the run.
  const extras = opts.extraEgressHosts ?? [];
  const baseAllowlist = opts.llmProxy ? llmProxyEgressAllowlist() : DEFAULT_EGRESS_ALLOWLIST;
  const enclave = await startEgressEnclave(
    // Customs are explicitly configured endpoints: exempt them from the 443/public-address rule.
    extras.length > 0 || opts.llmProxy ? { allowlist: [...baseAllowlist, ...extras], ...(extras.length > 0 ? { trusted: extras } : {}) } : {},
  );
  console.log('egress: sandbox confined to an internal network; only the allowlist proxy can reach out.');
  // Hardened: this note only runs on the --egress/--llm-proxy path, the same signal the runners
  // pass when they resolve the profile their sandbox runs under.
  logRootfsNote(resolveSandboxProfile(process.env).note);

  if (!opts.llmProxy) {
    return { proxyUrl: enclave.proxyUrl, network: enclave.network, proxyMode: false, destroy: enclave.destroy };
  }

  if (opts.auth === undefined) {
    // skipPrimarySidecar: the caller starts the per-provider sidecars (Codex's); nothing to hold here.
    return { proxyUrl: enclave.proxyUrl, network: enclave.network, proxyMode: true, destroy: enclave.destroy };
  }
  const upstream: Upstream = providerUpstream(opts.provider);
  const auth = llmProxyAuth(opts.auth);
  // startLlmProxy fails closed on any docker error; the enclave created above is this function's to
  // clean up, or its network and proxy container would survive until `taskcell gc`.
  let llmProxy: Awaited<ReturnType<typeof startLlmProxy>>;
  try {
    llmProxy = await startLlmProxy({ network: enclave.network, auth, ...(upstream === 'anthropic' ? {} : { upstream }) });
  } catch (cause) {
    await enclave.destroy();
    throw cause;
  }
  console.log(`llm-proxy: ${UPSTREAM_LABEL[upstream]} credential held in a trusted sidecar; the sandbox sees only a per-run nonce.`);

  return {
    proxyUrl: enclave.proxyUrl,
    network: enclave.network,
    llmProxy: { url: llmProxy.url, nonce: llmProxy.nonce, host: llmProxy.host },
    proxyMode: true,
    // Destroy the llm-proxy before the enclave (it lives on the enclave's network).
    destroy: async (): Promise<void> => {
      await llmProxy.destroy();
      await enclave.destroy();
    },
  };
}
