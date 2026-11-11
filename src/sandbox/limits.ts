import type { SandboxConfig, SandboxSecurityOpts } from './provider.js';

export type SandboxResourceLimits = Pick<SandboxConfig, 'memoryMb' | 'cpus' | 'pidsLimit'>;

type PnpmStoreConfig = SandboxConfig['pnpmStore'];

/** Parse one VANGUARD_SANDBOX_* limit: unset ⇒ `fallback`; "0", invalid or empty ⇒ undefined (omit the flag). */
function envLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number | undefined {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Default sandbox memory (MB) when the rootfs is read-only: `/workspace`, `$HOME` and `/tmp` are then
 * tmpfs charged to the same cgroup (see readOnlyTmpfsSizesMb), so 8192 gives `/workspace` 3072 MB,
 * `$HOME` 2048 MB (room for a pnpm store), `/tmp` 1024 MB and 2 GB for the processes — enough for a typical pnpm install +
 * build, where the 2048 default would leave `/workspace` at 768 MB. It is also the floor for the
 * hardened default: an explicit VANGUARD_SANDBOX_MEMORY_MB below it stands that default down. A cgroup
 * bigger than the host's free RAM bounds nothing, so a host without ~8 GB to spare per concurrent
 * sandbox should set a lower VANGUARD_SANDBOX_MEMORY_MB (keeping the writable rootfs).
 */
export const READONLY_SANDBOX_MEMORY_MB = 8192;

/** Memory the hardened read-only default would run under: unset ⇒ READONLY_SANDBOX_MEMORY_MB; "0"/invalid/empty ⇒ undefined. */
const hardenedMemoryMb = (env: NodeJS.ProcessEnv): number | undefined =>
  envLimit(env, 'VANGUARD_SANDBOX_MEMORY_MB', READONLY_SANDBOX_MEMORY_MB);

/**
 * Env-overridable sandbox resource limits. Defaults: memory 2048 MB (READONLY_SANDBOX_MEMORY_MB when
 * the run's rootfs is read-only — `hardened` is passed through to sandboxSecurityOpts), 2 CPUs, 512 pids. Each
 * VANGUARD_SANDBOX_* var overrides its default; set it to "0" (or an invalid/empty value) to OMIT
 * that limit entirely, so no `--memory`/`--cpus`/`--pids-limit` flag is passed. This is required on
 * hosts whose kernel lacks a cgroup — e.g. Synology DSM has no CPU CFS scheduler, so `--cpus` is
 * fatal there and must be disabled with VANGUARD_SANDBOX_CPUS=0.
 */
export function sandboxResourceLimits(env: NodeJS.ProcessEnv = process.env, hardened = false): SandboxResourceLimits {
  const memoryFallback = sandboxSecurityOpts(env, hardened).readOnlyRootfs ? READONLY_SANDBOX_MEMORY_MB : 2048;
  const memoryMb = envLimit(env, 'VANGUARD_SANDBOX_MEMORY_MB', memoryFallback);
  const cpus = envLimit(env, 'VANGUARD_SANDBOX_CPUS', 2);
  const pidsLimit = envLimit(env, 'VANGUARD_SANDBOX_PIDS', 512);
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
 *
 * `hardened` is the caller's "this run is `--egress`/`--llm-proxy`" signal — a plain boolean, passed
 * in by the CLI/runner call site, never read from argv or env here — and only shifts the
 * `readOnlyRootfs` default from false to true; an explicit `VANGUARD_SANDBOX_READONLY` still wins
 * either way, so `=0` disables it even when hardened and `=1` enables it even when not. An EMPTY
 * VANGUARD_SANDBOX_READONLY counts as unset (an unset CI variable passed through `env:` arrives as ""),
 * so it cannot silently turn the hardened default off. The hardened default also stays off when the
 * memory limit is omitted (VANGUARD_SANDBOX_MEMORY_MB=0) — the tmpfs mounts would have no cgroup to
 * be sized against and would press on host RAM — or set below READONLY_SANDBOX_MEMORY_MB, where the
 * mounts would be too small for a real install + build. `hardenedRootfsNote` reports which applied.
 */
export function sandboxSecurityOpts(env: NodeJS.ProcessEnv = process.env, hardened = false): SandboxSecurityOpts {
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
    readOnlyRootfs: flag(
      env.VANGUARD_SANDBOX_READONLY || undefined,
      hardened && (hardenedMemoryMb(env) ?? 0) >= READONLY_SANDBOX_MEMORY_MB,
    ),
  };
}

/**
 * One line for the start of an `--egress`/`--llm-proxy` run: whether the hardened read-only rootfs
 * default engaged or stood down, and why. `warn` is true when it stood down for the memory limit, so
 * an operator sees the variable to raise instead of a silently writable rootfs.
 */
export function hardenedRootfsNote(env: NodeJS.ProcessEnv = process.env): { warn: boolean; message: string } {
  const explicit = env.VANGUARD_SANDBOX_READONLY;
  if (explicit !== undefined && explicit !== '') {
    const on = sandboxSecurityOpts(env, true).readOnlyRootfs;
    const message = `sandbox: read-only rootfs ${on ? 'on' : 'off'} (VANGUARD_SANDBOX_READONLY=${explicit}).`;
    // Forced on with no memory limit: the fixed-size tmpfs mounts have no cgroup to bound them.
    if (on && hardenedMemoryMb(env) === undefined) {
      const { workspace, home, tmp } = readOnlyTmpfsSizesMb(undefined);
      return {
        warn: true,
        message: `${message} No memory limit (VANGUARD_SANDBOX_MEMORY_MB=${env.VANGUARD_SANDBOX_MEMORY_MB ?? ''}), so /workspace, $HOME and /tmp are tmpfs of ${workspace}/${home}/${tmp} MB backed by host RAM.`,
      };
    }
    return { warn: false, message };
  }
  const memoryMb = hardenedMemoryMb(env);
  if (memoryMb !== undefined && memoryMb >= READONLY_SANDBOX_MEMORY_MB) {
    return {
      warn: false,
      message: `sandbox: read-only rootfs on (hardened default); /workspace, $HOME and /tmp are tmpfs inside the ${memoryMb} MB memory limit.`,
    };
  }
  return {
    warn: true,
    message:
      `sandbox: hardened read-only rootfs NOT applied — VANGUARD_SANDBOX_MEMORY_MB=${env.VANGUARD_SANDBOX_MEMORY_MB ?? ''} ` +
      `is below the ${READONLY_SANDBOX_MEMORY_MB} MB it needs (its tmpfs mounts share that limit); the rootfs stays writable. ` +
      `Raise it to ${READONLY_SANDBOX_MEMORY_MB} or more, or set VANGUARD_SANDBOX_READONLY=1 to force it.`,
  };
}

/**
 * `--tmpfs` sizes (MB) for the three writable mounts a read-only rootfs needs — `/workspace`, `$HOME`
 * and `/tmp` (see `buildRunArgs`). A tmpfs page is charged to the container's own memory cgroup, so
 * fixed sizes larger than `--memory` would just turn a full workspace into an OOM kill of the whole
 * sandbox: the sizes are derived from the resolved `memoryMb` instead, split 3:2:1 over three quarters
 * of the limit, with the last quarter left for the processes. With the memory limit omitted entirely
 * (VANGUARD_SANDBOX_MEMORY_MB=0) there is nothing to size against, so the mounts fall back to fixed
 * sizes — reachable only through an explicit VANGUARD_SANDBOX_READONLY=1, since the hardened default
 * stays off without a memory limit (see sandboxSecurityOpts). Either way a repo whose install or build needs more than that wants a bigger
 * VANGUARD_SANDBOX_MEMORY_MB — see docs/cli.md.
 */
export function readOnlyTmpfsSizesMb(memoryMb: number | undefined): { workspace: number; home: number; tmp: number } {
  if (memoryMb === undefined) return { workspace: 4096, home: 2048, tmp: 1024 };
  // Floored at 1 MB a share: `size=0` means UNLIMITED to tmpfs, the opposite of the cap asked for.
  const unit = Math.max(1, Math.floor((memoryMb * 3) / 4 / 6));
  return { workspace: unit * 3, home: unit * 2, tmp: unit };
}
