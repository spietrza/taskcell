// The Hub's fallback chain (Settings → Line → Cell): the ordered providers/models a run moves to when the Engine hits a
// provider limit. Resolved server-side at every Hub start point and handed to the engine as `--fallback-provider` /
// `--fallback-model` values — the engine's own routing, cooldowns and park logic do the rest (no second mechanism).
import { PROVIDER_NAMES as REGISTRY_PROVIDERS, assertEgressCompatible, claudeCliKeyEnv, validateProviderChoice } from '../agents/registry.js';
import { loadCustomProviders, type CustomProviderEntry } from '../agents/custom.js';
import { FALLBACK_CHAIN_MAX, fallbackChainErrors, type FallbackEntry, type RunCredential } from '../wire.js';
import type { AppConfig } from './app-config.js';
import type { HubUser } from './auth.js';
import { PROVIDER_NAMES, type CredentialService } from './credentials.js';
import { listTeams } from './teams.js';

export type { FallbackEntry };

/** The team default of the repository: the one team that lists it and sets a chain (none when two teams disagree). */
async function teamChain(configDir: string | undefined, repoPath: string): Promise<FallbackEntry[] | undefined> {
  if (configDir === undefined) return undefined;
  const holding = (await listTeams(configDir).catch(() => [])).filter((t) => t.repositories.includes(repoPath) && Array.isArray(t.fallbackChain));
  return holding.length === 1 ? holding[0]!.fallbackChain : undefined;
}

/**
 * The chain a run of this project uses: the project's own `fallbackChain` (including `[]` = none), else the team default.
 * Malformed or unknown entries are dropped silently — a hand-edited `app.json` must never fail a run. A lone entry the
 * Engine cannot pair with stays: the run drops it with a warning (see {@link loneEntryRefused}).
 */
export async function resolveFallbackChain(configDir: string | undefined, repoPath: string, cfg: AppConfig): Promise<{ chain: FallbackEntry[]; source: 'project' | 'team' | 'none' }> {
  const own = Array.isArray(cfg.fallbackChain) ? cfg.fallbackChain : undefined;
  const raw = own ?? (await teamChain(configDir, repoPath));
  if (raw === undefined || raw.length === 0) return { chain: [], source: own !== undefined ? 'project' : 'none' };
  const primary = typeof cfg.provider === 'string' && cfg.provider.trim() !== '' ? cfg.provider : 'claude';
  const customs = (await loadCustomProviders(repoPath).catch(() => [])).filter((c) => c.error === undefined && c.name !== undefined).map((c) => c.name!);
  const providers = [...REGISTRY_PROVIDERS, ...customs];
  const { rows } = fallbackChainErrors(raw, { primary, providers });
  const chain = raw.length > FALLBACK_CHAIN_MAX ? [] : raw.filter((_, i) => rows[i] === undefined).map((e) => ({ provider: e.provider, ...(typeof e.model === 'string' && e.model !== '' ? { model: e.model } : {}) }));
  return { chain, source: chain.length === 0 ? (own !== undefined ? 'project' : 'none') : own !== undefined ? 'project' : 'team' };
}

/**
 * True for a lone entry one sandbox cannot host next to the Engine: the Engine itself, or a provider on its transport slot
 * (claude → zai / openrouter). The engine pairs a single fallback in-run and refuses those; a list of two or more is routed per run.
 */
export async function loneEntryRefused(chain: readonly FallbackEntry[], repoPath: string, provider: string | undefined): Promise<boolean> {
  if (chain.length !== 1) return false;
  const customProviders = await loadCustomProviders(repoPath).catch(() => []);
  try {
    validateProviderChoice({ ...(provider !== undefined ? { provider } : {}), fallbackProvider: chain[0]!.provider, ...(customProviders.length > 0 ? { customProviders } : {}) });
    return false;
  } catch {
    return true;
  }
}

/** `--fallback-provider` / `--fallback-model` values for a chain (a model slot may be empty; all-empty models are omitted). */
export function fallbackFlags(chain: readonly FallbackEntry[]): { fallbackProvider?: string; fallbackModel?: string } {
  if (chain.length === 0) return {};
  const models = chain.map((e) => e.model ?? '');
  return { fallbackProvider: chain.map((e) => e.provider).join(','), ...(models.some((m) => m !== '') ? { fallbackModel: models.join(',') } : {}) };
}

