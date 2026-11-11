import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execa, execaSync } from 'execa';
import { chmod, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DockerSandboxProvider,
  toExecResult,
  isOlderVersion,
  refreshSandboxClaudeCli,
  sandboxImage,
  resolveSandboxImage,
  pnpmStoreVolumeName,
  SANDBOX_CLAUDE_VERSION,
} from './docker.js';
import { readOnlyTmpfsSizesMb, sandboxSecurityOpts } from './limits.js';

const ENV_VAR = 'VANGUARD_SANDBOX_IMAGE';

/** Restore the ambient `VANGUARD_SANDBOX_IMAGE` after each test in the calling suite. */
function restoresSandboxImageEnv(): void {
  const prev = process.env[ENV_VAR];
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  });
}

// Ungated on purpose: pure env resolution, no Docker needed. Every sandbox start and sidecar reads
// this — a wrong verdict either strands CI on the mutable `:latest` tag it was meant to pin past, or
// silently drops a deliberate override.
describe('sandboxImage', () => {
  restoresSandboxImageEnv();

  it('honours VANGUARD_SANDBOX_IMAGE when set', () => {
    process.env[ENV_VAR] = 'sha256:deadbeef';
    expect(sandboxImage()).toBe('sha256:deadbeef');
  });

  it('falls back to the mutable tag when the env var is empty', () => {
    process.env[ENV_VAR] = '';
    expect(sandboxImage()).toBe('taskcell-sandbox:latest');
  });

  it('falls back to the mutable tag when the env var is unset', () => {
    delete process.env[ENV_VAR];
    expect(sandboxImage()).toBe('taskcell-sandbox:latest');
  });

  it('rejects a value docker would read as a flag, or one with whitespace', () => {
    for (const value of ['--privileged', '-v/:/host', 'taskcell-sandbox:latest --privileged']) {
      expect(() => sandboxImage({ [ENV_VAR]: value }), value).toThrow(/not an image reference/);
    }
  });

  it('reads from an injected env map rather than process.env when given one', () => {
    expect(sandboxImage({ [ENV_VAR]: 'sha256:cafef00d' })).toBe('sha256:cafef00d');
    expect(sandboxImage({})).toBe('taskcell-sandbox:latest');
  });
});

// Ungated on purpose: pure logic over an injected existence check, no Docker needed. Covers the
// rename fallback — a host that only ever built the pre-rename `vanguard-sandbox:latest` tag must
// keep working until it next runs docker/build.sh.
describe('resolveSandboxImage', () => {
  it('passes an explicit (non-default) image through untouched, without checking existence', async () => {
    const exists = async (): Promise<boolean> => {
      throw new Error('should not be called');
    };
    await expect(resolveSandboxImage('sha256:deadbeef', exists)).resolves.toBe('sha256:deadbeef');
  });

  it('keeps the default tag when it already exists', async () => {
    const exists = async (image: string): Promise<boolean> => image === 'taskcell-sandbox:latest';
    await expect(resolveSandboxImage('taskcell-sandbox:latest', exists)).resolves.toBe('taskcell-sandbox:latest');
  });

  it('falls back to the legacy tag when only it exists', async () => {
    const exists = async (image: string): Promise<boolean> => image === 'vanguard-sandbox:latest';
    await expect(resolveSandboxImage('taskcell-sandbox:latest', exists)).resolves.toBe('vanguard-sandbox:latest');
  });

  it('keeps the default tag when neither exists, so the caller gets the (clearer) new-name error', async () => {
    const exists = async (): Promise<boolean> => false;
    await expect(resolveSandboxImage('taskcell-sandbox:latest', exists)).resolves.toBe('taskcell-sandbox:latest');
  });
});

const hasDocker = ((): boolean => {
  try {
    execaSync('docker', ['version']);
    return true;
  } catch {
    return false;
  }
})();

const suite = hasDocker ? describe : describe.skip;

