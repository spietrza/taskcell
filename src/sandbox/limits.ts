import type { SandboxConfig, SandboxProfile, SandboxSecurityOpts } from './provider.js';

export type SandboxResourceLimits = Pick<SandboxProfile, 'memoryMb' | 'cpus' | 'pidsLimit'>;

type PnpmStoreConfig = SandboxConfig['pnpmStore'];

/** $HOME inside every sandbox — part of the resolved profile, not a value docker.ts hard-codes. */
export const DEFAULT_SANDBOX_HOME = '/home/agent';

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
 * build, where the 2048 default would leave `/workspace` at 768 MB. It is also the default for a
 * hardened (`--egress`/`--llm-proxy`) run, whose in-sandbox test suite dies at 2048 MB; a cgroup
 * bigger than the host's free RAM bounds nothing, so a host without ~8 GB to spare per concurrent
 * sandbox wants VANGUARD_SANDBOX_MEMORY_MB set lower.
 */
export const READONLY_SANDBOX_MEMORY_MB = 8192;

/**
 * Env-overridable sandbox resource limits. Defaults: memory 2048 MB, 2 CPUs, 512 pids. Each
 * VANGUARD_SANDBOX_* var overrides its default; set it to "0" (or an invalid/empty value) to OMIT
 * that limit entirely, so no `--memory`/`--cpus`/`--pids-limit` flag is passed. This is required on
 * hosts whose kernel lacks a cgroup — e.g. Synology DSM has no CPU CFS scheduler, so `--cpus` is
 * fatal there and must be disabled with VANGUARD_SANDBOX_CPUS=0.
 *
 * The memory default rises to READONLY_SANDBOX_MEMORY_MB only when the rootfs is read-only
 * (VANGUARD_SANDBOX_READONLY=1), which charges the three tmpfs mounts to this same cgroup (see
 * readOnlyTmpfsSizesMb). `--egress`/`--llm-proxy` alone keep 2048 MB: a cgroup bigger than the host's
 * free RAM bounds nothing, and small hosts (NAS) run the hardened path too.
 */
export function sandboxResourceLimits(env: NodeJS.ProcessEnv = process.env): SandboxResourceLimits {
  const memoryFallback = sandboxSecurityOpts(env).readOnlyRootfs ? READONLY_SANDBOX_MEMORY_MB : 2048;
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
 * The exception is `readOnlyRootfs`, which is opt-in: on only with VANGUARD_SANDBOX_READONLY set to a
 * non-empty value other than "0". An EMPTY VANGUARD_SANDBOX_READONLY counts as unset (an unset CI
 * variable passed through `env:` arrives as ""). `resolveSandboxProfile`'s `note` reports the decision
 * at run start.
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
    // Opt-in only (VANGUARD_SANDBOX_READONLY=1): it moves the workspace into RAM under an 8 GB
    // limit, which a smaller host or a large monorepo cannot take, and reusable-workflow callers
    // had no way to turn a default off.
    readOnlyRootfs: flag(env.VANGUARD_SANDBOX_READONLY || undefined, false),
  };
}

/**
 * One line for the start of a run: whether the read-only rootfs is on and how to opt in when it is
 * not. `warn` is true when it was turned on with no memory limit (the tmpfs mounts are then backed by
 * host RAM with no cgroup bounding them, risking an OOM kill) or with less than
 * READONLY_SANDBOX_MEMORY_MB (the mounts are shares of that limit, so a lower one shrinks `/workspace`
 * below what an install + build needs, risking ENOSPC on those mounts or an OOM kill of the sandbox).
 * `memoryMb` is the already-resolved limit (from `sandboxResourceLimits`) — this never re-derives it,
 * so the note can't drift from the profile it describes.
 */
