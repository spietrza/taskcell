// The Hub's fallback chain (Settings → Line → Cell): the ordered providers/models a run moves to when the Engine hits a
// provider limit. Resolved server-side at every Hub start point and handed to the engine as `--fallback-provider` /
// `--fallback-model` values — the engine's own routing, cooldowns and park logic do the rest (no second mechanism).
import { PROVIDER_NAMES as REGISTRY_PROVIDERS, claudeCliKeyEnv } from '../agents/registry.js';
import { loadCustomProviders } from '../agents/custom.js';
import { fallbackChainErrors, type FallbackEntry, type RunCredential } from '../wire.js';
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
 * Malformed or unknown entries are dropped silently — a hand-edited `app.json` must never fail a run.
 */
export async function resolveFallbackChain(configDir: string | undefined, repoPath: string, cfg: AppConfig): Promise<{ chain: FallbackEntry[]; source: 'project' | 'team' | 'none' }> {
  const own = Array.isArray(cfg.fallbackChain) ? cfg.fallbackChain : undefined;
  const raw = own ?? (await teamChain(configDir, repoPath));
  if (raw === undefined || raw.length === 0) return { chain: [], source: own !== undefined ? 'project' : 'none' };
  const primary = typeof cfg.provider === 'string' && cfg.provider.trim() !== '' ? cfg.provider : 'claude';
  const customs = (await loadCustomProviders(repoPath).catch(() => [])).filter((c) => c.error === undefined && c.name !== undefined).map((c) => c.name!);
  const providers = [...REGISTRY_PROVIDERS, ...customs];
  const { rows, list } = fallbackChainErrors(raw, { primary, providers });
  const clean = list === undefined ? raw.filter((_, i) => rows[i] === undefined).map((e) => ({ provider: e.provider, ...(typeof e.model === 'string' && e.model !== '' ? { model: e.model } : {}) })) : [];
  // Dropping rows can leave a lone entry on the Engine's own provider, which the engine refuses; nothing then.
  const chain = clean.length === 1 && clean[0]!.provider === primary ? [] : clean;
  return { chain, source: chain.length === 0 ? (own !== undefined ? 'project' : 'none') : own !== undefined ? 'project' : 'team' };
}

/** `--fallback-provider` / `--fallback-model` values for a chain (a model slot may be empty; all-empty models are omitted). */
export function fallbackFlags(chain: readonly FallbackEntry[]): { fallbackProvider?: string; fallbackModel?: string } {
  if (chain.length === 0) return {};
  const models = chain.map((e) => e.model ?? '');
  return { fallbackProvider: chain.map((e) => e.provider).join(','), ...(models.some((m) => m !== '') ? { fallbackModel: models.join(',') } : {}) };
}

/** A repo custom's key env names; none for an unknown name or a keyless custom. */
function keyEnvOf(name: string, customs: Parameters<typeof claudeCliKeyEnv>[1]): readonly string[] {
  try {
    return claudeCliKeyEnv(name, customs) ?? [];
  } catch {
    return [];
  }
}

/**
 * Keep the entries a run can fund: a provider with a key in the run's credential (or, for an instance credential or none,
 * in the hub's own environment). A `user` run never borrows the instance's keys. Dropped entries are named for a warning.
 */
export async function fundableChain(chain: readonly FallbackEntry[], repoPath: string, credential: RunCredential | undefined, hostEnv: NodeJS.ProcessEnv = process.env): Promise<{ kept: FallbackEntry[]; dropped: string[] }> {
  if (chain.length === 0) return { kept: [], dropped: [] };
  const customs = chain.some((e) => !(e.provider in PROVIDER_NAMES)) ? await loadCustomProviders(repoPath).catch(() => []) : [];
  const hostFunds = credential === undefined || credential.source === 'instance';
  const has = (name: string): boolean => (credential?.env[name] ?? '') !== '' || (hostFunds && (hostEnv[name] ?? '') !== '');
  const kept: FallbackEntry[] = [];
  const dropped: string[] = [];
  for (const e of chain) {
    const names = PROVIDER_NAMES[e.provider] ?? keyEnvOf(e.provider, customs);
    if (names.some(has)) kept.push(e);
    else dropped.push(e.model !== undefined ? `${e.provider}/${e.model}` : e.provider);
  }
  return { kept, dropped };
}

/**
 * What a Hub start point needs: the run's credential (the chain providers' stored keys ride along; the source is still the
 * primary's) and the `fallbackProvider`/`fallbackModel` params to spread into the run. `deps.createRun` drops the entries
 * the credential cannot fund, with a warning, so a chain entry never refuses a run.
 */
export async function chainForRun(opts: { configDir: string; repoPath: string; cfg: AppConfig; user: HubUser | undefined; provider: string | undefined; credentials: CredentialService | undefined }): Promise<{ credential: RunCredential | undefined; flags: { fallbackProvider?: string; fallbackModel?: string } }> {
  const { chain } = await resolveFallbackChain(opts.configDir, opts.repoPath, opts.cfg);
  const credential = opts.credentials !== undefined ? await opts.credentials.resolveForRun(opts.user, opts.provider, chain.map((e) => e.provider)) : undefined;
  return { credential, flags: fallbackFlags(chain) };
}