// Ungated on purpose: the comparison is pure, and it gates every sandbox start — a wrong verdict
// either blocks a healthy image or lets a stale CLI fail deep inside a run (see assertClaudeCliCurrent).
describe('refreshSandboxClaudeCli', () => {
  restoresSandboxImageEnv();

  it('refuses an immutable image ID instead of committing to a stray sha256 repository', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      return { stdout: '' };
    };

    await expect(refreshSandboxClaudeCli({ cwd: '/repo', image: `sha256:${'a'.repeat(64)}`, run })).rejects.toThrow(/immutable/);
    await expect(
      refreshSandboxClaudeCli({ cwd: '/repo', image: `registry.example.com/vanguard-sandbox@sha256:${'b'.repeat(64)}`, run }),
    ).rejects.toThrow(/immutable/);
    expect(calls).toEqual([]);
  });

  it('refuses a short image ID, and still refreshes a hex repository name that is not an ID prefix', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      return { stdout: args.at(-1) === '{{.Id}}' ? `sha256:abc1234${'0'.repeat(57)}` : '' };
    };

    await expect(refreshSandboxClaudeCli({ cwd: '/repo', image: 'abc1234', run })).rejects.toThrow(/immutable/);
    await expect(refreshSandboxClaudeCli({ cwd: '/repo', image: 'sha256:abc1', run })).rejects.toThrow(/immutable/);
    expect(calls.some((args) => args[0] === 'commit')).toBe(false);

    await refreshSandboxClaudeCli({ cwd: '/repo', image: 'cafe', run });
    expect(calls.some((args) => args[0] === 'commit' && args.at(-1) === 'cafe')).toBe(true);
  });

  it('refreshes the tag resolveSandboxImage picks, so a pre-rename host fixes the image it actually has', async () => {
    delete process.env[ENV_VAR];
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === 'image' && args.includes('taskcell-sandbox:latest')) throw new Error('No such image');
      calls.push(args);
      return { stdout: '' };
    };

    await refreshSandboxClaudeCli({ cwd: '/repo', run });
    expect(calls.some((args) => args[0] === 'commit' && args.at(-1) === 'vanguard-sandbox:latest')).toBe(true);
  });
});

describe('isOlderVersion', () => {
  it('orders released CLI versions numerically, not lexically', () => {
    // '2.1.165' > '2.1.260' as strings; the whole check hinges on this not being a string compare.
    expect(isOlderVersion('2.1.165', '2.1.260')).toBe(true);
    expect(isOlderVersion('2.1.260', '2.1.260')).toBe(false);
    expect(isOlderVersion('2.1.261', '2.1.260')).toBe(false);
    expect(isOlderVersion('2.2.0', '2.1.260')).toBe(false);
    expect(isOlderVersion('1.99.99', '2.1.260')).toBe(true);
  });

  it('treats a missing part as zero and an unparseable one as older', () => {
    expect(isOlderVersion('2.1', '2.1.260')).toBe(true);
    expect(isOlderVersion('2.2', '2.1.260')).toBe(false);
    expect(isOlderVersion('nightly', SANDBOX_CLAUDE_VERSION)).toBe(true);
  });
});

// Ungated on purpose: the coercion is pure, and it guards the seam whose broken contract crashed a
// codex review run with a bare `undefined.split` (see toExecResult's comment).
describe('toExecResult', () => {
  it('substitutes empty strings when execa buffered nothing (cancelled or never-spawned subprocess)', () => {
    expect(toExecResult({ stdout: undefined, stderr: undefined, exitCode: undefined })).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 1,
    });
  });

  it('passes real streams through untouched', () => {
    expect(toExecResult({ stdout: 'out', stderr: 'err', exitCode: 3 })).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
    });
  });

  it('keeps a zero exit code (a falsy-check here would report failure on success)', () => {
    expect(toExecResult({ stdout: '', stderr: '', exitCode: 0 }).exitCode).toBe(0);
  });

  it('yields a splittable stdout, which is what the consumer actually relies on', () => {
    expect(() => toExecResult({ stdout: undefined }).stdout.split('\n')).not.toThrow();
  });
});

