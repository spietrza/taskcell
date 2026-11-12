export interface SandboxSecurityOpts {
  capDrop: string[];
  capAdd: string[];
  noNewPrivileges: boolean;
  readOnlyRootfs: boolean;
  /** `docker run --init`: an init as PID 1 that reaps orphaned children (see sandboxSecurityOpts). */
  init: boolean;
}

/**
 * The full hardened posture for one sandbox, resolved once per command by
 * `resolveSandboxProfile()` (see sandbox/limits.ts) and only ever consumed by the adapter —
 * `DockerSandboxProvider` never re-derives any of this itself. Bundling memory/cpus/pids,
 * caps, the read-only-rootfs writable mounts and their sizes, and the start-of-run note into one
 * object closes the gap where `buildRunArgs` and `start()` each decided a piece of the posture
 * independently and could drift out of sync.
 */
export interface SandboxProfile {
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  security: SandboxSecurityOpts;
  /** $HOME inside the sandbox — the writable mount a read-only rootfs hands back to the run user. */
  home: string;
  /** `--tmpfs` sizes (MB) for /workspace, $HOME and /tmp; only mounted when security.readOnlyRootfs is on. */
  tmpfs: { workspace: number; home: number; tmp: number };
  /** Start-of-run log line summarising the read-only-rootfs decision above. */
  note: { warn: boolean; message: string };
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecStream {
  stdout: AsyncIterable<string>;
  result: Promise<ExecResult>;
}

/** Options for copying a directory out of a sandbox. */
export interface CopyOutOptions {
  /** File/dir names skipped at any depth (bare names, no slashes). */
  exclude?: readonly string[];
  /** Abort once the archive streamed out of the sandbox passes this many bytes (before it reaches the host disk). */
  maxBytes?: number;
}

/**
 * A fully isolated execution environment (Docker container or Firecracker microVM).
 * The host owns explicit file sync: nothing crosses the boundary except via copyIn/copyFileOut.
 */
export interface IsolatedSandboxProvider {
  readonly id: string;
  /** Provision the sandbox (pull image / boot VM, start it). */
  start: () => Promise<void>;
  /** Run a command INSIDE the sandbox and capture output (never throws on non-zero exit). */
  exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;
  /** Stream a long-running command's stdout while it runs (for live logging / abort). */
  execStream: (command: string, options?: ExecOptions) => ExecStream;
  /**
   * Copy a host file/dir INTO the sandbox. Symlinks inside a copied dir must arrive as links, never
   * dereferenced (docker cp does this): repo skills are copied in from the host, and a link must not
   * pull host files into the sandbox.
   */
  copyIn: (hostPath: string, sandboxPath: string) => Promise<void>;
  /** Copy a sandbox file/dir OUT to the host. */
  copyFileOut: (sandboxPath: string, hostPath: string, options?: CopyOutOptions) => Promise<void>;
  /** True if a path exists inside the sandbox. */
  exists: (sandboxPath: string) => Promise<boolean>;
  /** Tear down (rm container / kill VM). Safe to call multiple times. */
  destroy: () => Promise<void>;
  /** Host command that opens an interactive shell into the live sandbox (for HITL). */
  shellCommand: () => string;
  /**
   * Content digest/ID of the image this sandbox is actually running, for the run record (so a run
   * can be traced to the exact image regardless of whether it was pulled from GHCR or built locally).
   * Optional: providers that cannot report one (or haven't started yet) return undefined.
   */
  imageDigest?: () => Promise<string | undefined>;
}

export interface SandboxConfig {
  image?: string;
  workdir?: string;
  env?: Record<string, string>;
  forwardEnv?: string[];
  /** Secrets injected off the command line (tmpfs / env-file), never via -e KEY=VAL. */
  secrets?: Record<string, string>;
  /**
   * How secrets reach the sandbox. 'tmpfs' (default) writes them to an in-RAM file the
   * commands source at runtime, so they never appear in `docker inspect` Config.Env or on
   * disk. 'env-file' loads them into the container env (visible to docker inspect).
   */
  secretsMode?: 'tmpfs' | 'env-file';
  /** Join this docker network instead of the default bridge (e.g. an internal egress enclave). */
  network?: string;
  /**
   * Map `host.docker.internal` to the docker host (`--add-host …:host-gateway`). Unset: added only
   * when an `env`/`secrets`/`forwardEnv` value names host.docker.internal (a host egress proxy from
   * `startEgressProxy`, a provider endpoint on the docker host). Set it to force either way, e.g.
   * for repo tooling that reaches host services by that name on Linux.
   */
  hostGateway?: boolean;
  /**
   * The resolved sandbox posture: memory/cpus/pids, hardening caps, and the read-only-rootfs
   * writable mounts. Build with `resolveSandboxProfile()` (sandbox/limits.ts) once per command;
   * defaults to that same resolution when omitted. The adapter only consumes this — it never
   * decides the posture itself.
   */
  profile?: SandboxProfile;
  /**
   * Opt-in persistent pnpm store (`--pnpm-store` / VANGUARD_PNPM_STORE; off by default — see
   * docs/cli.md). Undefined: no mount, pnpm's default in-tmpfs store-dir, every install
   * re-downloads. Set: mounts a per-repo store at `/pnpm-store` and sets `npm_config_store_dir`,
   * so a repeat install on the SAME repo skips the network fetch.
   */
  pnpmStore?: {
    /** Stable per-repo identifier (e.g. the repo's local path), hashed into the volume/dir name so two repos never share a store. */
    repoKey: string;
    /** Bind-mount this host directory instead of a named Docker volume — the CI shape, where actions/cache restores to a path. */
    hostDir?: string;
  };
}
