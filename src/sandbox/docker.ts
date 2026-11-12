import { execa } from 'execa';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { SandboxError } from '../core/errors.js';
import { ownerLabelArgs, resolveSandboxProfile } from './limits.js';
import type { CopyOutOptions, ExecOptions, ExecResult, ExecStream, IsolatedSandboxProvider, SandboxConfig, SandboxProfile } from './provider.js';

/**
 * GNU tar exits 1 when a file grows or is deleted while it is archived (a watcher or test cache still
 * running in the sandbox); the archive is complete, so copy-back keeps it. Exit 1 for any other reason,
 * and every other non-zero code, fails closed — including busybox tar's wording on custom images.
 */
export function isBenignTarExit(exitCode: number, stderr: string): boolean {
  if (exitCode === 0) return true;
  if (exitCode !== 1) return false;
  const benign = /file changed as we read it|File removed before we read it/;
  const lines = stderr.split('\n').filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every((line) => benign.test(line));
}

/**
 * Normalise an execa result into an `ExecResult`.
 *
 * With `reject: false`, execa hands back its error object for a subprocess that never ran or was
 * cancelled, and those carry `stdout`/`stderr` as `undefined` — nothing was ever buffered. The
 * declared `string` then lies to every consumer, and the first `.split('\n')` downstream throws a
 * bare `TypeError: Cannot read properties of undefined` from inside the consumer, burying the real
 * failure: `agents/codex.ts` crashed there on line 88 instead of reaching its own guard 35 lines
 * later, which would have reported the exit code and stderr. Coerce at the seam that declares the
 * contract, so callers can keep trusting the type.
 */
export function toExecResult(raw: {
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
}): ExecResult {
  return { stdout: raw.stdout ?? '', stderr: raw.stderr ?? '', exitCode: raw.exitCode ?? 1 };
}

const DEFAULT_IMAGE = 'taskcell-sandbox:latest';
/** Pre-rename tag, still built as an alias by docker/build.sh — see `resolveSandboxImage`. */
const LEGACY_IMAGE = 'vanguard-sandbox:latest';

/**
 * The sandbox image to run: `VANGUARD_SANDBOX_IMAGE` when set (CI passes the exact `sha256:...` ID it
 * just built, since the shared mutable `taskcell-sandbox:latest` tag on a shared Docker host can be
 * overwritten by another pipeline between build and run), else the mutable tag for local/dev use.
 */
export function sandboxImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['VANGUARD_SANDBOX_IMAGE'];
  if (override === undefined || override === '') return DEFAULT_IMAGE;
  // The image sits in docker's argv before the command, so a leading `-` would be read as a flag such as
  // --privileged. No valid image reference starts with `-` or contains whitespace.
  if (/^-|\s/.test(override)) throw new SandboxError(`VANGUARD_SANDBOX_IMAGE is not an image reference: ${JSON.stringify(override)}`);
  return override;
}

/** Whether an image reference resolves locally; injectable so the fallback is testable without Docker. */
export type ImageExists = (image: string) => Promise<boolean>;

const dockerImageExists: ImageExists = async (image) =>
  (await execa('docker', ['image', 'inspect', image], { reject: false })).exitCode === 0;

/**
 * Resolve the image a run should actually use. Only the default tag is adjusted: an explicit
 * `VANGUARD_SANDBOX_IMAGE` (or `config.image`) always wins, untouched. A host that last ran
 * `docker/build.sh` before the rename only has the pre-rename `vanguard-sandbox:latest` tag, so fall
 * back to it rather than failing on a tag that host never built. When neither exists, keep the new
 * name: the caller's "no such image" then points at the tag the current build.sh produces.
 */
export async function resolveSandboxImage(image: string, exists: ImageExists = dockerImageExists): Promise<string> {
  if (image !== DEFAULT_IMAGE) return image;
  if (await exists(DEFAULT_IMAGE)) return DEFAULT_IMAGE;
  return (await exists(LEGACY_IMAGE)) ? LEGACY_IMAGE : DEFAULT_IMAGE;
}