function hardenedRootfsNote(env: NodeJS.ProcessEnv, readOnlyRootfs: boolean, memoryMb: number | undefined): { warn: boolean; message: string } {
  const explicit = env.VANGUARD_SANDBOX_READONLY;
  if (explicit !== undefined && explicit !== '') {
    const message = `sandbox: read-only rootfs ${readOnlyRootfs ? 'on' : 'off'} (VANGUARD_SANDBOX_READONLY=${explicit}).`;
    // Forced on with no memory limit (the fixed-size tmpfs mounts have no cgroup to bound them), or
    // under a limit the mounts cannot be sized from comfortably (they are shares of it).
    if (readOnlyRootfs && (memoryMb === undefined || memoryMb < READONLY_SANDBOX_MEMORY_MB)) {
      const { workspace, home, tmp } = readOnlyTmpfsSizesMb(memoryMb);
      const why =
        memoryMb === undefined
          ? `No memory limit (VANGUARD_SANDBOX_MEMORY_MB=${env.VANGUARD_SANDBOX_MEMORY_MB ?? ''}), so /workspace, $HOME and /tmp are tmpfs of ${workspace}/${home}/${tmp} MB backed by host RAM, risking an OOM kill of the sandbox.`
          : `VANGUARD_SANDBOX_MEMORY_MB=${memoryMb} is below ${READONLY_SANDBOX_MEMORY_MB}, so /workspace, $HOME and /tmp are tmpfs of only ${workspace}/${home}/${tmp} MB — an install or build may hit ENOSPC on those mounts or an OOM kill of the sandbox.`;
      return { warn: true, message: `${message} ${why}` };
    }
    return { warn: false, message };
  }
  return {
    warn: false,
    message:
      `sandbox: read-only rootfs off (opt-in: VANGUARD_SANDBOX_READONLY=1; /workspace, $HOME and /tmp then live in RAM, ` +
      `sized for VANGUARD_SANDBOX_MEMORY_MB of ${READONLY_SANDBOX_MEMORY_MB} or more).`,
  };
}

/**
 * Resolve the sandbox profile — memory/cpus/pids, hardening caps, the read-only-rootfs writable
 * mounts and their sizes, $HOME, and the start-of-run note — ONCE, from env. Every caller (the six
 * runners, plus the egress/llm-proxy start note) builds its sandbox posture by calling this single
 * function instead of composing `sandboxResourceLimits`/`sandboxSecurityOpts`/`readOnlyTmpfsSizesMb`
 * separately, which is what let `docker.ts`'s `buildRunArgs` and `start()` each decide a piece of the
 * posture on their own and drift apart (see #746, #753). `DockerSandboxProvider` only consumes the
 * result; it never calls the pieces below directly.
 */
export function resolveSandboxProfile(env: NodeJS.ProcessEnv = process.env): SandboxProfile {
  const security = sandboxSecurityOpts(env);
  const { memoryMb, cpus, pidsLimit } = sandboxResourceLimits(env);
  return {
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
    ...(pidsLimit !== undefined ? { pidsLimit } : {}),
    security,
    home: DEFAULT_SANDBOX_HOME,
    tmpfs: readOnlyTmpfsSizesMb(memoryMb),
    note: hardenedRootfsNote(env, security.readOnlyRootfs, memoryMb),
  };
}

/**
 * The two `SandboxConfig` fields a run's egress posture decides together: the enclave network to join
 * (undefined ⇒ the default bridge) and the profile resolved for it, built together so no caller
 * assembles the pair by hand.
 */
export function sandboxNetworkConfig(network: string | undefined, env: NodeJS.ProcessEnv = process.env): Pick<SandboxConfig, 'network' | 'profile'> {
  return { ...(network !== undefined ? { network } : {}), profile: resolveSandboxProfile(env) };
}

/**
 * `--tmpfs` sizes (MB) for the three writable mounts a read-only rootfs needs — `/workspace`, `$HOME`
 * and `/tmp` (see `buildRunArgs`). A tmpfs page is charged to the container's own memory cgroup, so
 * fixed sizes larger than `--memory` would just turn a full workspace into an OOM kill of the whole
 * sandbox: the sizes are derived from the resolved `memoryMb` instead, split 3:2:1 over three quarters
 * of the limit, with the last quarter left for the processes. With the memory limit omitted entirely
 * (VANGUARD_SANDBOX_MEMORY_MB=0) there is nothing to size against, so the mounts fall back to fixed
 * sizes. Either way a repo whose install or build needs more than that wants a bigger
 * VANGUARD_SANDBOX_MEMORY_MB — see docs/cli.md.
 */
export function readOnlyTmpfsSizesMb(memoryMb: number | undefined): { workspace: number; home: number; tmp: number } {
  if (memoryMb === undefined) return { workspace: 4096, home: 2048, tmp: 1024 };
  // Floored at 1 MB a share: `size=0` means UNLIMITED to tmpfs, the opposite of the cap asked for.
  const unit = Math.max(1, Math.floor((memoryMb * 3) / 4 / 6));
  return { workspace: unit * 3, home: unit * 2, tmp: unit };
}
