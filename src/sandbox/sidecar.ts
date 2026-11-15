import { posix } from 'node:path';
import { execa } from 'execa';
import { SandboxError } from '../core/errors.js';
import { resolveSandboxImage, sandboxImage } from './docker.js';
import { ownerLabelArgs, sidecarMemoryArgs } from './limits.js';

/**
 * One launcher for the per-run sidecar containers (egress proxy, LLM proxy). The sequence — create or
 * run, join the enclave network, copy the scripts in, write a secret over stdin, start — is the same
 * for both; so is the rule that EVERY docker call is fail-closed (a non-zero exit tears the sidecar
 * down and throws) — a sidecar that reports ready but never listens costs every later stage minutes
 * of ConnectionRefused. The two proxies are adapters: each describes its container, this module runs it.
 */

/** Injectable docker runner so the host orchestration is testable without touching real docker. */
export type DockerRunner = (
  args: string[],
  opts?: { input?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Default runner: execa-based docker invocation (reject:false so the launcher inspects exitCode). */
export const defaultDocker: DockerRunner = async (args, opts) => {
  const result = await execa('docker', args, {
    reject: false,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
};

export interface SidecarSpec {
  /** Container name (also the hostname other containers reach it by). */
  name: string;
  /** Per-run id recorded as the `vanguard.runId` label, so gc reaps the sidecar with the run. */
  runId: string;
  image?: string;
  docker?: DockerRunner;
  /** Internal enclave network to join (in addition to the default bridge the container starts on). */
  network?: string;
  /** Host files copied into the container before the process starts (`docker cp`). */
  files: ReadonlyArray<{ src: string; dest: string }>;
  /** Environment for the sidecar process (plain values only — never a secret; those go via `secret`). */
  env?: Readonly<Record<string, string>>;
  /** Extra `docker create` flags (e.g. `--restart on-failure:10`). */
  createArgs?: readonly string[];
  /** The sidecar process. Without `secret` it is PID 1 of the container, so docker records its output and
   *  `--restart` revives it; with `secret` it is a detached `exec` (see `forwardLogs` for its output). */
  cmd: readonly string[];
  /**
   * A secret written over stdin into an in-RAM file (umask 077) before the process starts — never via
   * `-e` or argv, so `docker inspect` cannot reveal it. Needs a running container, so the launcher
   * starts an idle one, writes, then execs the process detached. The file's directory is mounted as a
   * dedicated tmpfs so the secret never lands in the container's writable layer (`docker commit`/`cp`).
   */
  secret?: { path: string; body: string };
  /** With `secret`: route the detached process's stderr to PID 1's so `docker logs` shows it (a detached
   *  `exec` otherwise logs nowhere). stdout is not routed: a sidecar logs one line per request there, which
   *  the untrusted cell could use to grow the container log. Warns and runs the plain command if PID 1's
   *  stderr cannot be opened. */
  forwardLogs?: boolean;
  /** Teardown hook for resources created alongside the container (e.g. a network), run after `rm -f`. */
  alsoDestroy?: () => Promise<void>;
}

export interface Sidecar {
  name: string;
  destroy: () => Promise<void>;
}

export async function startSidecar(spec: SidecarSpec): Promise<Sidecar> {
  const docker = spec.docker ?? defaultDocker;
  // The sidecar runs its node script inside the sandbox image itself (no dedicated proxy image), so it
  // must follow the same CI-pinned override as the main sandbox.
  const image = await resolveSandboxImage(spec.image ?? sandboxImage(), async (img) =>
    (await docker(['image', 'inspect', img])).exitCode === 0);
  const { name } = spec;
  // alsoDestroy runs even when `rm -f` itself throws (a dead docker daemon): the caller's resource must
  // not leak behind a container that could not be removed.
  const teardown = async (): Promise<void> => {
    try {
      await docker(['rm', '-f', name]);
    } finally {
      await spec.alsoDestroy?.();
    }
  };
  const must = async (args: string[], opts?: { input?: string }): Promise<void> => {
    const result = await docker(args, opts);
    if (result.exitCode !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
  };
  const envArgs = Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const common = ['--name', name, '--label', `vanguard.runId=${spec.runId}`, ...ownerLabelArgs(), ...sidecarMemoryArgs(), ...(spec.createArgs ?? [])];
  try {
    if (spec.secret === undefined) {
      // Created (not started) on the default bridge so the scripts can be cp'd in first; joined to the
      // enclave network before start; the process is PID 1.
      await must(['create', ...common, ...envArgs, image, ...spec.cmd]);
      if (spec.network !== undefined) await must(['network', 'connect', spec.network, name]);
      for (const f of spec.files) await must(['cp', f.src, `${name}:${f.dest}`]);
      await must(['start', name]);
    } else {
      // Secret over stdin needs a running container: idle PID 1, write, then exec the process detached.
      const secretDir = posix.dirname(spec.secret.path);
      const tmpfs = ['--tmpfs', `${secretDir}:rw,noexec,nosuid,mode=1777,size=1m`];
      await must(['run', '-d', ...common, ...tmpfs, image, 'sleep', 'infinity']);
      if (spec.network !== undefined) await must(['network', 'connect', spec.network, name]);
      for (const f of spec.files) await must(['cp', f.src, `${name}:${f.dest}`]);
      await must(['exec', '-i', name, 'sh', '-c', `umask 077; cat > ${spec.secret.path}`], { input: spec.secret.body });
      let run = spec.cmd;
      if (spec.forwardLogs === true) {
        // Probed here, not inside the detached shell: a redirect that fails there kills the shell behind
        // `exec -d`'s exit 0, leaving a sidecar that reports started and never listens.
        const probe = await docker(['exec', name, 'sh', '-c', ': 2>>/proc/1/fd/2']);
        if (probe.exitCode === 0) run = ['sh', '-c', 'exec "$@" 2>>/proc/1/fd/2', 'sh', ...spec.cmd];
        else console.warn(`taskcell: sidecar ${name} cannot write to its container log; its errors will not be relayed to the run log.`);
      }
      await must(['exec', '-d', ...envArgs, name, ...run]);
    }
    return { name, destroy: teardown };
  } catch (cause) {
    await teardown();
    throw new SandboxError(`Failed to start sidecar ${name}`, { cause });
  }
}