/**
 * Claude CLI the sandbox image is built with — keep in sync with docker/Dockerfile's
 * ARG CLAUDE_CLI_VERSION. The pin moves in the repo but a built image does not, and the drift only
 * surfaces deep inside a run as a gateway error (live case: 2.1.165 answered every Meridian request
 * with `400 This session advanced while the request was waiting`, burning ~50 min per attempt).
 */
export const SANDBOX_CLAUDE_VERSION = '2.1.322';

/** Codex CLI the sandbox image is built with — keep in sync with docker/Dockerfile's ARG CODEX_CLI_VERSION. */
export const SANDBOX_CODEX_VERSION = '0.167.2';

/** True when `actual` sorts below `expected`; unparseable parts count as older. */
export function isOlderVersion(actual: string, expected: string): boolean {
  const a = actual.split('.');
  const e = expected.split('.');
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    const x = Number(a[i] ?? 0);
    const y = Number(e[i] ?? 0);
    if (Number.isNaN(x)) return true;
    if (x !== y) return x < y;
  }
  return false;
}

/** Minimal command runner, injectable so the refresh can be exercised without Docker. */
export type DockerRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

export const defaultDockerRunner: DockerRunner = async (cmd, args, opts) => {
  const { stdout } = await execa(cmd, args, { cwd: opts.cwd, timeout: 10 * 60_000 });
  return { stdout };
};

/** The sandbox image to inspect or refresh: `sandboxImage(env)` through the pre-rename fallback, probed with `run`. */
export function resolveSandboxImageVia(run: DockerRunner, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return resolveSandboxImage(sandboxImage(env), (img) => run('docker', ['image', 'inspect', img], { cwd }).then(() => true, () => false));
}

/** Install the pinned claude CLI into an existing sandbox image, in place; see `refreshSandboxNpmCli`. */
export async function refreshSandboxClaudeCli(opts: SandboxRefreshOptions): Promise<string> {
  return refreshSandboxNpmCli({ ...opts, pkg: '@anthropic-ai/claude-code', version: SANDBOX_CLAUDE_VERSION });
}

/** Same in-place refresh for the pinned codex CLI. */
export async function refreshSandboxCodexCli(opts: SandboxRefreshOptions): Promise<string> {
  return refreshSandboxNpmCli({ ...opts, pkg: '@openai/codex', version: SANDBOX_CODEX_VERSION });
}

interface SandboxRefreshOptions {
  cwd: string;
  image?: string;
  run?: DockerRunner;
  env?: NodeJS.ProcessEnv;
}

/**
 * Install an npm CLI into an existing sandbox image, in place. Cheaper and far more
 * reliable than a rebuild behind a corporate MITM proxy, which breaks on the linear-cli release
 * tarball. The npm install needs root, but `docker commit` snapshots the CONTAINER's config — so the
 * original USER/WorkingDir are read first and restored, or the image would silently start running as
 * root and the CLI would then refuse to launch at all.
 */
