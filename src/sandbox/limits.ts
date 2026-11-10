import type { SandboxConfig, SandboxSecurityOpts } from './provider.js';

export type SandboxResourceLimits = Pick<SandboxConfig, 'memoryMb' | 'cpus' | 'pidsLimit'>;

type PnpmStoreConfig = SandboxConfig['pnpmStore'];

/**
 * Env-overridable sandbox resource limits. Defaults: memory 2048 MB, 2 CPUs, 512 pids. Each
 * VANGUARD_SANDBOX_* var overrides its default; set it to "0" (or an invalid/empty value) to OMIT
 * that limit entirely, so no `--memory`/`--cpus`/`--pids-limit` flag is passed. This is required on
 * hosts whose kernel lacks a cgroup — e.g. Synology DSM has no CPU CFS scheduler, so `--cpus` is
 * fatal there and must be disabled with VANGUARD_SANDBOX_CPUS=0.
 */
export function sandboxResourceLimits(env: NodeJS.ProcessEnv = process.env): SandboxResourceLimits {
  const limit = (name: string, fallback: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const memoryMb = limit('VANGUARD_SANDBOX_MEMORY_MB', 2048);
  const cpus = limit('VANGUARD_SANDBOX_CPUS', 2);
  const pidsLimit = limit('VANGUARD_SANDBOX_PIDS', 512);
  return {
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
    ...(pidsLimit !== undefined ? { pidsLimit } : {}),
  };
}

/**
 * `docker run` args capping a sidecar's memory (the egress and llm-proxy proxies). Default 256 MB,
 * overridable with VANGUARD_SIDECAR_MEMORY_MB; "0" (or invalid/empty) omits the cap. These proxies are
 * small node servers, but an unbounded container can still pressure a small host (e.g. a 5.6 GB NAS).
 */
export function sidecarMemoryArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.VANGUARD_SIDECAR_MEMORY_MB;
  const mb = raw === undefined ? 256 : Number(raw);
  return Number.isFinite(mb) && mb > 0 ? ['--memory', `${Math.floor(mb)}m`] : [];
}

/**
 * `--label vanguard.owner=<value>` for every container and network Vanguard creates, when
 * VANGUARD_OWNER_LABEL is set. Lets a CI job tear down exactly its own leftovers in an after_script
 * without touching another job's; the README gives the commands, piped through `xargs -r` so an empty
 * match does not fail.
 * Empty (no flag) when the variable is unset or empty, same as the other sidecar arg helpers here.
 */
export function ownerLabelArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const owner = env.VANGUARD_OWNER_LABEL;
  return owner === undefined || owner === '' ? [] : ['--label', `vanguard.owner=${owner}`];
}

/**
 * Resolve the opt-in persistent pnpm store for one target repo (`--pnpm-store` / VANGUARD_PNPM_STORE;
 * off by default). `cliFlag` is the parsed `--pnpm-store` (undefined when the flag was not passed);
 * VANGUARD_PNPM_STORE=1/true is the env equivalent, so CI can turn it on without touching argv.
 * Disabled (the common case) returns undefined: nothing is mounted and `buildRunArgs` is unchanged.
 * Enabled, with VANGUARD_PNPM_STORE_DIR unset: a named Docker volume keyed by `repoKey` (local/NAS/hub
 * — the volume outlives the container). With VANGUARD_PNPM_STORE_DIR set: that host directory is
 * bind-mounted instead (the CI shape — GitHub-hosted runners are fresh, so a volume would never
 * survive between runs; `actions/cache` restores/saves that directory around the job instead — see
 * docs/cli.md for why only the pre-agent baseline install may save it).
 */
export function pnpmStoreConfig(
  repoKey: string,
  cliFlag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PnpmStoreConfig {
  const enabled = cliFlag === true || env.VANGUARD_PNPM_STORE === '1' || env.VANGUARD_PNPM_STORE === 'true';
  if (!enabled) return undefined;
  const hostDir = env.VANGUARD_PNPM_STORE_DIR;
  return hostDir !== undefined && hostDir !== '' ? { repoKey, hostDir } : { repoKey };
}

/**
 * Env-overridable sandbox hardening. Unlike the resource limits above, these default ON for every
 * sandbox (least-privilege by default) and are overridable per the same "0"/empty ⇒ disable idiom.
 */
export function sandboxSecurityOpts(env: NodeJS.ProcessEnv = process.env): SandboxSecurityOpts {
  const list = (raw: string | undefined, fallback: string[]): string[] =>
    raw === undefined
      ? fallback
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  const flag = (raw: string | undefined, fallback: boolean): boolean =>
    raw === undefined ? fallback : !(raw === '0' || raw === '');
  return {
    capDrop: list(env.VANGUARD_SANDBOX_CAP_DROP, ['ALL']),
    capAdd: list(env.VANGUARD_SANDBOX_CAP_ADD, ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']),
    noNewPrivileges: flag(env.VANGUARD_SANDBOX_NO_NEW_PRIVILEGES, true),
    readOnlyRootfs: flag(env.VANGUARD_SANDBOX_READONLY, false),
  };
}