/** A repo custom's key env names; none for an unknown name or a keyless custom. */
export function keyEnvOf(name: string, customs: Parameters<typeof claudeCliKeyEnv>[1]): readonly string[] {
  try {
    return claudeCliKeyEnv(name, customs) ?? [];
  } catch {
    return [];
  }
}

/** The repo's custom providers, loaded only when the chain names one. */
async function chainCustoms(chain: readonly FallbackEntry[], repoPath: string): Promise<CustomProviderEntry[]> {
  return chain.some((e) => !(e.provider in PROVIDER_NAMES)) ? await loadCustomProviders(repoPath).catch(() => []) : [];
}

/** False for a plain-http custom: a Hub run is always-egress, and its CONNECT-only proxy cannot reach one. */
function egressOk(name: string, customs: Parameters<typeof claudeCliKeyEnv>[1]): boolean {
  try {
    assertEgressCompatible({ provider: name, ...(customs !== undefined && customs.length > 0 ? { customProviders: customs } : {}) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the entries a run can fund: a provider with a key in the run's credential (or, for an instance credential or none,
 * in the hub's own environment) and an endpoint the egress proxy can reach (`unreachable`: plain-http customs). A `user` run
 * never borrows the instance's keys. Dropped entries are named for a warning.
 */
export async function fundableChain(chain: readonly FallbackEntry[], repoPath: string, credential: RunCredential | undefined, hostEnv: NodeJS.ProcessEnv = process.env): Promise<{ kept: FallbackEntry[]; dropped: string[]; unreachable: string[] }> {
  if (chain.length === 0) return { kept: [], dropped: [], unreachable: [] };
  const customs = await chainCustoms(chain, repoPath);
  const hostFunds = credential === undefined || credential.source === 'instance';
  const has = (name: string): boolean => (credential?.env[name] ?? '') !== '' || (hostFunds && (hostEnv[name] ?? '') !== '');
  const kept: FallbackEntry[] = [];
  const dropped: string[] = [];
  const unreachable: string[] = [];
  for (const e of chain) {
    const label = e.model !== undefined ? `${e.provider}/${e.model}` : e.provider;
    const names = PROVIDER_NAMES[e.provider] ?? keyEnvOf(e.provider, customs);
    if (!names.some(has)) dropped.push(label);
    else if (!egressOk(e.provider, customs)) unreachable.push(label);
    else kept.push(e);
  }
  return { kept, dropped, unreachable };
}

/**
 * What a Hub start point needs: the run's credential (the chain providers' stored keys ride along; the source is still the
 * primary's) and the `fallbackProvider`/`fallbackModel` params to spread into the run. `deps.createRun` drops the entries
 * the credential cannot fund, with a warning, so a chain entry never refuses a run.
 */
export async function chainForRun(opts: { configDir: string; repoPath: string; cfg: AppConfig; user: HubUser | undefined; provider: string | undefined; credentials: CredentialService | undefined }): Promise<{ credential: RunCredential | undefined; flags: { fallbackProvider?: string; fallbackModel?: string } }> {
  // The Engine is the provider this run starts with: a client may pick one other than the saved default.
  const cfg = opts.provider !== undefined ? { ...opts.cfg, provider: opts.provider } : opts.cfg;
  const { chain } = await resolveFallbackChain(opts.configDir, opts.repoPath, cfg);
  if (opts.credentials === undefined) return { credential: undefined, flags: fallbackFlags(chain) };
  // A repo custom's key names, so a funded custom counts when every stored account is cooling (and its key rides along).
  const customs = await chainCustoms(chain, opts.repoPath);
  const customKeys = Object.fromEntries(chain.filter((e) => !(e.provider in PROVIDER_NAMES)).map((e) => [e.provider, keyEnvOf(e.provider, customs)]));
  const credential = await opts.credentials.resolveForRun(opts.user, opts.provider, chain.map((e) => e.provider), customKeys);
  return { credential, flags: fallbackFlags(chain) };
}