async function refreshSandboxNpmCli(opts: SandboxRefreshOptions & { pkg: string; version: string }): Promise<string> {
  const run = opts.run ?? defaultDockerRunner;
  const { cwd } = opts;
  // Resolve through the same fallback as a sandbox start: `doctor --fix` is what both the preflight
  // check and `assertClaudeCliCurrent` point at, and they report the resolved tag — refreshing the
  // unresolved default would tell a pre-rename host to fix an image it never built.
  const image = opts.image ?? (await resolveSandboxImageVia(run, cwd, opts.env));
  // `docker commit` onto an image ID or a digest reference cannot change what it names.
  const immutable = new SandboxError(
    `Cannot refresh ${image}: an image ID or digest is immutable. Rebuild the image, or unset VANGUARD_SANDBOX_IMAGE to refresh ${DEFAULT_IMAGE}.`,
  );
  if (/^(sha256:)?[a-f0-9]{12,64}$|@sha256:[a-f0-9]{64}$/.test(image)) throw immutable;
  const helper = 'vg-cli-refresh';

  const inspect = async (field: string): Promise<string> => {
    const { stdout } = await run('docker', ['image', 'inspect', image, '--format', `{{${field}}}`], { cwd });
    return stdout.trim();
  };
  // Docker also resolves a shorter unique prefix of an ID; only the engine can tell it from a hex repository name.
  const hex = /^(?:sha256:)?([a-f0-9]+)$/.exec(image)?.[1];
  if (hex !== undefined && (await inspect('.Id')).replace(/^sha256:/, '').startsWith(hex)) throw immutable;
  const user = await inspect('.Config.User');
  const workdir = await inspect('.Config.WorkingDir');

  await run('docker', ['rm', '-f', helper], { cwd }).catch(() => undefined);
  try {
    await run('docker', ['run', '--name', helper, '-u', '0', image, 'npm', 'install', '-g', `${opts.pkg}@${opts.version}`], { cwd });
    const changes = [
      ...(user !== '' ? ['--change', `USER ${user}`] : []),
      ...(workdir !== '' ? ['--change', `WORKDIR ${workdir}`] : []),
    ];
    await run('docker', ['commit', ...changes, helper, image], { cwd });
  } finally {
    await run('docker', ['rm', '-f', helper], { cwd }).catch(() => undefined);
  }
  return opts.version;
}

/**
 * Once per process: refuse to run against an image whose bundled claude CLI predates the repo pin.
 * Checked here rather than in preflight because preflight only covers `watch`/`doctor` — `spec` and
 * `run` reach a sandbox without it. An image with no runnable `claude` is a deliberate custom image,
 * so it is skipped rather than failed. Escape hatch: VANGUARD_SKIP_IMAGE_CHECK=1.
 */
let claudeVersionChecked = false;
const DEFAULT_WORKDIR = '/workspace';
const SECRETS_DIR = '/run/vanguard';
const SECRETS_FILE = `${SECRETS_DIR}/secrets.env`;

type SecretsMode = 'tmpfs' | 'env-file';

const HOST_GATEWAY_NAME = 'host.docker.internal';

/** Mount point inside the sandbox for the opt-in persistent pnpm store (see SandboxConfig.pnpmStore). */
const PNPM_STORE_DIR = '/pnpm-store';

/**
 * Named Docker volume for one repo's persistent pnpm store: `taskcell-pnpm-store-<hash>`. One per
 * `repoKey` so a run against repo A can never read (or poison) repo B's cached packages — see the
 * store-poisoning note on SandboxConfig.pnpmStore and docs/cli.md.
 */
export function pnpmStoreVolumeName(repoKey: string): string {
  const hash = createHash('sha256').update(repoKey).digest('hex').slice(0, 16);
  return `taskcell-pnpm-store-${hash}`;
}

/** Runs an isolated command environment as a detached Docker container. */
export class DockerSandboxProvider implements IsolatedSandboxProvider {
  readonly id: string;
  private readonly image: string;
  private readonly workdir: string;
  private readonly config: SandboxConfig;
  /** The posture this sandbox runs under, decided once by the caller (see SandboxConfig.profile). */
  private readonly profile: SandboxProfile;
  private readonly secretsMode: SecretsMode;
  private readonly secrets: Record<string, string>;
  private envDir: string | undefined;
  private owner: string | undefined;
  private started = false;