suite('DockerSandboxProvider', () => {
  const sb = new DockerSandboxProvider({ image: 'alpine:3.20', workdir: '/workspace' });

  afterAll(async () => {
    await sb.destroy();
  }, 60_000);

  it('starts and runs a command', async () => {
    await sb.start();
    const r = await sb.exec('echo hi');
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('returns a non-zero exit code without throwing', async () => {
    const r = await sb.exec('exit 3');
    expect(r.exitCode).toBe(3);
  }, 30_000);

  it('round-trips a directory of files (contents, not nested)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-cp-'));
    await writeFile(join(host, 'a.txt'), 'alpha');
    await sb.copyIn(host, '/workspace/in');
    expect(await sb.exists('/workspace/in/a.txt')).toBe(true);
    const out = await mkdtemp(join(tmpdir(), 'vg-out-'));
    await sb.copyFileOut('/workspace/in', out);
    expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('alpha');
    await rm(host, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }, 60_000);

  it('round-trips a directory larger than execa\'s 100 MB default buffer intact', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-big-'));
    const out = await mkdtemp(join(tmpdir(), 'vg-big-out-'));
    try {
      await writeFile(join(host, 'big.bin'), Buffer.alloc(110 * 1024 * 1024, 7));
      await sb.copyIn(host, '/workspace/big');
      await sb.copyFileOut('/workspace/big', out);
      expect((await stat(join(out, 'big.bin'))).size).toBe(110 * 1024 * 1024);
    } finally {
      await sb.exec('rm -rf /workspace/big');
      await rm(host, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);

  it('makes copied-in files editable by the sandbox user (chown)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-edit-'));
    await writeFile(join(host, 'f.txt'), 'one');
    await sb.copyIn(host, '/workspace/edit');
    const r = await sb.exec('echo two >> /workspace/edit/f.txt && cat /workspace/edit/f.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('two');
    await rm(host, { recursive: true, force: true });
  }, 60_000);

  it('copies a directory and a single file into a read-only-rootfs sandbox (docker cp is refused there)', async () => {
    const ro = new DockerSandboxProvider({ image: 'alpine:3.20', workdir: '/workspace', security: { ...sandboxSecurityOpts({}), readOnlyRootfs: true } });
    const host = await mkdtemp(join(tmpdir(), 'vg-ro-'));
    try {
      await ro.start();
      await writeFile(join(host, 'a.txt'), 'alpha');
      await ro.copyIn(host, '/workspace/in');
      await ro.copyIn(join(host, 'a.txt'), '/workspace/renamed.txt');
      const r = await ro.exec('echo more >> /workspace/in/a.txt && cat /workspace/in/a.txt /workspace/renamed.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('alphamore\nalpha');
      await ro.copyFileOut('/workspace/in', join(host, 'out'));
      expect(await readFile(join(host, 'out', 'a.txt'), 'utf8')).toBe('alphamore\n');
      await ro.copyFileOut('/workspace/renamed.txt', join(host, 'single.txt'));
      expect(await readFile(join(host, 'single.txt'), 'utf8')).toBe('alpha');
      await expect(ro.copyFileOut('/workspace/missing.txt', join(host, 'missing.txt'))).rejects.toThrow(/copyFileOut failed/);
      await expect(readFile(join(host, 'missing.txt'))).rejects.toThrow();
    } finally {
      await ro.destroy();
      await rm(host, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps a single copied-in file\'s mode (an executable script stays executable)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-mode-'));
    try {
      await writeFile(join(host, 'run.sh'), '#!/bin/sh\necho ran\n');
      await chmod(join(host, 'run.sh'), 0o750);
      await sb.copyIn(join(host, 'run.sh'), '/workspace/mode/run.sh');
      const r = await sb.exec('stat -c %a /workspace/mode/run.sh && /workspace/mode/run.sh');
      expect(r.stdout).toBe('750\nran');
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  }, 60_000);

  it('copies out a file that is still being appended to', async () => {
    const out = await mkdtemp(join(tmpdir(), 'vg-grow-'));
    try {
      await sb.exec('mkdir -p /workspace/grow && echo start > /workspace/grow/log && echo kept > /workspace/grow/other');
      await sb.exec('nohup sh -c "while :; do echo line >> /workspace/grow/log; done" >/dev/null 2>&1 &');
      await sb.copyFileOut('/workspace/grow', out);
      expect(await readFile(join(out, 'other'), 'utf8')).toBe('kept\n');
      expect(await readFile(join(out, 'log'), 'utf8')).toMatch(/^start\n/);
    } finally {
      await sb.exec('pkill -f "echo line" ; rm -rf /workspace/grow');
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('skips excluded names at any depth only when asked', async () => {
    const out = await mkdtemp(join(tmpdir(), 'vg-excl-'));
    try {
      await sb.exec('mkdir -p /workspace/ex/node_modules/a /workspace/ex/pkg/node_modules/b /workspace/ex/.pnpm-store && touch /workspace/ex/keep /workspace/ex/node_modules/a/f /workspace/ex/pkg/node_modules/b/f /workspace/ex/.pnpm-store/f');
      await sb.copyFileOut('/workspace/ex', join(out, 'skip'), { exclude: ['node_modules', '.pnpm-store'] });
      expect(await stat(join(out, 'skip', 'keep'))).toBeTruthy();
      for (const gone of ['node_modules', join('pkg', 'node_modules'), '.pnpm-store']) {
        await expect(stat(join(out, 'skip', gone)), gone).rejects.toThrow();
      }
      await sb.copyFileOut('/workspace/ex', join(out, 'all'));
      expect(await stat(join(out, 'all', 'pkg', 'node_modules', 'b', 'f'))).toBeTruthy();
    } finally {
      await sb.exec('rm -rf /workspace/ex');
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed when the host-side extract fails', async () => {
    const out = await mkdtemp(join(tmpdir(), 'vg-ro-out-'));
    try {
      await sb.exec('mkdir -p /workspace/fx && echo a > /workspace/fx/a');
      await chmod(out, 0o555);
      await expect(sb.copyFileOut('/workspace/fx', out)).rejects.toThrow(/copyFileOut failed/);
    } finally {
      await chmod(out, 0o755);
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('aborts copy-out once the stream passes maxBytes, even for data the agent made unreadable', async () => {
    const out = await mkdtemp(join(tmpdir(), 'vg-cap-'));
    try {
      await sb.exec('mkdir -p /workspace/cap/hidden && head -c 8388608 /dev/zero > /workspace/cap/hidden/big && chmod 000 /workspace/cap/hidden');
      await expect(sb.copyFileOut('/workspace/cap', out, { maxBytes: 1024 * 1024 })).rejects.toThrow(/copyFileOut failed/);
      await expect(sb.copyFileOut('/workspace/cap', out, { maxBytes: 1024 * 1024 })).rejects.toHaveProperty('cause.message', expect.stringMatching(/passed 1048576 bytes/));
    } finally {
      await sb.exec('chmod -R 755 /workspace/cap; rm -rf /workspace/cap');
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed when the source dies mid-stream (truncated archive)', async () => {
    const doomed = new DockerSandboxProvider({ image: 'alpine:3.20', workdir: '/workspace' });
    const out = await mkdtemp(join(tmpdir(), 'vg-trunc-'));
    try {
      await doomed.start();
      await doomed.exec('mkdir -p /workspace/t && head -c 209715200 /dev/zero > /workspace/t/big');
      const copy = doomed.copyFileOut('/workspace/t', out);
      await execa('docker', ['kill', `vg-${doomed.id}`], { reject: false });
      await expect(copy).rejects.toThrow(/copyFileOut failed/);
    } finally {
      await doomed.destroy();
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('copies out paths the non-root agent made unreadable (chmod 000)', async () => {
    const dockerfile = 'FROM alpine:3.20\nRUN adduser -D -h /home/agent -u 10001 agent && mkdir -p /workspace && chown agent /workspace\nUSER agent\n';
    await execa('docker', ['build', '-q', '-t', 'vg-ro-user-test', '-'], { input: dockerfile });
    const ro = new DockerSandboxProvider({ image: 'vg-ro-user-test', workdir: '/workspace', security: { ...sandboxSecurityOpts({}), readOnlyRootfs: true } });
    const out = await mkdtemp(join(tmpdir(), 'vg-000-'));
    try {
      await ro.start();
      const r = await ro.exec('mkdir -p /workspace/locked && echo s > /workspace/locked/secret && echo h > /workspace/hidden && echo ok > /workspace/fine && chmod 000 /workspace/locked /workspace/hidden');
      expect(r.exitCode, r.stderr).toBe(0);
      await ro.copyFileOut('/workspace', out);
      expect(await readFile(join(out, 'fine'), 'utf8')).toBe('ok\n');
      expect(await readFile(join(out, 'hidden'), 'utf8')).toBe('h\n');
      expect(await readFile(join(out, 'locked', 'secret'), 'utf8')).toBe('s\n');
    } finally {
      await ro.destroy();
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);

  it('lets a non-root run user write $HOME, /workspace and /tmp under a read-only rootfs', async () => {
    // Like the real image: a non-root USER whose $HOME exists in the image (a tmpfs over it comes up root:root 0755).
    const dockerfile = 'FROM alpine:3.20\nRUN adduser -D -h /home/agent -u 10001 agent && mkdir -p /workspace && chown agent /workspace\nUSER agent\n';
    await execa('docker', ['build', '-q', '-t', 'vg-ro-user-test', '-'], { input: dockerfile });
    const ro = new DockerSandboxProvider({ image: 'vg-ro-user-test', workdir: '/workspace', security: { ...sandboxSecurityOpts({}), readOnlyRootfs: true } });
    try {
      await ro.start();
      const r = await ro.exec('mkdir -p /home/agent/.claude/skills && touch /workspace/f /tmp/f && id -u');
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('10001');
    } finally {
      await ro.destroy();
    }
  }, 180_000);

  it('exposes secrets to commands but keeps them out of docker inspect (tmpfs default)', async () => {
    const sec = new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { VG_SECRET: 'topsecret' } });
    try {
      await sec.start();
      const r = await sec.exec('echo $VG_SECRET');
      expect(r.stdout.trim()).toBe('topsecret');
      const inspect = await execa('docker', ['inspect', `vg-${sec.id}`, '--format', '{{json .Config.Env}}'], {
        reject: false,
      });
      expect(inspect.stdout).not.toContain('topsecret');
    } finally {
      await sec.destroy();
    }
  }, 120_000);

  it('keeps shell metacharacters in secret values literal (no injection)', async () => {
    const tricky = "a'b$(echo pwned);c`d`";
    const sec = new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { VG_TRICKY: tricky } });
    try {
      await sec.start();
      const r = await sec.exec('printf %s "$VG_TRICKY"');
      expect(r.stdout).toBe(tricky);
    } finally {
      await sec.destroy();
    }
  }, 120_000);
});

// Runs without Docker: exercises the pure argv builder directly.
describe('DockerSandboxProvider buildRunArgs (hardening flags)', () => {
  it('drops all capabilities and blocks privilege escalation by default', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--security-opt');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('maps host.docker.internal only for a sandbox pointed at the docker host', () => {
    const alias = 'host.docker.internal:host-gateway';
    // Default runs, and the egress enclave / llm-proxy (reached by container name), need no alias.
    expect(new DockerSandboxProvider({}).buildRunArgs()).not.toContain(alias);
    expect(
      new DockerSandboxProvider({
        network: 'vg-egr-1',
        env: { HTTPS_PROXY: 'http://vg-proxy-1:8080', ANTHROPIC_BASE_URL: 'http://vg-llm-1:8080' },
      }).buildRunArgs(),
    ).not.toContain(alias);

    // A host egress proxy (startEgressProxy) or a provider endpoint on the docker host does.
    const viaEnv = new DockerSandboxProvider({ env: { HTTPS_PROXY: 'http://host.docker.internal:3128' } }).buildRunArgs();
    expect(viaEnv[viaEnv.indexOf(alias) - 1]).toBe('--add-host');
    expect(
      new DockerSandboxProvider({ secrets: { ANTHROPIC_BASE_URL: 'http://Host.Docker.Internal:3000' } }).buildRunArgs(),
    ).toContain(alias);

    // An explicit setting wins either way.
    expect(new DockerSandboxProvider({ hostGateway: true }).buildRunArgs()).toContain(alias);
    expect(
      new DockerSandboxProvider({ hostGateway: false, env: { HTTPS_PROXY: 'http://host.docker.internal:3128' } }).buildRunArgs(),
    ).not.toContain(alias);
  });

  it('adds back the chown trio needed by copyIn, after the drop', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    const dropIdx = args.indexOf('--cap-drop');
    for (const cap of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']) {
      const capIdx = args.indexOf(cap);
      expect(capIdx).toBeGreaterThan(-1);
      expect(args[capIdx - 1]).toBe('--cap-add');
      expect(capIdx).toBeGreaterThan(dropIdx);
    }
  });

  it('coexists with resource limits, network, secrets tmpfs, and the terminal image/command', () => {
    const sb = new DockerSandboxProvider({
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 128,
      network: 'vg-net',
      secrets: { FOO: 'bar' },
      security: sandboxSecurityOpts({}),
    });
    const args = sb.buildRunArgs();
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--network');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('--security-opt');
    expect(args.filter((a) => a === '--tmpfs').length).toBeGreaterThanOrEqual(1);
    expect(args.slice(-3)).toEqual(['taskcell-sandbox:latest', 'sleep', 'infinity']);
  });

  it('defaults to VANGUARD_SANDBOX_IMAGE over the mutable tag when no explicit image is given', () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'sha256:deadbeef';
    try {
      const sb = new DockerSandboxProvider({});
      expect(sb.buildRunArgs().slice(-3)).toEqual(['sha256:deadbeef', 'sleep', 'infinity']);
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it('an explicit config.image still wins over VANGUARD_SANDBOX_IMAGE', () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'sha256:deadbeef';
    try {
      const sb = new DockerSandboxProvider({ image: 'alpine:3.20' });
      expect(sb.buildRunArgs().slice(-3)).toEqual(['alpine:3.20', 'sleep', 'infinity']);
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it('config.security override disables hardening', () => {
    const sb = new DockerSandboxProvider({
      security: { capDrop: [], capAdd: [], noNewPrivileges: false, readOnlyRootfs: false },
    });
    const args = sb.buildRunArgs();
    expect(args).not.toContain('--cap-drop');
    expect(args).not.toContain('--cap-add');
    expect(args).not.toContain('--security-opt');
    expect(args).not.toContain('--read-only');
  });

  it('config.security override can customize the added-back caps', () => {
    const sb = new DockerSandboxProvider({ security: { capAdd: ['NET_BIND_SERVICE'] } });
    const args = sb.buildRunArgs();
    expect(args).toContain('NET_BIND_SERVICE');
    expect(args).not.toContain('CHOWN');
  });

  it('stretch: readOnlyRootfs adds --read-only and writable tmpfs for workspace/$HOME/tmp', () => {
    const sb = new DockerSandboxProvider({ security: { ...sandboxSecurityOpts({}), readOnlyRootfs: true } });
    const args = sb.buildRunArgs();
    expect(args).toContain('--read-only');
    const tmpfsArgs = args.filter((_, i) => args[i - 1] === '--tmpfs');
    expect(tmpfsArgs.some((a) => a.startsWith('/workspace:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/home/agent:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/tmp:'))).toBe(true);
  });

  it('stretch: readOnlyRootfs is off by default', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    expect(args).not.toContain('--read-only');
  });

  it('hardened mode (--llm-proxy/--egress) defaults readOnlyRootfs on: --read-only plus the three tmpfs mounts', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}, true) });
    const args = sb.buildRunArgs();
    expect(args).toContain('--read-only');
    const tmpfsArgs = args.filter((_, i) => args[i - 1] === '--tmpfs');
    expect(tmpfsArgs.some((a) => a.startsWith('/workspace:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/home/agent:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/tmp:'))).toBe(true);
  });

  // The sizes themselves (and that they stay inside --memory) are limits.test.ts's; here: each mount
  // gets its own share, so a raised/omitted VANGUARD_SANDBOX_MEMORY_MB reaches the argv.
  it.each([2048, 1536, undefined])('sizes the tmpfs mounts from the resolved memoryMb (%s)', (memoryMb) => {
    const args = new DockerSandboxProvider({
      security: sandboxSecurityOpts({}, true),
      ...(memoryMb !== undefined ? { memoryMb } : {}),
    }).buildRunArgs();
    const { workspace, home, tmp } = readOnlyTmpfsSizesMb(memoryMb);
    expect(args.filter((_, i) => args[i - 1] === '--tmpfs')).toEqual(
      expect.arrayContaining([
        `/workspace:rw,exec,nosuid,size=${workspace}m`,
        `/home/agent:rw,exec,nosuid,size=${home}m`,
        `/tmp:rw,exec,nosuid,size=${tmp}m,mode=1777`,
      ]),
    );
  });

  it('an explicit VANGUARD_SANDBOX_READONLY=0 still turns readOnlyRootfs off in hardened mode', () => {
    const sb = new DockerSandboxProvider({
      security: sandboxSecurityOpts({ VANGUARD_SANDBOX_READONLY: '0' } as NodeJS.ProcessEnv, true),
    });
    expect(sb.buildRunArgs()).not.toContain('--read-only');
  });

  it('an explicit VANGUARD_SANDBOX_READONLY=1 still turns readOnlyRootfs on outside hardened mode', () => {
    const sb = new DockerSandboxProvider({
      security: sandboxSecurityOpts({ VANGUARD_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv, false),
    });
    expect(sb.buildRunArgs()).toContain('--read-only');
  });

  it('without --llm-proxy/--egress (hardened=false), args are unchanged from the non-hardened default', () => {
    // Strip the per-instance id (container name + runId label) so the two argv lists compare equal.
    const stable = (args: string[]): string[] => args.filter((a) => !a.startsWith('vg-') && !a.startsWith('vanguard.runId='));
    const plain = stable(new DockerSandboxProvider({ security: sandboxSecurityOpts({}) }).buildRunArgs());
    const explicitlyNotHardened = stable(new DockerSandboxProvider({ security: sandboxSecurityOpts({}, false) }).buildRunArgs());
    expect(explicitlyNotHardened).toEqual(plain);
    expect(plain).not.toContain('--read-only');
  });

  it('has no vanguard.owner label by default', () => {
    const sb = new DockerSandboxProvider({});
    expect(sb.buildRunArgs()).not.toContain('vanguard.owner=');
  });

  it('adds the vanguard.owner label when VANGUARD_OWNER_LABEL is set', () => {
    const prev = process.env.VANGUARD_OWNER_LABEL;
    process.env.VANGUARD_OWNER_LABEL = 'ci-job-42';
    try {
      const sb = new DockerSandboxProvider({});
      const args = sb.buildRunArgs();
      expect(args).toContain('vanguard.owner=ci-job-42');
    } finally {
      if (prev === undefined) delete process.env.VANGUARD_OWNER_LABEL;
      else process.env.VANGUARD_OWNER_LABEL = prev;
    }
  });
});

// Runs without Docker: the opt-in persistent pnpm store is pure argv (see SandboxConfig.pnpmStore).
describe('DockerSandboxProvider buildRunArgs (pnpm store)', () => {
  it('is off by default: no mount, no store-dir env', () => {
    const args = new DockerSandboxProvider({}).buildRunArgs();
    expect(args).not.toContain('-v');
    expect(args.some((a) => a.includes('/pnpm-store'))).toBe(false);
    expect(args.some((a) => a.startsWith('npm_config_store_dir='))).toBe(false);
  });

  it('mounts the per-repo named volume at /pnpm-store and points pnpm at it', () => {
    const args = new DockerSandboxProvider({ pnpmStore: { repoKey: 'octo/repo' } }).buildRunArgs();
    const vol = pnpmStoreVolumeName('octo/repo');
    expect(vol).toMatch(/^taskcell-pnpm-store-[a-f0-9]{16}$/);
    expect(args[args.indexOf('-v') + 1]).toBe(`${vol}:/pnpm-store`);
    const envIdx = args.indexOf('npm_config_store_dir=/pnpm-store');
    expect(envIdx).toBeGreaterThan(-1);
    expect(args[envIdx - 1]).toBe('-e');
    expect(args.slice(-3)).toEqual(['taskcell-sandbox:latest', 'sleep', 'infinity']);
  });

  it('gives two different repos two different stores', () => {
    const mountOf = (repoKey: string): string => {
      const args = new DockerSandboxProvider({ pnpmStore: { repoKey } }).buildRunArgs();
      return args[args.indexOf('-v') + 1]!;
    };
    expect(mountOf('octo/alpha')).not.toBe(mountOf('octo/beta'));
    expect(mountOf('octo/alpha')).toBe(mountOf('octo/alpha'));
  });

  it('bind-mounts a host directory instead of a volume when hostDir is set (the CI shape)', () => {
    const args = new DockerSandboxProvider({ pnpmStore: { repoKey: 'octo/repo', hostDir: '/tmp/pnpm-store' } }).buildRunArgs();
    expect(args[args.indexOf('-v') + 1]).toBe('/tmp/pnpm-store:/pnpm-store');
    expect(args.some((a) => a.startsWith('taskcell-pnpm-store-'))).toBe(false);
    expect(args).toContain('npm_config_store_dir=/pnpm-store');
  });

  it('still mounts /pnpm-store (its own -v mount, unaffected by --read-only) under a hardened readOnlyRootfs', () => {
    const args = new DockerSandboxProvider({
      security: sandboxSecurityOpts({}, true),
      pnpmStore: { repoKey: 'octo/repo' },
    }).buildRunArgs();
    expect(args).toContain('--read-only');
    const vol = pnpmStoreVolumeName('octo/repo');
    expect(args[args.indexOf('-v') + 1]).toBe(`${vol}:/pnpm-store`);
    expect(args).toContain('npm_config_store_dir=/pnpm-store');
  });
});

// Runs without Docker: the validation throws in the constructor, before any docker invocation.
describe('DockerSandboxProvider secret validation', () => {
  it('rejects a secret value containing a newline', () => {
    expect(() => new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { BAD: 'a\nb' } })).toThrow(/newline/);
  });

  it('rejects an invalid secret name', () => {
    expect(() => new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { 'bad name': 'x' } })).toThrow(
      /Invalid secret name/,
    );
  });

  it('builds an interactive shell command', () => {
    const sb = new DockerSandboxProvider({ image: 'alpine:3.20' });
    expect(sb.shellCommand()).toMatch(/^docker exec -it vg-.* bash$/);
  });
});

describe('toExecResult on a real execa 10 result (reject: false)', () => {
  it('normalises a failed subprocess result exactly as it did under execa 9', async () => {
    const raw = await execa('node', ['-e', 'process.stderr.write("boom"); process.exit(7)'], { reject: false });
    expect(toExecResult(raw)).toEqual({ stdout: '', stderr: 'boom', exitCode: 7 });
  });
});
