import { DockerSandboxProvider, sandboxImage } from '../sandbox/docker.js';
import { pnpmStoreConfig, sandboxNetworkConfig } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { authSecrets } from '../agents/auth.js';
import { providerKeyEnvNames, selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/taskcell.js';
import { enforceUsageCap } from '../core/usage-cap.js';
import { injectedSecretValues } from '../core/secret-scan.js';
import { cooldownUntil, entryKey, recordCooldown } from '../core/model-pool.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, SelectedAgents } from '../agents/registry.js';
import type { RunContext, PrepareOptions, RunDeps } from '../core/taskcell.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { ProviderProxyDeps } from '../sandbox/llm-proxy.js';
import type { SandboxWiring } from '../sandbox/sandbox-context.js';

type PoolEntry = { provider: string; model?: string };

/** The credentials one run reads its provider keys from and redacts, built once at run start. */
export interface RunCredentialContext {
  /** Which kind of credential funded the run; undefined outside the hub. */
  source: 'instance' | 'user' | undefined;
  /** Env every provider key is read from: a hub run's resolved credential env, else process.env. */
  env: NodeJS.ProcessEnv;
  /** Env var names of keys the static injected-secret list cannot know (a custom provider's `keyEnv`). */
  keyEnvNames: string[];
  /** Every credential value to mask: the run env's and the host's (a user run's env omits the host keys). */
  secretValues: () => string[];
}

/** What a run's credential context is built from. */
export type CredentialDeps = ProviderChoice & {
  /** Which kind of credential funded the run (hub per-user credentials). */
  credentialSource?: 'instance' | 'user';
  /** The user-given name of the stored credential that funds the run (never the value). */
  credentialName?: string;
  /** Hub: rotation across the provider's stored accounts; a limit on one moves the run to the next. */
  credentialRotation?: { provider: string; hasNext(): Promise<boolean> };
  /** Hub: this run's account hit a limit that a stage fallback rescued — cool it until `until`. */
  onCredentialCooled?: (until: Date) => Promise<void>;
  /** Hub: a stored Codex account's refreshed auth.json (seen at the ChatGPT sidecar's teardown), to save back to that account only. Resolves true when saved. */
  onCredentialRotated?: (originalRefreshToken: string, authJson: string) => Promise<boolean>;
  /** Env the provider keys are read from (default process.env): a hub run's resolved credential env. */
  providerEnv?: NodeJS.ProcessEnv;
};

/** Build a run's {@link RunCredentialContext} from its deps. */
export function runCredentialContext(deps: CredentialDeps): RunCredentialContext {
  const env = deps.providerEnv ?? process.env;
  const keyEnvNames = providerKeyEnvNames(deps);
  return {
    source: deps.credentialSource,
    env,
    keyEnvNames,
    secretValues: () => [...new Set([...injectedSecretValues(env, keyEnvNames), ...injectedSecretValues(process.env, keyEnvNames)])],
  };
}

export interface AgentSessionOptions {
  /** Provider selection (provider, fallback, review provider, customs, credential source/env). */
  choice: CredentialDeps;
  /** Local repo: keys the pnpm store volume. */
  repoPath: string;
  auth?: AgentAuth;
  /** The egress enclave, llm-proxy sidecar and proxy mode from `startSandboxContext`; absent = direct mode. */
  sandboxContext?: SandboxWiring;
  /**
   * Where the usage cap is enforced. 'open' (default): refuse to open when the provider is capped, for
   * callers with one agent and no fallback. 'stages': leave it to runStages, which checks before each stage
   * and lets a fallback provider (or the next pool entry) take over for a capped primary.
   */
  usageCap?: 'open' | 'stages';
  /** `--pnpm-store` (TASKCELL_PNPM_STORE also enables it). */
  pnpmStore?: boolean;
  /** Extra sandbox secrets merged in before the agent's own (e.g. LINEAR_API_KEY). */
  secrets?: Record<string, string>;
  /** Selection override for tests: skips selectAgents (and its credential checks) and starts no sidecar. */
  agents?: SelectedAgents;
  /** Sandbox override for tests. */
  sandbox?: IsolatedSandboxProvider;
  /** Sandbox factory for tests; receives the secrets the real sandbox would get. */
  sandboxFactory?: (secrets: Record<string, string>) => IsolatedSandboxProvider;
}

/** An open agent session: selected agents, their sidecars and sandbox. Call {@link AgentSession.close} on every exit path. */
export interface AgentSession {
  agents: SelectedAgents;
  credentials: RunCredentialContext;
  sandbox: IsolatedSandboxProvider;
  /** Provision the worktree + sandbox for this session; the context is disposed by `close`. */
  prepare(opts: Omit<PrepareOptions, 'sandbox' | 'agentName'>, deps?: RunDeps): Promise<RunContext>;
  /** The context `prepare` returned, if it did. */
  readonly ctx: RunContext | undefined;
  /** Tear down the context (sandbox + worktree) and the provider sidecars. Idempotent. */
  close(): Promise<void>;
}

/** Build the sandbox for a session: Docker, with the session's secrets, env, network and pnpm store. */
export function buildSessionSandbox(
  opts: Pick<AgentSessionOptions, 'repoPath' | 'auth' | 'sandboxContext' | 'pnpmStore'>,
  secrets: Record<string, string>,
  providerProxies: ProviderProxyDeps,
  injectAnthropicAuth: boolean,
): IsolatedSandboxProvider {
  const env = llmProxySandboxEnv(opts.sandboxContext?.proxyUrl, opts.sandboxContext?.llmProxy, providerProxies);
  const pnpmStore = pnpmStoreConfig(opts.repoPath, opts.pnpmStore);
  return new DockerSandboxProvider({
    image: sandboxImage(),
    // In llm-proxy mode the real Claude secret stays in the sidecar — the sandbox gets only the nonce.
    secrets: {
      ...(opts.sandboxContext?.llmProxy === undefined && opts.auth !== undefined && injectAnthropicAuth ? authSecrets(opts.auth) : {}),
      ...secrets,
    },
    ...(env !== undefined ? { env } : {}),
    ...(pnpmStore !== undefined ? { pnpmStore } : {}),
    ...sandboxNetworkConfig(opts.sandboxContext?.network),
  });
}

/**
 * Open an agent session: select the agents from one credential context, refuse when the provider is at
 * the usage cap (a new agent run is not started then), start the provider sidecars and build the sandbox.
 * Nothing leaks when a step throws: sidecars started so far are destroyed before the error propagates.
 */
export async function openAgentSession(opts: AgentSessionOptions): Promise<AgentSession> {
  const credentials = runCredentialContext(opts.choice);
  const agents: SelectedAgents =
    opts.agents ?? selectAgents(opts.choice, credentials.env, { proxyMode: opts.sandboxContext?.proxyMode === true });
  if (opts.usageCap !== 'stages') enforceUsageCap(agents.agent.name);

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox.
  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    // A hub user's stored credential, or a stored account of any source (it has a save-back): the rotation updates the
    // run's own env and never a host auth file. Any other run (an instance credential, desktop) reports against
    // process.env, so later runs of this process pick up the rotated token.
    ...(credentials.source === 'user' || opts.choice.onCredentialRotated !== undefined ? { env: credentials.env, storedCredential: true } : {}),
    ...(opts.choice.onCredentialRotated !== undefined ? { persistRotated: opts.choice.onCredentialRotated } : {}),
    ...(opts.sandboxContext?.network !== undefined ? { network: opts.sandboxContext.network } : {}),
  });
  let ctx: RunContext | undefined;
  let closed = false;
  try {
    const secrets = { ...(opts.secrets ?? {}), ...agents.secrets };
    const sandbox =
      opts.sandbox ??
      (opts.sandboxFactory !== undefined
        ? opts.sandboxFactory(secrets)
        : buildSessionSandbox(opts, secrets, providerProxies, agents.injectAnthropicAuth));
    return {
      agents,
      credentials,
      sandbox,
      get ctx() {
        return ctx;
      },
      async prepare(prepareOpts, deps) {
        if (ctx !== undefined) throw new Error('agent session already prepared');
        ctx = await prepareContext({ ...prepareOpts, sandbox, agentName: agents.agent.name }, deps);
        return ctx;
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (ctx !== undefined) await disposeContext(ctx);
        } finally {
          await providerProxies.destroy();
        }
      },
    };
  } catch (error) {
    await providerProxies.destroy();
    throw error;
  }
}

/**
 * Pool-entry retry bookkeeping: cool every entry that hit a provider limit (until the reset the error
 * names, else the default hour) so later runs skip it. Best effort: a failed write must not replace the
 * limit error the caller is about to throw. Returns the entry keys cooled.
 */
export async function coolPoolEntries(repoPath: string, entries: readonly PoolEntry[], error: unknown): Promise<string[]> {
  const until = cooldownUntil(error instanceof Error ? error.message : String(error));
  for (const entry of entries) await recordCooldown(repoPath, entry, until).catch(() => undefined);
  return entries.map(entryKey);
}