  constructor(config: SandboxConfig = {}) {
    this.config = config;
    this.id = randomUUID();
    this.image = config.image ?? sandboxImage();
    this.profile = config.profile ?? resolveSandboxProfile();
    this.workdir = config.workdir ?? DEFAULT_WORKDIR;
    this.secretsMode = config.secretsMode ?? 'tmpfs';
    this.secrets = { ...config.secrets };
    for (const key of config.forwardEnv ?? []) {
      const value = process.env[key];
      if (value !== undefined) this.secrets[key] = value;
    }
    for (const [key, value] of Object.entries(this.secrets)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new SandboxError(`Invalid secret name: ${key}`);
      }
      if (/[\n\r]/.test(value)) {
        throw new SandboxError(`Secret ${key} contains a newline, which is not allowed`);
      }
    }
  }

  private get name(): string {
    return `vg-${this.id}`;
  }

  /** An explicit `hostGateway` wins; otherwise the alias is added only when some value handed to the
   * sandbox (env, secrets, forwarded env) names host.docker.internal. */
  private needsHostGateway(): boolean {
    if (this.config.hostGateway !== undefined) return this.config.hostGateway;
    const values = [...Object.values(this.config.env ?? {}), ...Object.values(this.secrets)];
    return values.some((value) => value.toLowerCase().includes(HOST_GATEWAY_NAME));
  }

  private get hasSecrets(): boolean {
    return Object.keys(this.secrets).length > 0;
  }

  /** Raw KEY=value lines for docker --env-file (parsed literally by docker, never by a shell). */
  private secretsBody(): string {
    return Object.entries(this.secrets)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  /** POSIX single-quoted KEY='value' lines, safe to `source` in a shell (no expansion or injection). */
  private secretsShellBody(): string {
    return Object.entries(this.secrets)
      .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
      .join('\n');
  }

  /** In tmpfs mode, source the in-RAM secrets file so values reach the command env without docker-inspect exposure. */
  private wrap(command: string): string {
    if (this.secretsMode !== 'tmpfs' || !this.hasSecrets) return command;
    return `set -a; [ -f ${SECRETS_FILE} ] && . ${SECRETS_FILE}; set +a; ${command}`;
  }

  /** Pure `docker run` argv assembly (no docker invocation), so hardening flags are unit-testable
   * without Docker installed. `image` lets `start` pass the resolved tag (see `resolveSandboxImage`)
   * without mutating the configured one. */
  buildRunArgs(image: string = this.image): string[] {
    const args = ['run', '-d', '--name', this.name, '-w', this.workdir, '--label', `vanguard.runId=${this.id}`, ...ownerLabelArgs()];
    // Map host.docker.internal to the host only for a sandbox that is pointed there (see
    // `hostGateway`): a host egress proxy (`startEgressProxy`), or a provider endpoint on the docker
    // host. Required on Linux (Docker Desktop resolves the name itself); host-gateway needs Docker
    // >= 20.10. The egress enclave and the llm-proxy sidecar are reached by container name instead.
    if (this.needsHostGateway()) args.push('--add-host', `${HOST_GATEWAY_NAME}:host-gateway`);
    if (this.config.network !== undefined) args.push('--network', this.config.network);
    if (this.profile.memoryMb !== undefined) args.push('--memory', `${this.profile.memoryMb}m`);
    if (this.profile.cpus !== undefined) args.push('--cpus', String(this.profile.cpus));
    if (this.profile.pidsLimit !== undefined) args.push('--pids-limit', String(this.profile.pidsLimit));

    // Decided once by the caller (`resolveSandboxProfile`), never re-derived here — see
    // SandboxConfig.profile.
    const { security } = this.profile;
    if (security.init) args.push('--init');
    for (const cap of security.capDrop) args.push('--cap-drop', cap);
    // Added back on top of capDrop ALL: copyIn's `docker exec -u 0 chown -R` needs CAP_CHOWN (and,
    // to retarget files the exec'd root doesn't own, CAP_FOWNER/CAP_DAC_OVERRIDE) — cap-drop fixes
    // the exec bounding set too, so `-u 0` alone does not restore it.
    for (const cap of security.capAdd) args.push('--cap-add', cap);
    if (security.noNewPrivileges) args.push('--security-opt', 'no-new-privileges');
    if (security.readOnlyRootfs) {
      args.push('--read-only');
      // Paths a real run writes: /workspace (copyIn + pnpm install + git), $HOME (skills, tool
      // caches), /tmp (build scratch). exec is required (tool shims, build scripts) unlike the
      // deliberately noexec secrets tmpfs above. The sizes are shares of this sandbox's own memory
      // limit, because that is the cgroup a tmpfs page is charged to — resolved with the rest of the
      // profile (see readOnlyTmpfsSizesMb), not here.
      const { tmpfs, home } = this.profile;
      const mounts = [
        [this.workdir, tmpfs.workspace],
        [home, tmpfs.home],
        ['/tmp', tmpfs.tmp],
      ] as const;
      // A tmpfs mounted over an image directory comes up root:root 0755, not with the directory's own
      // owner: /tmp gets its sticky 1777 back here, /workspace and $HOME are chowned to the run user
      // in start() (its uid is only known once the container runs).
      for (const [path, sizeMb] of mounts) {
        args.push('--tmpfs', `${path}:rw,exec,nosuid,size=${sizeMb}m${path === '/tmp' ? ',mode=1777' : ''}`);
      }
    }

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // In-RAM tmpfs: secrets never land in the image, on disk, or in docker inspect Config.Env.
      args.push('--tmpfs', `${SECRETS_DIR}:rw,noexec,nosuid,mode=1777,size=1m`);
    }
    if (this.envDir !== undefined) args.push('--env-file', join(this.envDir, 'env'));
    for (const [k, v] of Object.entries(this.config.env ?? {})) args.push('-e', `${k}=${v}`);

    if (this.config.pnpmStore !== undefined) {
      const { repoKey, hostDir } = this.config.pnpmStore;
      const mount = hostDir ?? pnpmStoreVolumeName(repoKey);
      args.push('-v', `${mount}:${PNPM_STORE_DIR}`);
      args.push('-e', `npm_config_store_dir=${PNPM_STORE_DIR}`);
    }

    args.push(image, 'sleep', 'infinity');
    return args;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.hasSecrets && this.secretsMode === 'env-file') {
      this.envDir = await mkdtemp(join(tmpdir(), 'vg-env-'));
      await writeFile(join(this.envDir, 'env'), this.secretsBody(), { mode: 0o600 });
    }
    const image = await resolveSandboxImage(this.image);
    const args = this.buildRunArgs(image);

    try {
      await execa('docker', args);
      this.started = true;
    } catch (cause) {
      throw new SandboxError(`Failed to start container ${this.name}`, { cause });
    }

    if (this.profile.security.readOnlyRootfs) {
      const chown = await execa('docker', ['exec', '-u', '0', this.name, 'chown', await this.containerOwner(), this.workdir, this.profile.home], { reject: false });
      if (chown.exitCode !== 0) {
        await this.destroy();
        throw new SandboxError(`Failed to hand the read-only sandbox's tmpfs mounts to the run user: ${chown.stderr}`);
      }
    }

    await this.assertClaudeCliCurrent(image);

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // Write the secrets file via stdin (umask 077) so the value never appears in argv.
      const write = await execa('docker', ['exec', '-i', this.name, 'sh', '-c', `umask 077; cat > ${SECRETS_FILE}`], {
        reject: false,
        input: this.secretsShellBody(),
      });
      if (write.exitCode !== 0) {
        await this.destroy();
        throw new SandboxError(`Failed to write secrets to tmpfs: ${write.stderr}`);
      }
    }
  }

  private async assertClaudeCliCurrent(image: string): Promise<void> {
    if (claudeVersionChecked || process.env['VANGUARD_SKIP_IMAGE_CHECK'] === '1') return;
    claudeVersionChecked = true;
    const probe = await execa('docker', ['exec', this.name, 'claude', '--version'], { reject: false });
    const found = probe.exitCode === 0 ? /(\d+\.\d+\.\d+)/.exec(probe.stdout)?.[1] : undefined;
    if (found === undefined) return; // custom image without the claude CLI — not our business
    if (!isOlderVersion(found, SANDBOX_CLAUDE_VERSION)) return;
    await this.destroy();
    throw new SandboxError(
      `Sandbox image ${image} has claude ${found}, but this repo pins ${SANDBOX_CLAUDE_VERSION}. ` +
        `A stale CLI fails mid-run against a gateway. Fix it with:\n` +
        `  vanguard doctor --fix\n` +
        `or rebuild: CLAUDE_CLI_VERSION=${SANDBOX_CLAUDE_VERSION} ./docker/build.sh. ` +
        `Set VANGUARD_SKIP_IMAGE_CHECK=1 to bypass.`,
    );
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`);
    if (options.input !== undefined) args.push('-i');
    args.push(this.name, 'sh', '-lc', this.wrap(command));
    const result = await execa('docker', args, {
      reject: false,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    });
    return toExecResult(result);
  }

  execStream(command: string, options: ExecOptions = {}): ExecStream {
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(this.name, 'sh', '-lc', this.wrap(command));
    const child = execa('docker', args, {
      reject: false,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    });
    const stdout = (async function* (): AsyncIterable<string> {
      if (child.stdout === undefined || child.stdout === null) return;
      for await (const line of createInterface({ input: child.stdout })) yield line;
    })();
    const result: Promise<ExecResult> = child.then((r) => toExecResult(r));
    return { stdout, result };
  }

  /** uid:gid of the container's run user, so copied files can be chowned to it (memoised). */
  private async containerOwner(): Promise<string> {
    if (this.owner === undefined) {
      const res = await execa('docker', ['exec', this.name, 'sh', '-c', 'printf "%s:%s" "$(id -u)" "$(id -g)"']);
      this.owner = res.stdout.trim();
    }
    return this.owner;
  }

  async copyIn(hostPath: string, sandboxPath: string): Promise<void> {
    try {
      const hostStat = await stat(hostPath);
      const isDir = hostStat.isDirectory();
      await execa('docker', ['exec', this.name, 'mkdir', '-p', isDir ? sandboxPath : dirname(sandboxPath)]);
      // Streamed through `docker exec` rather than `docker cp`: the daemon refuses `docker cp` into a
      // container started with --read-only ("container rootfs is marked read-only") even when the
      // target is a writable tmpfs, which broke every hardened run.
      if (isDir) {
        // buffer: false — piping still buffers the source's stdout, and past execa's 100 MB maxBuffer
        // it kills the source mid-stream (a truncated archive or a hang for any real workspace).
        await execa('tar', ['-C', hostPath, '-cf', '-', '.'], { env: { COPYFILE_DISABLE: '1' }, buffer: false })
          .pipe('docker', ['exec', '-i', '-u', '0', this.name, 'tar', '-xf', '-', '-C', sandboxPath]);
      } else {
        await execa('docker', ['exec', '-i', '-u', '0', this.name, 'sh', '-c', 'cat > "$1"', 'sh', sandboxPath], { inputFile: hostPath });
        // `cat >` creates the file with the default mode; keep the host's (an executable script stays executable).
        const mode = (hostStat.mode & 0o777).toString(8);
        await execa('docker', ['exec', '-u', '0', this.name, 'chmod', mode, sandboxPath]);
      }
      // Extracted as root (tar keeps host uid/gid), so chown to the container user; otherwise the
      // non-root agent cannot edit copied files (only create new ones).
      await execa('docker', ['exec', '-u', '0', this.name, 'chown', '-R', await this.containerOwner(), sandboxPath]);
    } catch (cause) {
      throw new SandboxError(`copyIn failed: ${hostPath} -> ${sandboxPath}`, { cause });
    }
  }

  async copyFileOut(sandboxPath: string, hostPath: string, options: CopyOutOptions = {}): Promise<void> {
    try {
      const isDir = (await execa('docker', ['exec', this.name, 'test', '-d', sandboxPath], { reject: false })).exitCode === 0;
      if (isDir) await mkdir(hostPath, { recursive: true });
      else await mkdir(dirname(hostPath), { recursive: true });
      // Not `docker cp`: it reads the container's rootfs layer, so under --read-only it cannot see
      // the /workspace, $HOME and /tmp tmpfs mounts the run actually wrote to.
      if (isDir) {
        // As root: a path the agent made unreadable (chmod 000) must not fail the copy-back (exit 2).
        // A bare name in --exclude matches at any depth (GNU and busybox tar alike).
        const excludes = (options.exclude ?? []).map((name) => `--exclude=${name}`);
        const source = execa('docker', ['exec', '-u', '0', this.name, 'tar', ...excludes, '-C', sandboxPath, '-cf', '-', '.'], {
          buffer: { stdout: false },
          reject: false,
        });
        // Hard byte cap on the stream itself: the pre-copy `find` runs as the agent and cannot see into
        // what it made unreadable, while this tar runs as root, so only the stream is a reliable limit.
        let streamed = 0;
        let overCap = false;
        if (options.maxBytes !== undefined) {
          const cap = options.maxBytes;
          if (!source.stdout) throw new SandboxError('copy-out has no stdout to enforce maxBytes on');
          source.stdout.on('data', (chunk: Buffer) => {
            streamed += chunk.length;
            if (streamed > cap && !overCap) {
              overCap = true;
              source.kill();
            }
          });
        }
        // A failing extract (e.g. a truncated archive) rejects the pipe. Tar restores modes, so a 000 dir or
        // file would leave the host user unable to read (or later delete) what it extracted — fix that
        // whether or not the copy succeeded, or the caller's cleanup of a partial extract fails too.
        const extracted = await source.pipe('tar', ['-xf', '-', '-C', hostPath]).catch((cause: unknown) => cause);
        await execa('chmod', ['-R', 'u+rwX', hostPath], { reject: false });
        if (overCap) throw new Error(`copy-out passed ${options.maxBytes} bytes; aborted before more reached the host`);
        if (extracted instanceof Error) throw extracted;
        const archived = await source;
        // GNU tar exits 1 for "file changed as we read it" (a process still writing): the archive is
        // complete, so keep it — but only for that reason. Anything else fails closed.
        if (!isBenignTarExit(archived.exitCode ?? -1, archived.stderr)) {
          throw new Error(`tar in sandbox exited ${archived.exitCode}: ${archived.stderr}`);
        }
      } else {
        const res = await execa('docker', ['exec', this.name, 'cat', sandboxPath], { stdout: { file: hostPath }, reject: false });
        // The redirect creates hostPath before cat runs; don't leave an empty file for a missing source.
        if (res.exitCode !== 0) {
          await rm(hostPath, { force: true });
          throw new Error(`cat ${sandboxPath} exited ${res.exitCode}: ${res.stderr}`);
        }
      }
    } catch (cause) {
      throw new SandboxError(`copyFileOut failed: ${sandboxPath} -> ${hostPath}`, { cause });
    }
  }

  async exists(sandboxPath: string): Promise<boolean> {
    const result = await execa('docker', ['exec', this.name, 'test', '-e', sandboxPath], { reject: false });
    return result.exitCode === 0;
  }

  shellCommand(): string {
    return `docker exec -it ${this.name} bash`;
  }

  /** The image ID the container was actually created from — correct whether that image was pulled
   * from GHCR or built locally, and regardless of a mutable tag moving since. Undefined before `start()`. */
  async imageDigest(): Promise<string | undefined> {
    if (!this.started) return undefined;
    const result = await execa('docker', ['inspect', this.name, '--format', '{{.Image}}'], { reject: false });
    const digest = result.stdout.trim();
    return result.exitCode === 0 && digest !== '' ? digest : undefined;
  }

  async destroy(): Promise<void> {
    await execa('docker', ['rm', '-f', this.name], { reject: false });
    this.started = false;
    if (this.envDir !== undefined) {
      await rm(this.envDir, { recursive: true, force: true });
      this.envDir = undefined;
    }
  }
}
